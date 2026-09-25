const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { PollBudgetError } = require('../../dist/nodes/shared/transport/request.js');
const {
	fingerprintConfig,
	pollSentinelOne,
} = require('../../dist/nodes/SentinelOnePlatformTrigger/SentinelOneTriggerHelpers.js');

const NOW = Date.parse('2026-09-01T01:00:00.000Z');
const iso = (time) => new Date(time).toISOString();

function config(overrides = {}) {
	return {
		baseUrl: 'https://tenant.example',
		credentialIdentity: { type: 'sentinelOnePlatformApi', id: 'credential-1' },
		scopeType: 'ACCOUNT',
		scopeIds: ['account-1'],
		allVisibleAccounts: false,
		events: ['alert.new'],
		severities: [],
		statuses: [],
		alertName: '',
		simplifyOutput: true,
		debug: false,
		overlapSeconds: 300,
		concurrentRequests: 1,
		requestTimeoutMs: 30_000,
		alertPageSize: 200,
		maxAlertPages: 25,
		pollDeadlineMs: NOW + 36_000,
		...overrides,
	};
}

function stateFor(triggerConfig) {
	return {
		configFingerprint: fingerprintConfig(triggerConfig),
		initialized: true,
		activationMs: NOW - 3_600_000,
		checkpointMs: NOW - 600_000,
		seenAlertIds: [],
		seenAlertVersions: [],
	};
}

function alert(id, createdAt, accountId = 'account-1', updatedAt = createdAt) {
	return {
		id,
		name: `Alert ${id}`,
		severity: 'HIGH',
		status: 'NEW',
		createdAt: iso(createdAt),
		updatedAt: iso(updatedAt),
		realTime: { scope: { account: { id: accountId, name: accountId } } },
	};
}

function fakeServer(alerts, { onRequest } = {}) {
	const requests = [];
	const request = async (options) => {
		requests.push(options);
		const variables = options.body.variables;
		const field = variables.sortBy;
		const range = variables.filters.find((filter) => filter.dateTimeRange).dateTimeRange;
		const excluded = new Set(
			variables.filters.find((filter) => filter.fieldId === 'id' && filter.isNegated)?.stringIn
				.values ?? [],
		);
		const scope = new Set(variables.scope.scopeIds);
		const direction = variables.sortOrder === 'ASC' ? 1 : -1;
		const rows = alerts
			.filter(
				(row) =>
					scope.has(row.realTime.scope.account.id) &&
					Date.parse(row[field]) >= range.start &&
					Date.parse(row[field]) <= range.end &&
					!excluded.has(row.id),
			)
			.sort(
				(left, right) =>
					direction * (Date.parse(left[field]) - Date.parse(right[field])) ||
					left.id.localeCompare(right.id),
			);
		const offset = variables.after ? Number(variables.after) : 0;
		const next = offset + variables.first;
		const response = {
			data: {
				alerts: {
					edges: rows.slice(offset, next).map((node) => ({ node: structuredClone(node) })),
					pageInfo: {
						hasNextPage: next < rows.length,
						endCursor: next < rows.length ? String(next) : null,
					},
				},
			},
		};
		await onRequest?.(options, response);
		return response;
	};
	return { request, requests };
}

async function seededState(triggerConfig) {
	const seeded = await pollSentinelOne(
		fakeServer([]).request,
		triggerConfig,
		stateFor(triggerConfig),
		'scheduled',
		NOW - 120_000,
	);
	return seeded.nextState;
}

test('Budgeted New overlap exclusions stay below 200 KB and warn when truncated', async () => {
	const warnings = [];
	const triggerConfig = config({
		alertPageSize: 6_000,
		warnLog: (message, details) => warnings.push({ message, details }),
	});
	const seeded = await seededState(triggerConfig);
	const cursorKey = Object.keys(seeded.alertCursors).find((key) => key.startsWith('createdAt:'));
	const rows = Array.from({ length: 6_000 }, (_, index) =>
		alert(`seen-${String(index).padStart(40, '0')}`, NOW - 90_000 + index),
	);
	const state = {
		...seeded,
		alertCursors: { ...seeded.alertCursors, [cursorKey]: { throughMs: NOW - 120_000, ids: [] } },
		seenAlertIds: rows.map((row) => `${row.id}\u0000${row.createdAt}\u0000account-1`),
	};
	const source = fakeServer(rows);
	const result = await pollSentinelOne(source.request, triggerConfig, state, 'scheduled', NOW);
	const exclusions = source.requests[0].body.variables.filters.find(
		(filter) => filter.fieldId === 'id',
	).stringIn.values;

	assert.deepEqual(result.items, []);
	assert.ok(exclusions.length > 1_000 && exclusions.length < rows.length);
	assert.deepEqual(
		exclusions,
		rows.slice(0, exclusions.length).map((row) => row.id),
	);
	assert.ok(Buffer.byteLength(JSON.stringify(exclusions)) <= 200_000);
	assert.ok(
		warnings.some(
			({ message, details }) =>
				/truncated/i.test(message) && details.exclusionByteLimit === 200_000,
		),
	);
});

