const assert = require('node:assert/strict');
const test = require('node:test');
const { NodeApiError } = require('n8n-workflow');
const { PollBudgetError } = require('../../dist/nodes/shared/transport/request.js');
const {
	MAX_SEEN_ALERT_IDS,
	fingerprintConfig,
	TRIGGER_STATE_VERSION,
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

function cursorsFor(triggerConfig, checkpointMs) {
	const cursors = {};
	const scopes = [...triggerConfig.scopeIds].sort();
	for (let offset = 0; offset < scopes.length; offset += 500) {
		let hash = 2166136261;
		for (const character of scopes.slice(offset, offset + 500).join('\u0000')) {
			hash ^= character.charCodeAt(0);
			hash = Math.imul(hash, 16777619);
		}
		for (const event of triggerConfig.events) {
			const field = event === 'alert.new' ? 'createdAt' : 'updatedAt';
			cursors[`${field}:${(hash >>> 0).toString(16)}`] = { throughMs: checkpointMs, ids: [] };
		}
	}
	return cursors;
}

function stateFor(triggerConfig, checkpointMs = NOW - 600_000) {
	return {
		version: TRIGGER_STATE_VERSION,
		configFingerprint: fingerprintConfig(triggerConfig),
		initialized: true,
		activationMs: NOW - 3_600_000,
		checkpointMs,
		alertCursors: cursorsFor(triggerConfig, checkpointMs),
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
		pollDeadlineMs: Date.now() + 36_000,
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
		result.items.map((item) => item.id),
		['first-batch-alert'],
	);
});

test('A resumed poll without a host budget keeps the ordinary cursor and ascending reader', async () => {
	const triggerConfig = config({ alertPageSize: 1, pollDeadlineMs: Date.now() + 36_000 });
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
		first.items.map((item) => item.id),
		['first', 'second'],
	);
	const cursor = Object.values(first.nextState.alertCursors)[0];
	assert.equal(cursor.resumeMs, NOW - 45_000);

	const replay = fakeServer(rows);
	const second = await pollSentinelOne(
		replay.request,
		{ ...triggerConfig, pollDeadlineMs: Date.now() + 300_000 },
		first.nextState,
		'scheduled',
		NOW,
	);
	assert.deepEqual(
		second.items.map((item) => item.id),
		['third'],
	);
	assert.equal(replay.requests.length, 1, 'the fallback host uses one ascending New range');
	const ranges = replay.requests.map((request) => {
		const { start, end } = request.body.variables.filters.find(
			(filter) => filter.dateTimeRange,
		).dateTimeRange;
		return { start, end };
	});
	assert.deepEqual(ranges, [{ start: NOW - 45_000, end: NOW }]);
});

test('Seen IDs stay available for a lagging cursor within the bounded state limit', async () => {
	const triggerConfig = config({
		scopeIds: Array.from({ length: 501 }, (_, index) => `account-${index}`),
		pollDeadlineMs: Date.now() + 36_000,
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
		(_, index) => `old-${index}\u0000${iso(NOW - 600_000)}\u0000${secondBatchScopeId}`,
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
