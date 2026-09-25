const assert = require('node:assert/strict');
const test = require('node:test');
const { NodeApiError } = require('n8n-workflow');
const { PollBudgetError } = require('../../dist/nodes/shared/transport/request.js');
const {
	MAX_SEEN_ALERT_IDS,
	fingerprintConfig,
	pollSentinelOne,
} = require('../../dist/nodes/SentinelOnePlatformTrigger/SentinelOneTriggerHelpers.js');

const NOW = Date.parse('2026-09-01T01:00:00.000Z');
const iso = (time) => new Date(time).toISOString();
const node = { name: 'Demo', type: 'sentinelOnePlatform', typeVersion: 1, position: [0, 0] };

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
		...overrides,
	};
}

function stateFor(triggerConfig, checkpointMs = NOW - 600_000) {
	return {
		configFingerprint: fingerprintConfig(triggerConfig),
		initialized: true,
		activationMs: NOW - 3_600_000,
		checkpointMs,
		seenAlertIds: [],
		seenAlertVersions: [],
	};
}

function alert(id, createdAt, accountId = 'account-1') {
	return {
		id,
		name: `Alert ${id}`,
		severity: 'HIGH',
		status: 'NEW',
		createdAt: iso(createdAt),
		updatedAt: iso(createdAt),
		realTime: { scope: { account: { id: accountId, name: accountId } } },
	};
}