test('An interrupted New overlap keeps its lower edge until a complete scan catches late alerts behind resumeMs', async () => {
	const triggerConfig = config({ alertPageSize: 1 });
	const seeded = await seededState(triggerConfig);
	const cursorKey = Object.keys(seeded.alertCursors).find((key) => key.startsWith('createdAt:'));
	const overlapStart = NOW - 330_000;
	const seenRows = Array.from({ length: 1_500 }, (_, index) =>
		alert(`seen-${index}`, NOW - 240_000 + index),
	);
	const late = alert('late-behind-resume', NOW - 90_000);
	const tail = alert('tail', NOW - 80_000);
	const state = {
		...seeded,
		alertCursors: {
			...seeded.alertCursors,
			[cursorKey]: {
				throughMs: NOW - 30_000,
				ids: [],
				resumeMs: NOW - 60_000,
				resumeIds: [],
				resumeOverlapStartMs: overlapStart,
			},
		},
		seenAlertIds: seenRows.map((row) => `${row.id}\u0000${row.createdAt}\u0000account-1`),
	};
	let calls = 0;
	const first = await pollSentinelOne(
		async (options) => {
			if (++calls > 1) throw new PollBudgetError();
			return fakeServer([...seenRows, late, tail]).request(options);
		},
		triggerConfig,
		state,
		'scheduled',
		NOW,
	);
	assert.deepEqual(
		first.items.map((item) => item.alertId),
		[late.id],
	);
	assert.equal(first.nextState.alertCursors[cursorKey].resumeOverlapStartMs, overlapStart);

	const later = alert('later-behind-resume', NOW - 100_000);
	const replay = fakeServer([...seenRows, late, tail, later]);
	const second = await pollSentinelOne(
		replay.request,
		triggerConfig,
		first.nextState,
		'scheduled',
		NOW + 60_000,
	);
	assert.deepEqual(
		second.items.map((item) => item.alertId),
		[later.id, tail.id],
	);
	assert.equal(
		replay.requests[0].body.variables.filters.find((filter) => filter.dateTimeRange).dateTimeRange
			.start,
		overlapStart,
	);
	assert.equal(second.nextState.alertCursors[cursorKey].resumeOverlapStartMs, undefined);
});

test('Updated paging uses its timestamp keyset when rows move while a read is in flight', async () => {
	const triggerConfig = config({ events: ['alert.updated'], alertPageSize: 1 });
	const seeded = await seededState(triggerConfig);
	const createdAt = NOW - 100_000;
	const firstUpdatedAt = NOW - 50_000;
	const rows = [
		alert('moving', createdAt, 'account-1', firstUpdatedAt),
		alert('second', createdAt, 'account-1', firstUpdatedAt + 1_000),
		alert('third', createdAt, 'account-1', firstUpdatedAt + 2_000),
		alert('fourth', createdAt, 'account-1', firstUpdatedAt + 3_000),
	];
	let calls = 0;
	const source = fakeServer(rows, {
		onRequest: async (options) => {
			if (++calls === 1) rows[0].updatedAt = iso(firstUpdatedAt + 10_000);
			assert.equal(options.body.variables.after, null);
		},
	});
	const result = await pollSentinelOne(source.request, triggerConfig, seeded, 'scheduled', NOW);
	assert.deepEqual(
		result.items.map((item) => [item.alertId, item.updatedAt]),
		[
			['second', iso(firstUpdatedAt + 1_000)],
			['third', iso(firstUpdatedAt + 2_000)],
			['fourth', iso(firstUpdatedAt + 3_000)],
			['moving', iso(firstUpdatedAt + 10_000)],
		],
	);
	assert.ok(
		source.requests.some(
			(request) => request.body.variables.filters[0].dateTimeRange.start > NOW - 420_000,
		),
	);
});

