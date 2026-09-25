const assert = require('node:assert/strict');
const test = require('node:test');
const { PollBudgetError } = require('../../dist/nodes/shared/transport/request.js');
const {
	MAX_SEEN_ALERT_IDS,
	fingerprintConfig,
	pollSentinelOne,
} = require('../../dist/nodes/SentinelOnePlatformTrigger/SentinelOneTriggerHelpers.js');
const {
	pollAlertActivities,
} = require('../../dist/nodes/SentinelOnePlatformTrigger/ActivityNotePoll.js');

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

function fakeServer(alerts) {
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
		return {
			data: {
				alerts: {
					edges: rows.slice(offset, next).map((node) => ({ node })),
					pageInfo: {
						hasNextPage: next < rows.length,
						endCursor: next < rows.length ? String(next) : null,
					},
				},
			},
		};
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

test('New keeps draining when Updated is skipped behind its ordinary backlog', async () => {
	const triggerConfig = config({ events: ['alert.new', 'alert.updated'], alertPageSize: 1 });
	const state = await seededState(triggerConfig);
	const cursors = structuredClone(state.alertCursors);
	const createdKey = Object.keys(cursors).find((key) => key.startsWith('createdAt:'));
	const updatedKey = Object.keys(cursors).find((key) => key.startsWith('updatedAt:'));
	cursors[createdKey] = {
		throughMs: NOW - 600_000,
		ids: [],
		resumeMs: NOW - 600_000,
		resumeIds: [],
	};
	cursors[updatedKey] = {
		throughMs: NOW - 30_000,
		ids: [],
		resumeMs: NOW - 30_000,
		resumeIds: [],
	};
	let nextState = { ...state, alertCursors: cursors };
	const rows = Array.from({ length: 13 }, (_, index) =>
		alert(
			`backlog-${index}`,
			NOW - 120_000 + index * 1_000,
			'account-1',
			NOW - 60_000 + index * 1_000,
		),
	);
	const delivered = [];
	let updatedRequests = 0;
	for (let poll = 0; poll < 12; poll++) {
		const pollStart = NOW + poll * 60_000;
		const source = fakeServer(rows);
		const request = async (options) => {
			if (options.body.variables.sortBy === 'updatedAt') {
				updatedRequests++;
				throw new Error('Updated should wait for New to advance');
			}
			if (options.body.variables.after) throw new PollBudgetError();
			return source.request(options);
		};
		const result = await pollSentinelOne(
			request,
			{ ...triggerConfig, pollDeadlineMs: pollStart + 36_000 },
			nextState,
			'scheduled',
			pollStart,
		);
		delivered.push(...result.items.map((item) => item.alertId));
		nextState = result.nextState;
	}
	assert.deepEqual(
		delivered,
		rows.slice(0, 12).map((row) => row.id),
	);
	assert.equal(new Set(delivered).size, 12);
	assert.equal(updatedRequests, 0);
	assert.equal(nextState.stalledAlertPolls, undefined);
	assert.equal(nextState.alertCursors[createdKey].resumeOverlapStartMs, NOW - 900_000);
});

test('A never-read Updated unit counts a no-progress stop and warns only after three polls', async () => {
	const warnings = [];
	const triggerConfig = config({
		events: ['alert.new', 'alert.updated'],
		warnLog: (message, details) => warnings.push({ message, details }),
	});
	const seeded = await seededState(triggerConfig);
	const cursors = structuredClone(seeded.alertCursors);
	const createdKey = Object.keys(cursors).find((key) => key.startsWith('createdAt:'));
	const updatedKey = Object.keys(cursors).find((key) => key.startsWith('updatedAt:'));
	cursors[createdKey] = {
		throughMs: NOW - 600_000,
		ids: [],
		resumeMs: NOW - 600_000,
		resumeIds: [],
	};
	cursors[updatedKey] = {
		throughMs: NOW - 30_000,
		ids: [],
		resumeMs: NOW - 30_000,
		resumeIds: [],
	};
	let state = { ...seeded, alertCursors: cursors };
	for (let poll = 0; poll < 3; poll++) {
		const pollStart = NOW + poll * 60_000;
		const result = await pollSentinelOne(
			async () => {
				throw new PollBudgetError();
			},
			{ ...triggerConfig, pollDeadlineMs: pollStart + 36_000 },
			state,
			'scheduled',
			pollStart,
		);
		state = result.nextState;
	}
	assert.equal(state.stalledAlertPolls[createdKey], 3);
	assert.equal(state.stalledAlertPolls[updatedKey], 3);
	assert.equal(warnings.length, 2);
	assert.match(warnings[0].message, /createdAt stream/);
	assert.equal(warnings[0].details.position, iso(NOW - 600_000));
	assert.match(warnings[1].message, /updatedAt stream/);
	assert.equal(warnings[1].details.position, iso(NOW - 30_000));
});

test('A stalled batch keeps warning while other batches save progress, then fails on a no-progress poll', async () => {
	const warnings = [];
	const triggerConfig = config({
		scopeIds: Array.from({ length: 501 }, (_, index) => `account-${index}`),
		warnLog: (message, details) => warnings.push({ message, details }),
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
	const rows = Array.from({ length: 10 }, (_, index) =>
		alert(`healthy-${index}`, NOW + index * 60_000 - 10_000, healthyScopeId),
	);
	const emitted = [];
	for (let poll = 0; poll < 10; poll++) {
		const pollStart = NOW + poll * 60_000;
		const source = fakeServer(rows);
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
		emitted.push(...result.items.map((item) => item.alertId));
		state = result.nextState;
	}
	assert.deepEqual(
		emitted,
		rows.map((row) => row.id),
	);
	assert.equal(state.stalledAlertPolls[stuckKey], 10);
	assert.equal(warnings.length, 8);
	assert.match(warnings.at(-1).message, /createdAt stream in scope batch 2/i);
	assert.equal(warnings.at(-1).details.position, iso(NOW - 3_600_000));
	await assert.rejects(
		pollSentinelOne(
			async () => {
				throw new PollBudgetError();
			},
			{ ...triggerConfig, pollDeadlineMs: NOW + 10 * 60_000 + 36_000 },
			state,
			'scheduled',
			NOW + 10 * 60_000,
		),
		/error.*createdAt.*scope batch 2.*2026-09-01T00:00:00.000Z.*10 polls/i,
	);
});

test('Budgeted New exclusions fit the request byte limit and prioritise the oldest candidates', async () => {
	const debug = [];
	const triggerConfig = config({
		alertPageSize: 200,
		debug: true,
		debugLog: (message, details) => debug.push({ message, details }),
	});
	const seeded = await seededState(triggerConfig);
	const cursorKey = Object.keys(seeded.alertCursors).find((key) => key.startsWith('createdAt:'));
	const rows = Array.from({ length: 5_500 }, (_, index) =>
		alert(`seen-${String(index).padStart(40, '0')}`, NOW - 90_000 + index),
	);
	const state = {
		...seeded,
		alertCursors: {
			...seeded.alertCursors,
			[cursorKey]: { throughMs: NOW - 120_000, ids: [] },
		},
		seenAlertIds: rows.map((row) => `${row.id}\u0000${row.createdAt}\u0000account-1`),
	};
	const source = fakeServer(rows);
	const result = await pollSentinelOne(source.request, triggerConfig, state, 'scheduled', NOW);
	assert.deepEqual(result.items, []);
	assert.ok(source.requests.length > 1);
	const exclusionLists = source.requests.map(
		(request) =>
			request.body.variables.filters.find((filter) => filter.fieldId === 'id')?.stringIn.values ??
			[],
	);
	assert.ok(exclusionLists.every((ids) => Buffer.byteLength(JSON.stringify(ids)) <= 200_000));
	assert.ok(exclusionLists[0].length > 1_000 && exclusionLists[0].length < rows.length);
	assert.deepEqual(
		exclusionLists[0],
		rows.slice(0, exclusionLists[0].length).map((row) => row.id),
	);
	assert.ok(Buffer.byteLength(JSON.stringify(source.requests[0].body)) < 250_000);
	assert.ok(
		debug.every(
			({ details }) => details.excludedIdCount === undefined || details.excludedIdCount <= 5_500,
		),
	);
	assert.ok(!JSON.stringify(debug).includes('seen-0'));
	assert.equal(result.nextState.seenAlertIds.length, 5_500);
	assert.ok(result.nextState.seenAlertIds.length < MAX_SEEN_ALERT_IDS);
});

test('A resumed New read overlaps from its saved cursor position', async () => {
	const triggerConfig = config();
	const seeded = await seededState(triggerConfig);
	const cursorKey = Object.keys(seeded.alertCursors).find((key) => key.startsWith('createdAt:'));
	const cursor = {
		throughMs: NOW - 600_000,
		ids: [],
		resumeMs: NOW - 660_000,
		resumeIds: [],
	};
	const state = { ...seeded, alertCursors: { ...seeded.alertCursors, [cursorKey]: cursor } };
	const late = alert('late-arrival', NOW - 840_000);
	const source = fakeServer([late]);
	const result = await pollSentinelOne(source.request, triggerConfig, state, 'scheduled', NOW);
	assert.deepEqual(
		result.items.map((item) => item.alertId),
		['late-arrival'],
	);
	assert.equal(source.requests[0].body.variables.filters[0].dateTimeRange.start, NOW - 900_000);
});

test('Hosts without a poll budget ignore budget-only cursor fields and keep descending reads', async () => {
	const triggerConfig = config({ pollDeadlineMs: undefined });
	const seeded = await seededState(triggerConfig);
	const cursorKey = Object.keys(seeded.alertCursors).find((key) => key.startsWith('createdAt:'));
	const state = {
		...seeded,
		alertCursors: {
			...seeded.alertCursors,
			[cursorKey]: {
				throughMs: NOW - 60_000,
				ids: [],
				resumeMs: NOW - 30_000,
				resumeIds: [],
				resumeOverlapStartMs: 'ignored by legacy hosts',
			},
		},
	};
	const source = fakeServer([alert('legacy-host', NOW - 10_000)]);
	const result = await pollSentinelOne(source.request, triggerConfig, state, 'scheduled', NOW);
	assert.deepEqual(
		result.items.map((item) => item.alertId),
		['legacy-host'],
	);
	assert.ok(source.requests.every((request) => request.body.variables.sortOrder === 'DESC'));
	assert.equal('resumeOverlapStartMs' in result.nextState.alertCursors[cursorKey], false);
});

test('Activity feed budget failures distinguish query deadline from event count', async () => {
	const activityConfig = {
		baseUrl: 'https://tenant.example',
		credentialIdentity: { type: 'sentinelOnePlatformApi', id: 'credential-1' },
		scopeType: 'ACCOUNT',
		scopeIds: ['account-1'],
		allVisibleAccounts: false,
		events: ['alert.activity'],
		severities: [],
		statuses: [],
		alertName: '',
		simplifyOutput: true,
		debug: false,
		overlapSeconds: 300,
		maxAlertPages: 25,
		requestTimeoutMs: 30_000,
	};
	const previous = {
		configFingerprint: `${fingerprintConfig(activityConfig)}:sdl-activities-v1`,
		initialized: true,
		checkpointMs: NOW - 300_000,
		activityActivationMs: NOW - 600_000,
		seenActivityIds: [],
		seenActivityTimestamps: {},
	};
	let clock = 0;
	await assert.rejects(
		pollAlertActivities(
			async () => assert.fail('the deadline should stop the read before a request'),
			activityConfig,
			previous,
			'scheduled',
			NOW,
			{ now: () => clock++, deadlineMs: 1 },
		),
		/query budget ended before a forward window completed/,
	);
	await assert.rejects(
		pollAlertActivities(
			async (request) => {
				const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
				const start = Date.parse(body.startTime);
				const end = Date.parse(body.endTime);
				const events = Array.from({ length: 40_001 }, (_, index) => {
					const time = NOW - 300_900 + Math.floor((index * 899) / 40_001);
					return {
						time,
						timestamp: `${BigInt(time) * 1_000_000n + BigInt(index)}`,
						values: {
							activity_id: `activity-${index}`,
							created_at: iso(time),
							'data.alert.id': 'alert-1',
							activity_type: '16007',
							'data.payload.note_text': 'note',
							'data.user.id': null,
							'data.user.enriched_name': null,
						},
					};
				});
				return {
					id: 'query-1',
					stepsCompleted: 1,
					stepsTotal: 1,
					data: {
						matches: events
							.filter(({ time }) => time >= start && time < end)
							.map(({ timestamp, values }) => ({ timestamp, values })),
					},
				};
			},
			activityConfig,
			previous,
			'scheduled',
			NOW,
		),
		/activity event budget ended before a forward window completed/,
	);
});