function fakeServer(alerts, { visibleAt = () => true } = {}) {
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
					visibleAt(row) &&
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

test('A starved New read in the second scope batch does not crash or discard the first batch', async () => {
	const triggerConfig = config({
		scopeIds: Array.from({ length: 501 }, (_, index) => `account-${index}`),
		events: ['alert.new', 'alert.updated'],
		pollDeadlineMs: NOW + 36_000,
	});
	const seed = await pollSentinelOne(
		fakeServer([]).request,
		triggerConfig,
		stateFor(triggerConfig),
		'scheduled',
		NOW - 120_000,
	);
	const cursors = structuredClone(seed.nextState.alertCursors);
	const createdKeys = Object.keys(cursors).filter((key) => key.startsWith('createdAt:'));
	const secondHash = createdKeys[1].slice('createdAt:'.length);
	const secondBatchScopeId = [...triggerConfig.scopeIds].sort()[500];
	cursors[createdKeys[0]] = { throughMs: NOW - 60_000, ids: [] };
	cursors[createdKeys[1]] = {
		throughMs: NOW - 1_200_000,
		ids: ['already-read'],
		resumeMs: NOW - 1_200_000,
		resumeIds: ['already-read'],
	};
	const secondUpdatedKey = `updatedAt:${secondHash}`;
	cursors[secondUpdatedKey] = { throughMs: NOW - 2_400_000, ids: [] };
	const state = { ...seed.nextState, alertCursors: cursors };
	const request = async (options) => {
		const variables = options.body.variables;
		if (variables.sortBy === 'createdAt' && variables.scope.scopeIds.includes(secondBatchScopeId))
			throw new PollBudgetError();
		const row =
			variables.scope.scopeIds.includes('account-1') && variables.sortBy === 'createdAt'
				? alert('first-batch-alert', NOW - 30_000, 'account-1')
				: undefined;
		return fakeServer(row ? [row] : []).request(options);
	};

	const result = await pollSentinelOne(request, triggerConfig, state, 'scheduled', NOW);
	assert.deepEqual(
		result.items.map((item) => item.alertId),
		['first-batch-alert'],
	);
});

test('A resumed poll without a budget preserves the original event and segment behaviour', async () => {
	const triggerConfig = config({ alertPageSize: 1, pollDeadlineMs: NOW + 36_000 });
	const rows = [
		alert('first', NOW - 55_000),
		alert('second', NOW - 45_000),
		alert('third', NOW - 40_000),
	];
	let calls = 0;
	const first = await pollSentinelOne(
		async (options) => {
			calls += 1;
			if (calls === 3) throw new PollBudgetError();
			return fakeServer(rows).request(options);
		},
		triggerConfig,
		stateFor(triggerConfig),
		'scheduled',
		NOW - 10_000,
	);
	assert.deepEqual(
		first.items.map((item) => item.alertId),
		['first', 'second'],
	);
	const cursor = Object.values(first.nextState.alertCursors)[0];
	assert.equal(cursor.resumeMs, NOW - 45_000);

	const replay = fakeServer(rows);
	const second = await pollSentinelOne(
		replay.request,
		{ ...triggerConfig, pollDeadlineMs: undefined },
		first.nextState,
		'scheduled',
		NOW,
	);
	assert.deepEqual(
		second.items.map((item) => item.alertId),
		['third'],
	);
	assert.equal(replay.requests.length, 2, 'the no-budget host keeps its original resume segments');
	const ranges = replay.requests.map((request) => {
		const { start, end } = request.body.variables.filters.find(
			(filter) => filter.dateTimeRange,
		).dateTimeRange;
		return { start, end };
	});
	assert.deepEqual(ranges, [
		{ start: NOW - 45_000, end: NOW - 45_000 },
		{ start: NOW - 44_999, end: NOW },
	]);
});

test('A late-ingested New alert behind a resumed cursor is delivered once within the overlap', async () => {
	const triggerConfig = config({ alertPageSize: 1, pollDeadlineMs: NOW + 36_000 });
	const pollStart = NOW - 10_000;
	const rows = [
		alert('first', NOW - 55_000),
		alert('late', NOW - 50_000),
		alert('second', NOW - 45_000),
		alert('third', NOW - 40_000),
	];
	let calls = 0;
	const first = await pollSentinelOne(
		async (options) => {
			calls += 1;
			if (calls === 3) throw new PollBudgetError();
			return fakeServer(rows.filter((row) => row.id !== 'late')).request(options);
		},
		triggerConfig,
		stateFor(triggerConfig),
		'scheduled',
		pollStart,
	);
	assert.deepEqual(
		first.items.map((item) => item.alertId),
		['first', 'second'],
	);
	const createdCursor = Object.values(first.nextState.alertCursors)[0];
	assert.equal(createdCursor.resumeMs, NOW - 45_000);

	const replay = fakeServer(rows);
	const second = await pollSentinelOne(
		replay.request,
		{ ...triggerConfig, alertPageSize: 10, pollDeadlineMs: NOW + 60_000 },
		first.nextState,
		'scheduled',
		NOW,
	);
	assert.deepEqual(
		second.items.map((item) => item.alertId),
		['late', 'third'],
	);
	assert.equal(replay.requests.length, 1, 'createdAt resumes in one list request');
	const variables = replay.requests[0].body.variables;
	assert.ok(variables.filters[0].dateTimeRange.start <= createdCursor.resumeMs);
	assert.deepEqual(
		new Set(
			variables.filters.find(
				(filter) => filter.fieldId === 'id' && filter.isNegated,
			).stringIn.values,
		),
		new Set(['first', 'second']),
	);
	const again = await pollSentinelOne(
		fakeServer(rows).request,
		{ ...triggerConfig, pollDeadlineMs: NOW + 120_000 },
		second.nextState,
		'scheduled',
		NOW + 60_000,
	);
	assert.deepEqual(again.items, []);
});

test('Budgeted overlap exclusions include only seen alerts from the current scope batch', async () => {
	const triggerConfig = config({
		scopeIds: Array.from({ length: 501 }, (_, index) => `account-${index}`),
		pollDeadlineMs: NOW + 36_000,
	});
	const seed = await pollSentinelOne(
		fakeServer([]).request,
		triggerConfig,
		stateFor(triggerConfig),
		'scheduled',
		NOW,
	);
	const sortedScopes = [...triggerConfig.scopeIds].sort();
	const firstScopeId = sortedScopes[0];
	const secondScopeId = sortedScopes[500];
	const cursors = structuredClone(seed.nextState.alertCursors);
	for (const key of Object.keys(cursors).filter((cursorKey) => cursorKey.startsWith('createdAt:')))
		cursors[key] = {
			throughMs: NOW - 120_000,
			ids: [],
			resumeMs: NOW - 120_000,
			resumeIds: [],
		};
	const state = {
		...seed.nextState,
		alertCursors: cursors,
		seenAlertIds: [
			`first-batch-seen\u0000${iso(NOW - 60_000)}\u0000${firstScopeId}`,
			`second-batch-seen\u0000${iso(NOW - 60_000)}\u0000${secondScopeId}`,
		],
	};
	const replay = fakeServer([]);
	await pollSentinelOne(replay.request, triggerConfig, state, 'scheduled', NOW);
	assert.equal(replay.requests.length, 2);
	for (const request of replay.requests) {
		const variables = request.body.variables;
		const excluded = new Set(
			variables.filters.find((filter) => filter.fieldId === 'id' && filter.isNegated)?.stringIn
				.values ?? [],
		);
		if (variables.scope.scopeIds.includes(firstScopeId)) {
			assert.ok(excluded.has('first-batch-seen'));
			assert.ok(!excluded.has('second-batch-seen'));
		} else {
			assert.ok(variables.scope.scopeIds.includes(secondScopeId));
			assert.ok(excluded.has('second-batch-seen'));
			assert.ok(!excluded.has('first-batch-seen'));
		}
	}
});

test('Legacy unscoped seen IDs still suppress duplicate alerts across scope batches', async () => {
	const triggerConfig = config({
		scopeIds: Array.from({ length: 501 }, (_, index) => `account-${index}`),
		pollDeadlineMs: NOW + 36_000,
	});
	const seed = await pollSentinelOne(
		fakeServer([]).request,
		triggerConfig,
		stateFor(triggerConfig),
		'scheduled',
		NOW,
	);
	const sortedScopes = [...triggerConfig.scopeIds].sort();
	const firstScopeId = sortedScopes[0];
	const cursors = structuredClone(seed.nextState.alertCursors);
	for (const key of Object.keys(cursors).filter((cursorKey) => cursorKey.startsWith('createdAt:')))
		cursors[key] = {
			throughMs: NOW - 120_000,
			ids: [],
			resumeMs: NOW - 120_000,
			resumeIds: [],
		};
	const createdAt = NOW - 60_000;
	const state = {
		...seed.nextState,
		alertCursors: cursors,
		seenAlertIds: [`already-delivered\u0000${iso(createdAt)}`],
	};
	const result = await pollSentinelOne(
		fakeServer([alert('already-delivered', createdAt, firstScopeId)]).request,
		triggerConfig,
		state,
		'scheduled',
		NOW,
	);
	assert.deepEqual(result.items, []);
	assert.ok(
		result.nextState.seenAlertIds.includes(
			`already-delivered\u0000${iso(createdAt)}\u0000${firstScopeId}`,
		),
		'the fetched legacy identity is saved with its scope for later bounded exclusions',
	);
});

test('A repeatedly starved batch warns after three polls and fails only when the whole poll makes no progress', async () => {
	const warnings = [];
	const triggerConfig = config({
		scopeIds: Array.from({ length: 501 }, (_, index) => `account-${index}`),
		pollDeadlineMs: NOW + 36_000,
		warnLog: (message, details) => warnings.push({ message, details }),
	});
	const seed = await pollSentinelOne(
		fakeServer([]).request,
		triggerConfig,
		stateFor(triggerConfig),
		'scheduled',
		NOW - 120_000,
	);
	const cursors = structuredClone(seed.nextState.alertCursors);
	const secondCreatedKey = Object.keys(cursors).filter((key) => key.startsWith('createdAt:'))[1];
	const secondBatchScopeId = [...triggerConfig.scopeIds].sort()[500];
	cursors[secondCreatedKey] = {
		throughMs: NOW - 3_600_000,
		ids: [],
		resumeMs: NOW - 3_600_000,
		resumeIds: [],
	};
	let state = { ...seed.nextState, alertCursors: cursors };
	let result;
	for (let poll = 0; poll < 9; poll += 1) {
		const pollStart = NOW + poll * 60_000;
		result = await pollSentinelOne(
			async (options) => {
				if (
					options.body.variables.sortBy === 'createdAt' &&
					options.body.variables.scope.scopeIds.includes(secondBatchScopeId)
				)
					throw new PollBudgetError();
				return fakeServer([]).request(options);
			},
			{ ...triggerConfig, pollDeadlineMs: pollStart + 36_000 },
			state,
			'scheduled',
			pollStart,
		);
		state = result.nextState;
	}
	assert.equal(state.stalledAlertPolls[secondCreatedKey], 9);
	assert.equal(warnings.length, 7);
	assert.match(warnings[0].message, /scope batch 2.*3 polls/i);
	const progressed = await pollSentinelOne(
		async (options) => {
			if (
				options.body.variables.sortBy === 'createdAt' &&
				options.body.variables.scope.scopeIds.includes(secondBatchScopeId)
			)
				throw new PollBudgetError();
			return fakeServer([]).request(options);
		},
		{ ...triggerConfig, pollDeadlineMs: NOW + 9 * 60_000 + 36_000 },
		state,
		'scheduled',
		NOW + 9 * 60_000,
	);
	state = progressed.nextState;
	assert.equal(state.stalledAlertPolls[secondCreatedKey], 10);
	assert.equal(warnings.length, 8);
	await assert.rejects(
		pollSentinelOne(
			async (options) => {
				if (options.body.variables.sortBy === 'createdAt') throw new PollBudgetError();
				return fakeServer([]).request(options);
			},
			{ ...triggerConfig, pollDeadlineMs: NOW + 10 * 60_000 + 36_000 },
			state,
			'scheduled',
			NOW + 10 * 60_000,
		),
		/error.*createdAt.*scope batch 2.*2026-09-01T00:00:00.000Z.*10 polls/i,
	);
});

test('Seen IDs stay available for a lagging cursor within the bounded state limit', async () => {
	const triggerConfig = config({
		scopeIds: Array.from({ length: 501 }, (_, index) => `account-${index}`),
		pollDeadlineMs: NOW + 36_000,
	});
	const seed = await pollSentinelOne(
		fakeServer([]).request,
		triggerConfig,
		stateFor(triggerConfig),
		'scheduled',
		NOW - 120_000,
	);
	const cursors = structuredClone(seed.nextState.alertCursors);
	const secondCreatedKey = Object.keys(cursors).filter((key) => key.startsWith('createdAt:'))[1];
	const secondBatchScopeId = [...triggerConfig.scopeIds].sort()[500];
	cursors[secondCreatedKey] = {
		throughMs: NOW - 3_600_000,
		ids: [],
		resumeMs: NOW - 3_600_000,
		resumeIds: [],
	};
	const seenAlertIds = Array.from(
		{ length: MAX_SEEN_ALERT_IDS },
		(_, index) => `old-${index}\u0000${iso(NOW - 600_000)}`,
	);
	const state = { ...seed.nextState, alertCursors: cursors, seenAlertIds };
	const result = await pollSentinelOne(
		async (options) => {
			if (
				options.body.variables.sortBy === 'createdAt' &&
				options.body.variables.scope.scopeIds.includes(secondBatchScopeId)
			)
				throw new PollBudgetError();
			return fakeServer([]).request(options);
		},
		triggerConfig,
		state,
		'scheduled',
		NOW,
	);
	assert.equal(result.nextState.seenAlertIds.length, MAX_SEEN_ALERT_IDS);
});

test('A seen-state capacity error tells the operator how to recover', async () => {
	const seenAlertIds = Array.from(
		{ length: MAX_SEEN_ALERT_IDS },
		(_, index) => `old-${index}\u0000${iso(NOW - 120_000)}`,
	);
	const triggerConfig = config({ pollDeadlineMs: NOW + 36_000 });
	let state = { ...stateFor(triggerConfig), seenAlertIds };
	for (let poll = 0; poll < 9; poll += 1) {
		const pollStart = NOW + poll * 60_000;
		const result = await pollSentinelOne(
			fakeServer([alert('new-alert', NOW - 60_000)]).request,
			{ ...triggerConfig, pollDeadlineMs: pollStart + 36_000 },
			state,
			'scheduled',
			pollStart,
		);
		state = result.nextState;
	}
	await assert.rejects(
		pollSentinelOne(
			fakeServer([alert('new-alert', NOW - 60_000)]).request,
			{ ...triggerConfig, pollDeadlineMs: NOW + 9 * 60_000 + 36_000 },
			state,
			'scheduled',
			NOW + 9 * 60_000,
		),
		/alert state reached its safe capacity.*Narrow the scope or filters so the overlap fits/,
	);
});

test('A complete poll at the saved cursor is a valid no-op with or without a budget', async () => {
	const triggerConfig = config();
	const key = 'createdAt:unit';
	const state = {
		...stateFor(triggerConfig),
		alertCursors: { [key]: { throughMs: NOW, ids: [] } },
	};
	const unbudgeted = await pollSentinelOne(
		fakeServer([]).request,
		triggerConfig,
		state,
		'scheduled',
		NOW,
	);
	assert.deepEqual(unbudgeted.items, []);
	const budgetedConfig = { ...triggerConfig, pollDeadlineMs: NOW + 36_000 };
	const budgeted = await pollSentinelOne(
		fakeServer([]).request,
		budgetedConfig,
		{ ...state, configFingerprint: fingerprintConfig(budgetedConfig) },
		'scheduled',
		NOW,
	);
	assert.deepEqual(budgeted.items, []);
});

test('A NodeApiError rejected by a stream request keeps its identity', async () => {
	const triggerConfig = config({ events: ['alert.new', 'alert.updated'] });
	const denied = new NodeApiError(
		node,
		Object.assign(new Error('Forbidden'), {
			isAxiosError: true,
			response: { status: 403, headers: {}, data: {} },
		}),
	);
	await assert.rejects(
		pollSentinelOne(
			async () => {
				throw denied;
			},
			triggerConfig,
			stateFor(triggerConfig),
			'scheduled',
			NOW,
		),
		(error) => error === denied,
	);
});