test('Updated keyset drains a tie group across pages without Relay offsets', async () => {
	const triggerConfig = config({ events: ['alert.updated'], alertPageSize: 1 });
	const seeded = await seededState(triggerConfig);
	const createdAt = NOW - 360_000;
	const updatedAt = NOW - 50_000;
	const rows = ['tie-a', 'tie-b', 'tie-c', 'tie-d'].map((id) =>
		alert(id, createdAt, 'account-1', updatedAt),
	);
	const source = fakeServer(rows);
	const result = await pollSentinelOne(source.request, triggerConfig, seeded, 'scheduled', NOW);

	assert.deepEqual(
		result.items.map((item) => item.alertId),
		['tie-a', 'tie-b', 'tie-c', 'tie-d'],
	);
	assert.ok(source.requests.length > rows.length);
	assert.ok(source.requests.every((request) => request.body.variables.after === null));
});

test('An Updated change that moves beyond this poll is delivered on the next poll', async () => {
	const triggerConfig = config({ events: ['alert.updated'], alertPageSize: 1 });
	const seeded = await seededState(triggerConfig);
	const createdAt = NOW - 300_000;
	const oldUpdatedAt = NOW - 50_000;
	const nextUpdatedAt = NOW + 30_000;
	const rows = [alert('moving-past-end', createdAt, 'account-1', oldUpdatedAt)];
	const state = {
		...seeded,
		seenAlertIds: [`moving-past-end\u0000${iso(createdAt)}\u0000account-1`],
		seenAlertVersions: [`moving-past-end\u0000${iso(NOW - 60_000)}`],
	};
	let changed = false;
	const firstSource = fakeServer(rows, {
		onRequest: async () => {
			if (!changed) {
				rows[0].updatedAt = iso(nextUpdatedAt);
				changed = true;
			}
		},
	});
	const first = await pollSentinelOne(firstSource.request, triggerConfig, state, 'scheduled', NOW);
	assert.deepEqual(
		first.items.map((item) => [item.alertId, item.updatedAt]),
		[['moving-past-end', iso(oldUpdatedAt)]],
	);

	const second = await pollSentinelOne(
		fakeServer(rows).request,
		triggerConfig,
		first.nextState,
		'scheduled',
		NOW + 60_000,
	);
	assert.deepEqual(
		second.items.map((item) => [item.alertId, item.updatedAt]),
		[['moving-past-end', iso(nextUpdatedAt)]],
	);
});

test('No-budget New and Updated output bytes match the 97fb944 fixture', async () => {
	const legacyNow = Date.parse('2026-08-26T12:00:00.000Z');
	const triggerConfig = config({
		events: ['alert.new', 'alert.updated'],
		alertPageSize: 1,
		pollDeadlineMs: undefined,
	});
	const rows = [
		alert('A', legacyNow - 10 * 3_600_000, 'account-1', legacyNow - 240_000),
		alert('B', legacyNow - 10 * 3_600_000, 'account-1', legacyNow - 239_000),
		alert('C', legacyNow - 120_000, 'account-1', legacyNow - 110_000),
		alert('D', legacyNow - 100_000, 'account-1', legacyNow - 90_000),
	];
	const oldVersion = iso(legacyNow - 3_000_000);
	const priorAlerts = rows.filter((row) => row.id === 'A' || row.id === 'B');
	const state = {
		configFingerprint: fingerprintConfig(triggerConfig),
		initialized: true,
		activationMs: legacyNow - 7 * 3_600_000,
		checkpointMs: legacyNow - 3 * 3_600_000,
		seenAlertIds: priorAlerts.map((row) => `${row.id}\u0000${row.createdAt}\u0000account-1`),
		seenAlertVersions: priorAlerts.map((row) => `${row.id}\u0000${oldVersion}`),
	};
	const result = await pollSentinelOne(
		fakeServer(rows).request,
		triggerConfig,
		state,
		'scheduled',
		legacyNow,
	);
	const outputBytes = JSON.stringify(result.items);
	// This digest is the compact item JSON emitted by the 97fb944 build for this fixture.
	assert.equal(
		crypto.createHash('sha256').update(outputBytes).digest('hex'),
		'b93487084f18efbd9008a5cdc052b7fa79f065d881db6749d1447f52e3e975ff',
	);
});

test('An empty sibling read at the same cursor does not reset a stalled Updated stream', async () => {
	const warnings = [];
	const triggerConfig = config({
		events: ['alert.new', 'alert.updated'],
		warnLog: (message, details) => warnings.push({ message, details }),
	});
	const seeded = await seededState(triggerConfig);
	const cursors = structuredClone(seeded.alertCursors);
	const createdKey = Object.keys(cursors).find((key) => key.startsWith('createdAt:'));
	const updatedKey = Object.keys(cursors).find((key) => key.startsWith('updatedAt:'));
	cursors[createdKey] = { throughMs: NOW, ids: [] };
	cursors[updatedKey] = { throughMs: NOW - 30_000, ids: [], resumeMs: NOW - 30_000, resumeIds: [] };
	const state = { ...seeded, alertCursors: cursors, stalledAlertPolls: { [updatedKey]: 2 } };
	const result = await pollSentinelOne(
		async (options) => {
			if (options.body.variables.sortBy === 'updatedAt') throw new PollBudgetError();
			return fakeServer([]).request(options);
		},
		triggerConfig,
		state,
		'scheduled',
		NOW,
	);

	assert.deepEqual(result.items, []);
	assert.equal(result.nextState.stalledAlertPolls[updatedKey], 3);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0].message, /updatedAt stream/);
});

test('A backwards resume cursor is not counted as forward progress', async () => {
	const warnings = [];
	const triggerConfig = config({
		alertPageSize: 1,
		warnLog: (message, details) => warnings.push({ message, details }),
	});
	const seeded = await seededState(triggerConfig);
	const cursorKey = Object.keys(seeded.alertCursors).find((key) => key.startsWith('createdAt:'));
	const cursors = structuredClone(seeded.alertCursors);
	cursors[cursorKey] = {
		throughMs: NOW - 30_000,
		ids: [],
		resumeMs: NOW - 60_000,
		resumeIds: [],
		resumeOverlapStartMs: NOW - 330_000,
	};
	const state = { ...seeded, alertCursors: cursors, stalledAlertPolls: { [cursorKey]: 2 } };
	const rows = [alert('older-position', NOW - 200_000), alert('later-position', NOW - 190_000)];
	let calls = 0;
	const result = await pollSentinelOne(
		async (options) => {
			if (++calls > 1) throw new PollBudgetError();
			return fakeServer(rows).request(options);
		},
		triggerConfig,
		state,
		'scheduled',
		NOW,
	);

	assert.deepEqual(
		result.items.map((item) => item.alertId),
		['older-position'],
	);
	assert.equal(result.nextState.alertCursors[cursorKey].resumeMs, NOW - 200_000);
	assert.equal(result.nextState.stalledAlertPolls[cursorKey], 3);
	assert.equal(warnings.length, 1);
});

test('A stalled batch errors before the next read after saving ten polls of sibling progress', async () => {
	const triggerConfig = config({
		scopeIds: Array.from({ length: 501 }, (_, index) => `account-${index}`),
	});
	const seeded = await seededState(triggerConfig);
	const cursors = structuredClone(seeded.alertCursors);
	const createdKeys = Object.keys(cursors).filter((key) => key.startsWith('createdAt:'));
	const secondScopeId = [...triggerConfig.scopeIds].sort()[500];
	const stuckKey = createdKeys[1];
	cursors[stuckKey] = {
		throughMs: NOW - 3_600_000,
		ids: [],
		resumeMs: NOW - 3_600_000,
		resumeIds: [],
	};
	let state = { ...seeded, alertCursors: cursors };
	const healthyScopeId = [...triggerConfig.scopeIds].sort()[0];
	const delivered = [];
	for (let poll = 0; poll < 10; poll++) {
		const pollStart = NOW + poll * 60_000;
		const row = alert(`healthy-${poll}`, pollStart - 1_000, healthyScopeId);
		const source = fakeServer([row]);
		const result = await pollSentinelOne(
			async (options) => {
				if (options.body.variables.scope.scopeIds.includes(secondScopeId))
					throw new PollBudgetError();
				return source.request(options);
			},
			{ ...triggerConfig, pollDeadlineMs: pollStart + 36_000 },
			state,
			'scheduled',
			pollStart,
		);
		delivered.push(...result.items.map((item) => item.alertId));
		state = result.nextState;
	}
	assert.deepEqual(
		delivered,
		Array.from({ length: 10 }, (_, index) => `healthy-${index}`),
	);
	assert.equal(state.stalledAlertPolls[stuckKey], 10);

	let requests = 0;
	await assert.rejects(
		pollSentinelOne(
			async () => {
				requests++;
				throw new PollBudgetError();
			},
			{ ...triggerConfig, pollDeadlineMs: NOW + 10 * 60_000 + 36_000 },
			state,
			'scheduled',
			NOW + 10 * 60_000,
		),
		/error.*createdAt.*scope batch 2.*2026-09-01T00:00:00.000Z.*10 polls/i,
	);
	assert.equal(requests, 0);
});
