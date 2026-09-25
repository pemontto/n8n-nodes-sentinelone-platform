const assert = require('node:assert/strict');
const test = require('node:test');
const {
	PollBudgetError,
	requestWithRetry,
} = require('../../dist/nodes/shared/transport/request.js');
const {
	MAX_SEEN_ALERT_IDS,
	MAX_SEEN_ALERT_VERSIONS,
	fingerprintConfig,
	pollSentinelOne,
} = require('../../dist/nodes/SentinelOnePlatformTrigger/SentinelOneTriggerHelpers.js');
const {
	pollAlertActivities,
} = require('../../dist/nodes/SentinelOnePlatformTrigger/ActivityNotePoll.js');
const {
	SentinelOnePlatformTrigger,
} = require('../../dist/nodes/SentinelOnePlatformTrigger/SentinelOnePlatformTrigger.node.js');

const NOW = Date.parse('2026-08-26T12:00:00.000Z');
const CHECKPOINT = NOW - 3 * 3600_000;
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
		concurrentRequests: 5,
		requestTimeoutMs: 30_000,
		alertPageSize: 200,
		maxAlertPages: 25,
		...overrides,
	};
}

/** State as a host that predates per-unit cursors saved it. */
function legacyState(triggerConfig, checkpointMs = CHECKPOINT) {
	return {
		configFingerprint: fingerprintConfig(triggerConfig),
		initialized: true,
		checkpointMs,
		seenAlertIds: [],
		seenAlertVersions: [],
	};
}

function alert(id, createdAt, updatedAt = createdAt, accountId = 'account-1') {
	return {
		id,
		name: `Alert ${id}`,
		severity: 'HIGH',
		status: 'NEW',
		createdAt: iso(createdAt),
		updatedAt: iso(updatedAt),
		realTime: { scope: { account: { id: accountId, name: `Account ${accountId}` } } },
	};
}

/** A fake clock that the transport reads through Date.now, so capped timeouts are real deadline arithmetic. */
async function withClock(run) {
	const realNow = Date.now;
	let now = realNow();
	Date.now = () => now;
	try {
		return await run({
			start: now,
			now: () => now,
			advance: (milliseconds) => {
				now += milliseconds;
			},
		});
	} finally {
		Date.now = realNow;
	}
}

/**
 * Serves alerts inside the requested range in the requested order, `first` per page, with numeric cursors and the negated id filter.
 * Every listing page costs `pageCostMs` of clock time and every detail read `detailCostMs`; a request whose cost exceeds its capped timeout raises a timeout error at the cap.
 */
function tenant(alerts, options = {}) {
	const { pageCostMs = 0, clock } = options;
	const state = { requests: [] };
	const spend = (cost, timeoutMs) => {
		if (!clock) return;
		if (cost > timeoutMs) {
			clock.advance(timeoutMs);
			throw Object.assign(new Error(`timeout of ${timeoutMs}ms exceeded`), {
				code: 'ECONNABORTED',
			});
		}
		clock.advance(cost);
	};
	const raw = async (requestOptions, timeoutMs = requestOptions.timeout) => {
		const variables = requestOptions.body.variables;
		state.requests.push(requestOptions);
		const pageCost =
			typeof pageCostMs === 'function'
				? pageCostMs(state.requests.length, requestOptions)
				: pageCostMs;
		spend(pageCost, timeoutMs);
		const field = variables.sortBy;
		const excluded =
			variables.filters.find((filter) => filter.fieldId === 'id' && filter.isNegated)?.stringIn
				.values ?? [];
		const range = variables.filters[0].dateTimeRange;
		const scope = new Set(variables.scope.scopeIds);
		const direction = variables.sortOrder === 'ASC' && !options.ignoreSortOrder ? 1 : -1;
		const matches = alerts
			.filter(
				(row) =>
					scope.has(row.realTime.scope.account.id) &&
					Date.parse(row[field]) >= range.start &&
					Date.parse(row[field]) <= range.end &&
					!excluded.includes(row.id),
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
					edges: matches.slice(offset, next).map((node) => ({ node })),
					pageInfo: {
						hasNextPage: next < matches.length,
						endCursor: next < matches.length ? String(next) : null,
					},
				},
			},
		};
	};
	/** The node's transport in front of the stub: capped attempt timeouts and deadline classification. */
	const budgeted = (deadline) => async (requestOptions) => {
		const result = await requestWithRetry(
			async (timeoutMs) => await raw(requestOptions, timeoutMs),
			{ attempts: 3, timeoutMs: requestOptions.timeout, deadline },
		);
		if (result.ok) return result.value;
		throw result.error;
	};
	return { request: raw, budgeted, state };
}

const ids = (result) => result.items.map((item) => item.alertId);
const events = (result) => result.items.map((item) => [item.eventType, item.alertId]);

const backlog = [
	alert('A', CHECKPOINT + 60_000),
	alert('B', CHECKPOINT + 360_000),
	alert('C', CHECKPOINT + 480_000),
	alert('D', NOW - 60_000),
];

/** Polls until the poll start is reached, giving every poll the same budget on the same clock. */
async function drain(triggerConfig, initialState, alerts, { budgetMs, pageCostMs, maxPolls = 40 }) {
	return await withClock(async (clock) => {
		let state = initialState;
		const emitted = [];
		let polls = 0;
		let requestCount = 0;
		while (state.checkpointMs < NOW) {
			assert.ok(++polls <= maxPolls, `the backlog did not drain within ${maxPolls} polls`);
			const source = tenant(alerts, { pageCostMs, clock });
			const result = await pollSentinelOne(
				source.budgeted(clock.now() + budgetMs),
				{ ...triggerConfig, pollDeadlineMs: clock.now() + budgetMs },
				state,
				'scheduled',
				NOW,
			);
			emitted.push(...result.items);
			requestCount += source.state.requests.length;
			state = result.nextState;
		}
		return { emitted, state, polls, requestCount };
	});
}

test('Without a budget the scheduled read keeps its output order from the overlap before the checkpoint, every alert delivered, checkpoint at the poll start', async () => {
	const triggerConfig = config({ events: ['alert.new', 'alert.updated'] });
	const source = tenant(backlog);
	const result = await pollSentinelOne(
		source.request,
		triggerConfig,
		legacyState(triggerConfig),
		'scheduled',
		NOW,
	);
	const variables = source.state.requests.map((request) => request.body.variables);
	assert.deepEqual(
		variables
			.map((value) => [
				value.sortBy,
				value.sortOrder,
				value.filters[0].dateTimeRange.start,
				value.filters[0].dateTimeRange.end,
			])
			.sort(),
		[
			['createdAt', 'DESC', CHECKPOINT - 300_000, NOW],
			['updatedAt', 'ASC', CHECKPOINT - 300_000, NOW],
		],
	);
	assert.ok(variables.every((value) => !value.filters.some((filter) => filter.fieldId === 'id')));
	assert.deepEqual(ids(result), ['A', 'B', 'C', 'D']);
	assert.equal(result.nextState.checkpointMs, NOW);
	assert.deepEqual(Object.values(result.nextState.alertCursors), [
		{ throughMs: NOW, ids: [] },
		{ throughMs: NOW, ids: [] },
	]);
});

test('A manual preview still reads newest first and needs no cursor', async () => {
	const source = tenant(backlog);
	const result = await pollSentinelOne(source.request, config(), {}, 'manual', NOW);
	assert.deepEqual(
		[...new Set(source.state.requests.map((request) => request.body.variables.sortOrder))],
		['DESC'],
	);
	assert.deepEqual(ids(result), ['A', 'B', 'C', 'D']);
	assert.equal(result.nextState, undefined);
});

test('A capped timeout at the budget stops pagination: the pages read are delivered, the cursor is their last alert, and the next poll resumes without loss or duplicates', async () => {
	const triggerConfig = config({ alertPageSize: 1 });
	const first = await withClock(async (clock) => {
		const source = tenant(backlog, { pageCostMs: 6_000, clock });
		const result = await pollSentinelOne(
			source.budgeted(clock.start + 14_000),
			{ ...triggerConfig, pollDeadlineMs: clock.start + 14_000 },
			legacyState(triggerConfig),
			'scheduled',
			NOW,
		);
		assert.equal(
			clock.now(),
			clock.start + 14_000,
			'the third page timed out exactly at the budget',
		);
		return result;
	});
	assert.deepEqual(ids(first), ['A', 'B']);
	assert.deepEqual(first.nextState.alertCursors, {
		[Object.keys(first.nextState.alertCursors)[0]]: {
			throughMs: CHECKPOINT + 360_000,
			ids: ['B'],
			resumeMs: CHECKPOINT + 360_000,
			resumeIds: ['B'],
		},
	});
	assert.equal(first.nextState.checkpointMs, CHECKPOINT + 360_000);

	const source = tenant(backlog);
	const second = await pollSentinelOne(
		source.request,
		triggerConfig,
		first.nextState,
		'scheduled',
		NOW,
	);
	assert.equal(
		source.state.requests[0].body.variables.filters[0].dateTimeRange.start,
		CHECKPOINT + 360_000,
	);
	assert.deepEqual(ids(second), ['C', 'D']);
	assert.equal(second.nextState.checkpointMs, NOW);
});

test('A large backlog drains over polls that each get the same finite budget, in order and once', async () => {
	const triggerConfig = config({ alertPageSize: 2 });
	const alerts = Array.from({ length: 14 }, (_, index) =>
		alert(`alert-${String(index).padStart(2, '0')}`, CHECKPOINT + 10_000 + index * 600_000),
	);
	const { emitted, polls } = await drain(triggerConfig, legacyState(triggerConfig), alerts, {
		budgetMs: 14_000,
		pageCostMs: 6_000,
	});
	assert.deepEqual(
		emitted.map((item) => item.alertId),
		alerts.map((row) => row.id),
	);
	assert.ok(polls >= 4, 'the budget cut every poll short');
});

test('A 1,000-alert bulk edit sharing one timestamp drains with the same finite budget every poll, without repeats', async () => {
	const triggerConfig = config({ events: ['alert.updated'] });
	const edited = NOW - 1_800_000;
	const alerts = Array.from({ length: 1_000 }, (_, index) =>
		alert(`tied-${String(index).padStart(4, '0')}`, CHECKPOINT - 3600_000, edited),
	);
	const { emitted, state, polls } = await drain(triggerConfig, legacyState(triggerConfig), alerts, {
		budgetMs: 20_000,
		pageCostMs: 6_000,
	});
	assert.deepEqual(
		emitted.map((item) => item.alertId),
		alerts.map((row) => row.id),
	);
	assert.equal(state.checkpointMs, NOW);
	assert.ok(polls <= 2, `${polls} polls resumed at the tie position without replaying prior pages`);
});

test('An alert delivered from a tie block and revised later is delivered again: the exclusion applies only at the tie timestamp', async () => {
	const triggerConfig = config({ events: ['alert.new', 'alert.updated'], alertPageSize: 1 });
	const tied = CHECKPOINT + 120_000;
	const alerts = [alert('A', tied), alert('B', tied), alert('C', tied)];
	const first = await withClock(async (clock) => {
		const source = tenant(alerts, { pageCostMs: 6_000, clock });
		return await pollSentinelOne(
			source.budgeted(clock.start + 14_000),
			{ ...triggerConfig, pollDeadlineMs: clock.start + 14_000 },
			legacyState(triggerConfig),
			'scheduled',
			NOW,
		);
	});
	assert.deepEqual(events(first), [
		['alert.new', 'A'],
		['alert.new', 'B'],
	]);
	const revised = alerts.map((row) =>
		row.id === 'A' ? { ...row, updatedAt: iso(NOW - 60_000) } : row,
	);
	const source = tenant(revised);
	const second = await pollSentinelOne(
		source.request,
		triggerConfig,
		first.nextState,
		'scheduled',
		NOW,
	);
	assert.deepEqual(events(second), [
		['alert.new', 'C'],
		['alert.updated', 'A'],
	]);
});

test('A baseline cut short by the budget never replays pre-activation alerts as New and still delivers post-activation ones once', async () => {
	const triggerConfig = config({ alertPageSize: 1 });
	const activation = NOW;
	const alerts = [
		alert('old-1', activation - 290_000),
		alert('old-2', activation - 280_000),
		alert('old-3', activation - 100_000),
	];
	const first = await withClock(async (clock) => {
		const source = tenant(alerts, { pageCostMs: 6_000, clock });
		return await pollSentinelOne(
			source.budgeted(clock.start + 8_000),
			{ ...triggerConfig, pollDeadlineMs: clock.start + 8_000 },
			{},
			'scheduled',
			activation,
		);
	});
	assert.deepEqual(first.items, []);
	assert.equal(first.nextState.activationMs, activation);
	let state = first.nextState;
	const withNew = [...alerts, alert('post-activation', activation + 30_000)];
	const seen = [];
	for (const pollStart of [activation + 60_000, activation + 120_000, activation + 180_000]) {
		const result = await pollSentinelOne(
			tenant(withNew).request,
			triggerConfig,
			state,
			'scheduled',
			pollStart,
		);
		seen.push(...ids(result));
		state = result.nextState;
	}
	assert.deepEqual(seen, ['post-activation']);
});

test('A drain past the seen-ID limit keeps every identity still inside an overlap, so the re-read repeats nothing', async () => {
	const triggerConfig = config({ alertPageSize: 200, maxAlertPages: 10 });
	const count = MAX_SEEN_ALERT_IDS + 1_000;
	const alerts = Array.from({ length: count }, (_, index) =>
		alert(`alert-${index}`, NOW - (count - index) * 1_000),
	);
	const { emitted, state } = await drain(
		triggerConfig,
		legacyState(triggerConfig, NOW - count * 1_000),
		alerts,
		{ budgetMs: 5_000, pageCostMs: 100 },
	);
	assert.equal(emitted.length, count);
	assert.equal(new Set(emitted.map((item) => item.alertId)).size, count);
	assert.ok(
		state.seenAlertIds.length < MAX_SEEN_ALERT_IDS,
		'identities outside every overlap retired',
	);
	const again = await pollSentinelOne(
		tenant(alerts).request,
		triggerConfig,
		state,
		'scheduled',
		NOW + 60_000,
	);
	assert.deepEqual(again.items, []);
});

test('An overlap that needs more identities than the limit fails visibly instead of retiring them', async () => {
	const triggerConfig = config({ alertPageSize: 200, maxAlertPages: 60 });
	const count = MAX_SEEN_ALERT_IDS + 1;
	const alerts = Array.from({ length: count }, (_, index) =>
		alert(`alert-${index}`, NOW - 120_000 + index),
	);
	const first = await pollSentinelOne(
		tenant(alerts.slice(0, 12_000)).request,
		triggerConfig,
		legacyState(triggerConfig, NOW - 200_000),
		'scheduled',
		NOW,
	);
	assert.equal(first.items.length, 12_000);
	await assert.rejects(
		pollSentinelOne(
			tenant(alerts).request,
			triggerConfig,
			first.nextState,
			'scheduled',
			NOW + 60_000,
		),
		/exceeds the safe state limit.*state was not advanced/,
	);
});

test('Cursors follow scope membership: reordering scopes keeps them, and a changed batch starts where the slowest saved cursor stands', async () => {
	const scopeIds = Array.from(
		{ length: 501 },
		(_, index) => `account-${String(index).padStart(3, '0')}`,
	);
	const triggerConfig = config({ scopeIds, alertPageSize: 1, concurrentRequests: 1 });
	const alerts = [
		alert('first-scope', CHECKPOINT + 120_000, CHECKPOINT + 120_000, 'account-000'),
		alert('last-1', CHECKPOINT + 60_000, CHECKPOINT + 60_000, 'account-500'),
		alert('last-2', CHECKPOINT + 90_000, CHECKPOINT + 90_000, 'account-500'),
		alert('last-3', CHECKPOINT + 150_000, CHECKPOINT + 150_000, 'account-500'),
	];
	// The first batch completes in one page; the budget stops the second batch after its first alert.
	const first = await withClock(async (clock) => {
		const source = tenant(alerts, { pageCostMs: 6_000, clock });
		return await pollSentinelOne(
			source.budgeted(clock.start + 16_000),
			{ ...triggerConfig, pollDeadlineMs: clock.start + 16_000 },
			legacyState(triggerConfig),
			'scheduled',
			NOW,
		);
	});
	assert.deepEqual(ids(first).sort(), ['first-scope', 'last-1']);
	const cursors = Object.values(first.nextState.alertCursors)
		.map((cursor) => cursor.throughMs)
		.sort();
	assert.deepEqual(cursors, [CHECKPOINT + 60_000, NOW]);

	const reordered = config({
		scopeIds: [...scopeIds].reverse(),
		alertPageSize: 1,
		concurrentRequests: 1,
	});
	assert.equal(fingerprintConfig(reordered), fingerprintConfig(triggerConfig));
	const second = await pollSentinelOne(
		tenant(alerts).request,
		reordered,
		first.nextState,
		'scheduled',
		NOW,
	);
	assert.deepEqual(
		Object.keys(second.nextState.alertCursors).sort(),
		Object.keys(first.nextState.alertCursors).sort(),
	);
	assert.deepEqual(ids(second), ['last-2', 'last-3']);

	const grown = config({
		scopeIds: [...scopeIds, 'account-new'],
		allVisibleAccounts: true,
		alertPageSize: 1,
	});
	const grownState = { ...first.nextState, configFingerprint: fingerprintConfig(grown) };
	const source = tenant([
		...alerts,
		alert('new-scope', CHECKPOINT + 30_000, CHECKPOINT + 30_000, 'account-new'),
	]);
	const third = await pollSentinelOne(source.request, grown, grownState, 'scheduled', NOW);
	const changedBatch = source.state.requests.filter((request) =>
		request.body.variables.scope.scopeIds.includes('account-new'),
	);
	assert.ok(changedBatch.length > 0);
	assert.ok(
		changedBatch.every(
			(request) =>
				request.body.variables.filters[0].dateTimeRange.start === CHECKPOINT + 60_000 - 300_000,
		),
		'a batch with new membership starts at the slowest saved cursor',
	);
	assert.deepEqual(ids(third), ['new-scope', 'last-2', 'last-3']);
});

test('A budget stop with no progress fails after repeated stalls, and a descending page is a hard error', async () => {
	const triggerConfig = config();
	const previous = legacyState(triggerConfig);
	const snapshot = structuredClone(previous);
	let stalled = previous;
	for (let poll = 0; poll < 9; poll += 1) {
		const pollStart = NOW + poll * 60_000;
		const result = await pollSentinelOne(
			async () => {
				throw new PollBudgetError({ statusCode: 429 });
			},
			{ ...triggerConfig, pollDeadlineMs: pollStart + 60_000 },
			stalled,
			'scheduled',
			pollStart,
		);
		stalled = result.nextState;
	}
	assert.equal(Object.values(stalled.stalledAlertPolls)[0], 9);
	await assert.rejects(
		pollSentinelOne(
			async () => {
				throw new PollBudgetError({ statusCode: 429 });
			},
			{ ...triggerConfig, pollDeadlineMs: NOW + 9 * 60_000 + 60_000 },
			stalled,
			'scheduled',
			NOW + 9 * 60_000,
		),
		new RegExp(
			`createdAt stream in scope batch 1 remained stalled at ${iso(CHECKPOINT)} for 10 polls.*HTTP 429.*state was not advanced`,
		),
	);
	assert.deepEqual(previous, snapshot);
	await assert.rejects(
		pollSentinelOne(
			tenant(backlog, { ignoreSortOrder: true }).request,
			{ ...triggerConfig, pollDeadlineMs: Date.now() + 60_000 },
			previous,
			'scheduled',
			NOW,
		),
		/out of ascending order/,
	);
	assert.deepEqual(previous, snapshot);
});

test('Under a budget a read pages past the manual page cap until the budget stops it, and a dense overlap re-read resumes where it stopped instead of restarting', async () => {
	const triggerConfig = config({ maxAlertPages: 1, alertPageSize: 200 });
	const cursor = NOW - 600_000;
	// 15,000 distinct timestamps inside the overlap before a completed cursor, then two alerts past it.
	const dense = Array.from({ length: 15_000 }, (_, index) =>
		alert(`dense-${String(index).padStart(5, '0')}`, cursor - 300_000 + index * 20),
	);
	const alerts = [...dense, alert('after-1', cursor + 60_000), alert('after-2', NOW - 30_000)];
	const seeded = await pollSentinelOne(
		tenant([]).request,
		triggerConfig,
		legacyState(triggerConfig, cursor - 1),
		'scheduled',
		cursor,
	);
	const {
		emitted,
		state: final,
		polls,
	} = await drain(triggerConfig, seeded.nextState, alerts, {
		budgetMs: 20_000,
		pageCostMs: 600,
	});
	assert.deepEqual(
		emitted.map((item) => item.alertId),
		alerts.map((row) => row.id),
	);
	assert.equal(final.checkpointMs, NOW);
	assert.ok(polls >= 3 && polls <= 6, `${polls} polls, each reading about 30 pages`);
});

test('A budget stop in one scope batch preserves progress from batches that were reached', async () => {
	const scopeIds = Array.from({ length: 2_501 }, (_, index) => `account-${index}`);
	const triggerConfig = config({
		scopeIds,
		concurrentRequests: 1,
		alertPageSize: 1,
		pollDeadlineMs: Date.now() + 5_000,
	});
	const alerts = Array.from({ length: 6 }, (_, index) =>
		alert(`batch-${index}`, CHECKPOINT + 60_000 + index * 60_000, undefined, scopeIds[index * 500]),
	);
	const result = await drain(triggerConfig, legacyState(triggerConfig), alerts, {
		budgetMs: 5_000,
		pageCostMs: 1_200,
		maxPolls: 8,
	});
	assert.deepEqual(
		result.emitted.map((item) => item.alertId).sort(),
		alerts.map((row) => row.id).sort(),
	);
	assert.equal(new Set(result.emitted.map((item) => item.alertId)).size, alerts.length);
	assert.equal(result.state.checkpointMs, NOW);
});

test('Budgeted alert polling drains an 8,000 alert storm with fixed page latency in bounded work', async () => {
	const triggerConfig = config({ events: ['alert.new'], alertPageSize: 100, maxAlertPages: 1 });
	const start = NOW - 60_000;
	const alerts = Array.from({ length: 8_000 }, (_, index) =>
		alert(`fixed-${String(index).padStart(5, '0')}`, start + Math.floor((index * 60_000) / 7_999)),
	);
	const seeded = await pollSentinelOne(
		tenant([]).request,
		triggerConfig,
		legacyState(triggerConfig, start - 1),
		'scheduled',
		start,
	);
	const result = await drain(triggerConfig, seeded.nextState, alerts, {
		budgetMs: 5_000,
		pageCostMs: 400,
		maxPolls: 12,
	});
	assert.deepEqual(
		result.emitted.map((item) => item.alertId),
		alerts.map((row) => row.id),
	);
	assert.equal(new Set(result.emitted.map((item) => item.alertId)).size, alerts.length);
	assert.ok(result.polls <= 12);
	assert.ok(result.requestCount <= 8_000 / 100 + result.polls * 2);
});

test('Budgeted alert polling drains an 8,000 alert storm with jittered page latency in bounded work', async () => {
	const triggerConfig = config({ events: ['alert.new'], alertPageSize: 100, maxAlertPages: 1 });
	const start = NOW - 60_000;
	const alerts = Array.from({ length: 8_000 }, (_, index) =>
		alert(`jitter-${String(index).padStart(5, '0')}`, start + Math.floor((index * 60_000) / 7_999)),
	);
	const seeded = await pollSentinelOne(
		tenant([]).request,
		triggerConfig,
		legacyState(triggerConfig, start - 1),
		'scheduled',
		start,
	);
	const result = await drain(triggerConfig, seeded.nextState, alerts, {
		budgetMs: 5_000,
		pageCostMs: (page) => 200 + ((page * 173) % 600),
		maxPolls: 12,
	});
	assert.deepEqual(
		result.emitted.map((item) => item.alertId),
		alerts.map((row) => row.id),
	);
	assert.equal(new Set(result.emitted.map((item) => item.alertId)).size, alerts.length);
	assert.ok(result.polls <= 12);
	assert.ok(result.requestCount <= 8_000 / 100 + result.polls * 2);
});

test('Budgeted alert reads stop at seen-state capacity and save the last handled position', async () => {
	const createdConfig = config({
		events: ['alert.new'],
		pollDeadlineMs: Date.now() + 60_000,
	});
	const createdAlerts = Array.from({ length: MAX_SEEN_ALERT_IDS + 1 }, (_, index) =>
		alert(`capacity-new-${index}`, CHECKPOINT + index + 1),
	);
	const created = await pollSentinelOne(
		tenant(createdAlerts).request,
		createdConfig,
		legacyState(createdConfig),
		'scheduled',
		NOW,
	);
	assert.equal(created.items.length, MAX_SEEN_ALERT_IDS);
	assert.equal(created.nextState.seenAlertIds.length, MAX_SEEN_ALERT_IDS);
	assert.equal(
		created.nextState.alertCursors[Object.keys(created.nextState.alertCursors)[0]].resumeMs,
		CHECKPOINT + MAX_SEEN_ALERT_IDS,
	);

	const updatedConfig = config({
		events: ['alert.updated'],
		pollDeadlineMs: Date.now() + 60_000,
	});
	const updatedAlerts = Array.from({ length: MAX_SEEN_ALERT_VERSIONS + 1 }, (_, index) =>
		alert(`capacity-updated-${index}`, CHECKPOINT - 60_000, iso(CHECKPOINT + index + 1)),
	);
	const updated = await pollSentinelOne(
		tenant(updatedAlerts).request,
		updatedConfig,
		legacyState(updatedConfig),
		'scheduled',
		NOW,
	);
	assert.equal(updated.items.length, MAX_SEEN_ALERT_VERSIONS);
	assert.equal(updated.nextState.seenAlertVersions.length, MAX_SEEN_ALERT_VERSIONS);
	assert.equal(
		updated.nextState.alertCursors[Object.keys(updated.nextState.alertCursors)[0]].resumeMs,
		CHECKPOINT + MAX_SEEN_ALERT_VERSIONS,
	);
});

test('Budgeted scope batches reserve the last seen-state slot for the oldest alert regardless of response timing', async () => {
	const scopeIds = Array.from({ length: 501 }, (_, index) => `scope-${index}`);
	const triggerConfig = config({
		events: ['alert.new'],
		scopeIds,
		pollDeadlineMs: Date.now() + 60_000,
		alertPageSize: 10,
	});
	const seeded = {
		...legacyState(triggerConfig),
		seenAlertIds: Array.from(
			{ length: MAX_SEEN_ALERT_IDS - 1 },
			(_, index) => `prior-${index}\u0000${iso(NOW - 30_000)}`,
		),
	};
	const alerts = [
		alert('older-batch-alert', NOW - 20_000, undefined, 'scope-0'),
		alert('newer-batch-alert', NOW - 10_000, undefined, 'scope-500'),
	];
	const poll = async (olderDelay, newerDelay) => {
		const source = tenant(alerts);
		const request = async (options) => {
			const firstScope = options.body.variables.scope.scopeIds[0];
			await new Promise((resolve) =>
				setTimeout(resolve, firstScope === 'scope-0' ? olderDelay : newerDelay),
			);
			return await source.request(options);
		};
		return await pollSentinelOne(request, triggerConfig, seeded, 'scheduled', NOW);
	};
	const slowerOlder = await poll(25, 0);
	const fasterOlder = await poll(0, 25);
	for (const result of [slowerOlder, fasterOlder]) {
		assert.deepEqual(events(result), [['alert.new', 'older-batch-alert']]);
		assert.ok(
			result.nextState.seenAlertIds.some((entry) => entry.startsWith('older-batch-alert\u0000')),
		);
		assert.ok(
			!result.nextState.seenAlertIds.some((entry) => entry.startsWith('newer-batch-alert\u0000')),
		);
	}
	assert.deepEqual(slowerOlder.nextState.alertCursors, fasterOlder.nextState.alertCursors);
	assert.deepEqual(slowerOlder.nextState.seenAlertIds, fasterOlder.nextState.seenAlertIds);

	const repeat = await pollSentinelOne(
		tenant(alerts).request,
		triggerConfig,
		slowerOlder.nextState,
		'scheduled',
		NOW + 1_000,
	);
	assert.deepEqual(repeat.items, []);
	assert.ok(
		Object.values(repeat.nextState.alertCursors).some((cursor) => cursor.throughMs === NOW + 1_000),
	);
});

test('Updated waits when seen-state capacity holds back the alert New row', async () => {
	const triggerConfig = config({
		events: ['alert.new', 'alert.updated'],
		scopeIds: Array.from({ length: 501 }, (_, index) => `scope-${String(index).padStart(3, '0')}`),
		pollDeadlineMs: Date.now() + 60_000,
		alertPageSize: 10,
	});
	const seeded = {
		...legacyState(triggerConfig),
		seenAlertIds: Array.from(
			{ length: MAX_SEEN_ALERT_IDS - 1 },
			(_, index) => `prior-${index}\u0000${iso(NOW - 30_000)}`,
		),
	};
	const alerts = [
		alert('older-batch-alert', NOW - 20_000, undefined, 'scope-000'),
		alert('newer-batch-alert', NOW - 10_000, NOW - 5_000, 'scope-500'),
	];
	const source = tenant(alerts);
	const result = await pollSentinelOne(source.request, triggerConfig, seeded, 'scheduled', NOW);
	assert.deepEqual(events(result), [['alert.new', 'older-batch-alert']]);
	assert.ok(
		!result.nextState.seenAlertVersions.some((entry) =>
			entry.startsWith('newer-batch-alert\u0000'),
		),
	);
	assert.equal(
		Object.values(result.nextState.alertCursors).filter((cursor) => cursor.throughMs === CHECKPOINT)
			.length,
		2,
		'the newer batch cursors stay before the alert whose New row did not fit',
	);
});

test('Updated-only polling reads the updatedAt stream without querying createdAt', async () => {
	const triggerConfig = config({
		events: ['alert.updated'],
		pollDeadlineMs: Date.now() + 60_000,
	});
	const source = tenant(backlog);
	await pollSentinelOne(
		source.request,
		triggerConfig,
		legacyState(triggerConfig),
		'scheduled',
		NOW,
	);
	assert.deepEqual(
		[...new Set(source.state.requests.map((request) => request.body.variables.sortBy))],
		['updatedAt'],
	);
});

test('New is delivered before a later Updated event for the same alert', async () => {
	const triggerConfig = config({
		events: ['alert.new', 'alert.updated'],
		alertPageSize: 1,
		pollDeadlineMs: Date.now() + 60_000,
	});
	const created = CHECKPOINT + 60_000;
	let alerts = [alert('Z', created), alert('A', created + 60_000, NOW - 60_000)];
	const firstSource = tenant(alerts);
	let createdRequests = 0;
	const first = await pollSentinelOne(
		async (options) => {
			if (options.body.variables.sortBy === 'createdAt' && ++createdRequests > 1)
				throw new PollBudgetError({ statusCode: 429 });
			return await firstSource.request(options);
		},
		triggerConfig,
		legacyState(triggerConfig),
		'scheduled',
		NOW,
	);
	assert.deepEqual(events(first), [['alert.new', 'Z']]);
	const second = await pollSentinelOne(
		tenant(alerts).request,
		{ ...triggerConfig, pollDeadlineMs: Date.now() + 60_000 },
		first.nextState,
		'scheduled',
		NOW + 1,
	);
	assert.deepEqual(events(second), [['alert.new', 'A']]);
	alerts = alerts.map((row) => (row.id === 'A' ? { ...row, updatedAt: iso(NOW + 30_000) } : row));
	const third = await pollSentinelOne(
		tenant(alerts).request,
		{ ...triggerConfig, pollDeadlineMs: Date.now() + 60_000 },
		second.nextState,
		'scheduled',
		NOW + 60_000,
	);
	assert.deepEqual(events(third), [['alert.updated', 'A']]);
});

test('Seen identities retire by their own stream: created ids follow the slowest created cursor and versions the slowest updated cursor', async () => {
	const triggerConfig = config({ events: ['alert.new', 'alert.updated'], alertPageSize: 1 });
	const created = CHECKPOINT + 60_000;
	const alerts = [
		alert('A', created, NOW - 1_200_000),
		alert('B', CHECKPOINT + 120_000),
		alert('C', CHECKPOINT + 180_000),
	];
	const result = await withClock(async (clock) => {
		// The created stream stops after one page, so Updated cannot pass its completed boundary.
		const source = tenant(alerts, { clock, pageCostMs: 5_000 });
		const createdDeadline = source.budgeted(clock.start + 6_000);
		return await pollSentinelOne(
			async (options) => {
				if (options.body.variables.sortBy === 'updatedAt') return await source.request(options);
				return await createdDeadline(options);
			},
			{ ...triggerConfig, pollDeadlineMs: clock.start + 60_000 },
			legacyState(triggerConfig),
			'scheduled',
			NOW,
		);
	});
	const cursors = Object.values(result.nextState.alertCursors)
		.map((cursor) => cursor.throughMs)
		.sort();
	assert.deepEqual(cursors, [created - 1, created]);
	assert.deepEqual(
		result.nextState.seenAlertIds.map((entry) => entry.split('\u0000')[0]),
		['A'],
	);
	assert.deepEqual(
		result.nextState.seenAlertVersions,
		[`A\u0000${iso(NOW - 1_200_000)}`],
		'a version stays retained while Updated is capped behind the created cursor',
	);
});

test('An alert created before activation but revised after it is still emitted as Updated', async () => {
	const triggerConfig = config({ events: ['alert.new', 'alert.updated'], alertPageSize: 1 });
	const activation = NOW;
	const alerts = [
		alert('old-1', activation - 290_000),
		alert('old-2', activation - 280_000),
		alert('X', activation - 100_000),
	];
	const first = await withClock(async (clock) => {
		const source = tenant(alerts, { pageCostMs: 6_000, clock });
		return await pollSentinelOne(
			source.budgeted(clock.start + 14_000),
			{ ...triggerConfig, pollDeadlineMs: clock.start + 14_000 },
			{},
			'scheduled',
			activation,
		);
	});
	assert.deepEqual(first.items, []);
	assert.ok(
		!first.nextState.seenAlertIds.some((entry) => entry.startsWith('X')),
		'the baseline stopped before X',
	);
	const revised = alerts.map((row) =>
		row.id === 'X' ? { ...row, updatedAt: iso(activation + 30_000) } : row,
	);
	const second = await pollSentinelOne(
		tenant(revised).request,
		triggerConfig,
		first.nextState,
		'scheduled',
		activation + 60_000,
	);
	assert.deepEqual(events(second), [['alert.updated', 'X']]);
});

test('A regrouped batch starts from the slowest saved cursor and can never save an earlier one', async () => {
	const scopeIds = Array.from(
		{ length: 501 },
		(_, index) => `account-${String(index).padStart(3, '0')}`,
	);
	const lagging = CHECKPOINT + 600_000;
	const triggerConfig = config({
		scopeIds: [...scopeIds, 'account-new'],
		allVisibleAccounts: true,
		alertPageSize: 1,
	});
	const state = {
		...legacyState(triggerConfig),
		alertCursors: {
			'createdAt:fast': { throughMs: NOW - 60_000, ids: [] },
			'createdAt:slow': { throughMs: lagging, ids: [] },
		},
	};
	delete state.checkpointMs;
	const overlapAlerts = [
		alert('late-1', lagging - 200_000, lagging - 200_000, 'account-new'),
		alert('late-2', lagging - 100_000, lagging - 100_000, 'account-new'),
		alert('fresh', NOW - 30_000, NOW - 30_000, 'account-new'),
	];
	const first = await withClock(async (clock) => {
		const source = tenant(overlapAlerts, { pageCostMs: 6_000, clock });
		return await pollSentinelOne(
			source.budgeted(clock.start + 14_000),
			{ ...triggerConfig, pollDeadlineMs: clock.start + 14_000, concurrentRequests: 1 },
			state,
			'scheduled',
			NOW,
		);
	});
	assert.deepEqual(ids(first), ['late-1']);
	const cursors = Object.values(first.nextState.alertCursors);
	assert.ok(
		cursors.every((cursor) => cursor.throughMs >= lagging),
		'no cursor below the slowest saved one',
	);
	assert.ok(
		cursors.some((cursor) => cursor.resumeMs === lagging - 200_000),
		'the overlap re-read resumes where it stopped',
	);
	const second = await pollSentinelOne(
		tenant(overlapAlerts).request,
		triggerConfig,
		first.nextState,
		'scheduled',
		NOW,
	);
	assert.deepEqual(ids(second), ['late-2', 'fresh']);
});

test('A first-ever rate-limited stream records stalls and fails visibly after ten polls', async () => {
	const triggerConfig = config();
	let state = {};
	for (let poll = 0; poll < 9; poll += 1) {
		const pollStart = NOW + poll * 60_000;
		const result = await pollSentinelOne(
			async () => {
				throw new PollBudgetError({ statusCode: 429 });
			},
			{ ...triggerConfig, pollDeadlineMs: pollStart + 60_000 },
			state,
			'scheduled',
			pollStart,
		);
		state = result.nextState;
	}
	assert.deepEqual(Object.values(state.stalledAlertPolls), [9]);
	await assert.rejects(
		pollSentinelOne(
			async () => {
				throw new PollBudgetError({ statusCode: 429 });
			},
			{ ...triggerConfig, pollDeadlineMs: NOW + 9 * 60_000 + 60_000 },
			state,
			'scheduled',
			NOW + 9 * 60_000,
		),
		/createdAt stream in scope batch 1 remained stalled at .*for 10 polls.*HTTP 429/,
	);
});

test('Transport results are unchanged without a deadline and with an ample one', async () => {
	const error = { retryable: false };
	assert.deepEqual(
		await requestWithRetry(async () => {
			throw error;
		}),
		{ ok: false, error },
	);
	let attempts = 0;
	const result = await requestWithRetry(
		async () => {
			if (++attempts < 2) throw { retryable: true, retryAfterMs: 1 };
			return 'ok';
		},
		{ deadline: Date.now() + 60_000 },
	);
	assert.deepEqual(result, { ok: true, value: 'ok' });
	assert.equal(attempts, 2);
});

test('Each attempt timeout is capped to the remaining budget and nothing starts after it', async () => {
	const timeouts = [];
	const result = await requestWithRetry(
		async (timeoutMs) => {
			timeouts.push(timeoutMs);
			return 'ok';
		},
		{ timeoutMs: 30_000, deadline: Date.now() + 5_000 },
	);
	assert.equal(result.ok, true);
	assert.ok(timeouts[0] <= 5_000 && timeouts[0] > 0);

	let sent = false;
	const spent = await requestWithRetry(
		async () => {
			sent = true;
		},
		{ deadline: Date.now() - 1 },
	);
	assert.equal(sent, false);
	assert.ok(spent.error instanceof PollBudgetError);
});

test('A Retry-After that ends past the deadline is a budget stop for every retry owner, while a permission failure after the deadline stays a permission failure', async () => {
	await withClock(({ start, advance }) =>
		(async () => {
			let attempts = 0;
			const blocked = await requestWithRetry(
				async () => {
					attempts++;
					throw { retryable: true, retryAfterMs: 20_000, statusCode: 429 };
				},
				{ deadline: start + 1_000 },
			);
			assert.equal(attempts, 1);
			assert.ok(blocked.error instanceof PollBudgetError);
			assert.equal(blocked.error.blockedStatus, 429);
			assert.match(blocked.error.message, /HTTP 429/);

			// A single-attempt inner request under an outer retry loop: the inner reports the stop, so the outer neither sleeps nor retries.
			let outerAttempts = 0;
			const outer = await requestWithRetry(
				async () => {
					outerAttempts++;
					const inner = await requestWithRetry(
						async () => {
							throw { retryable: true, retryAfterMs: 20_000, statusCode: 429 };
						},
						{ attempts: 1, deadline: start + 10_000 },
					);
					throw inner.error;
				},
				{ timeoutMs: 30_000 },
			);
			assert.equal(outerAttempts, 1);
			assert.ok(outer.error instanceof PollBudgetError);
			assert.equal(Date.now(), start, 'no backoff sleep ran');

			const denied = { statusCode: 401, retryable: false };
			const late = await requestWithRetry(
				async () => {
					advance(2_000);
					throw denied;
				},
				{ deadline: start + 1_000 },
			);
			assert.equal(late.error, denied);
		})(),
	);
});

function nodeContext(request, budgetMs) {
	const staticData = {};
	const context = {
		staticData,
		logger: { debug: () => {}, info: () => {}, warn: () => {} },
		helpers: {
			httpRequestWithAuthentication: async (_credential, options) => await request(options),
			returnJsonArray: (items) => items.map((json) => ({ json })),
		},
		getCredentials: async () => ({ baseUrl: 'https://tenant.example' }),
		getMode: () => 'trigger',
		getNode: () => ({
			id: 'node-1',
			credentials: { sentinelOnePlatformApi: { id: 'credential-1' } },
		}),
		getNodeParameter: (name, fallback) =>
			({ resource: 'alert', operation: 'new', options: {} })[name] ?? fallback,
		getWorkflowStaticData: () => staticData,
		getWorkflow: () => ({ id: 'workflow-1' }),
	};
	if (budgetMs !== undefined) context.getPollBudgetMs = () => budgetMs;
	return context;
}

function withAccounts(graphQl) {
	return async (options) =>
		options.method === 'GET'
			? { data: [{ id: 'account-1', name: 'Account One' }], pagination: { nextCursor: null } }
			: await graphQl(options);
}

test('The node passes its host budget to the transport, stops at it, and a host without a budget resumes the backlog', async () => {
	const node = new SentinelOnePlatformTrigger();
	const alerts = [
		alert('A', CHECKPOINT + 60_000),
		alert('B', CHECKPOINT + 120_000),
		alert('C', CHECKPOINT + 180_000),
	];
	const seeded = nodeContext(withAccounts(tenant([]).request));
	await node.poll.call(seeded);
	Object.assign(seeded.staticData.sentinelOneTrigger, {
		checkpointMs: CHECKPOINT,
		alertCursors: undefined,
		activationMs: undefined,
	});

	const first = await withClock(async (clock) => {
		const source = tenant(alerts, { pageCostMs: 1_000, clock });
		const budgeted = nodeContext(
			withAccounts(async (options) => {
				assert.ok(options.timeout <= 30_000);
				return await source.request({
					...options,
					body: { ...options.body, variables: { ...options.body.variables, first: 1 } },
				});
			}),
			2_500,
		);
		Object.assign(budgeted.staticData, seeded.staticData);
		const output = await node.poll.call(budgeted);
		return { output, state: budgeted.staticData };
	});
	assert.deepEqual(
		first.output[0].map((item) => item.json.alertId),
		['A', 'B'],
	);
	assert.equal(first.state.sentinelOneTrigger.checkpointMs, CHECKPOINT + 120_000);

	const legacyHost = nodeContext(withAccounts(tenant(alerts).request));
	Object.assign(legacyHost.staticData, first.state);
	const second = await node.poll.call(legacyHost);
	assert.deepEqual(
		second[0].map((item) => item.json.alertId),
		['C'],
	);
});

test('A permission failure that arrives after the budget passes surfaces as denied access, and a rate-limited scope load names the rate limit', async () => {
	const node = new SentinelOnePlatformTrigger();
	await withClock(async ({ advance }) => {
		const context = nodeContext(
			withAccounts(async () => {
				advance(5_000);
				throw { statusCode: 403, retryable: false };
			}),
			1_000,
		);
		context.staticData.sentinelOneTrigger = legacyState(config());
		await assert.rejects(node.poll.call(context), /denied access/);
		assert.equal(context.staticData.sentinelOneTrigger.checkpointMs, CHECKPOINT);
	});
	const limited = nodeContext(async () => {
		throw { statusCode: 429, retryable: true, retryAfterMs: 60_000 };
	}, 1_000);
	await assert.rejects(node.poll.call(limited), /poll time budget ran out \(HTTP 429/);
});

const activityConfig = (extra = {}) =>
	config({
		credentialIdentity: { id: 'c' },
		scopeIds: ['a'],
		events: ['alert.activity'],
		...extra,
	});
const activityState = (c, checkpoint) => ({
	configFingerprint: fingerprintConfig(c) + ':sdl-activities-v1',
	initialized: true,
	checkpointMs: checkpoint,
	activityActivationMs: checkpoint - 1000,
	seenActivityIds: [],
	seenActivityTimestamps: {},
});
const activity = (id, timeNs, alertId = 'alert-1') => ({
	timestamp: String(timeNs),
	values: {
		activity_id: id,
		activity_type: '16007',
		created_at: iso(Number(BigInt(timeNs) / 1000000n)),
		'data.alert.id': alertId,
		'data.payload.note_text': 'note',
	},
});
const parentAlert = (id = 'alert-1') => ({
	id,
	name: 'Alert',
	severity: 'HIGH',
	status: 'NEW',
	realTime: { scope: { account: { id: 'a', name: 'Account' } } },
});
const alertPage = (alerts) => ({
	data: { alerts: { edges: alerts.map((node) => ({ node })), pageInfo: { hasNextPage: false } } },
});
const feedWindow = (matches) => ({
	id: 'query',
	stepsCompleted: 1,
	stepsTotal: 1,
	data: { matches },
});
const feedFor = (activities) => (options) => {
	const body = JSON.parse(options.body);
	const start = BigInt(Date.parse(body.startTime)) * 1000000n;
	const end = BigInt(Date.parse(body.endTime)) * 1000000n;
	return feedWindow(
		activities.filter((row) => BigInt(row.timestamp) >= start && BigInt(row.timestamp) < end),
	);
};

test('A lookup the budget cuts short delivers every activity before the first one still waiting, including ones in its millisecond, and the next poll starts past them', async () => {
	const checkpoint = NOW - 3600_000;
	const c = activityConfig({ pollDeadlineMs: Date.now() + 60_000 });
	const sameMs = BigInt(checkpoint + 1_000) * 1000000n;
	const activities = Array.from({ length: 401 }, (_, index) =>
		activity(`activity-${index}`, sameMs + BigInt(index), `alert-${index}`),
	);
	let lookups = 0;
	const request = async (options) => {
		if (!options.url.includes('/sdl/')) {
			if (++lookups === 2) throw new PollBudgetError();
			return alertPage(
				options.body.variables.filters[0].stringIn.values.map((id) => parentAlert(id)),
			);
		}
		return feedFor(activities)(options);
	};
	const first = await pollAlertActivities(
		request,
		c,
		activityState(c, checkpoint),
		'scheduled',
		NOW,
	);
	assert.equal(first.items.length, 200);
	assert.equal(first.nextState.checkpointMs, checkpoint + 1_000);
	lookups = 0;
	const second = await pollAlertActivities(request, c, first.nextState, 'scheduled', NOW);
	assert.deepEqual(
		second.items.map((item) => item.activityId),
		activities.slice(200, 400).map((row) => row.values.activity_id),
	);
	lookups = -1;
	const third = await pollAlertActivities(request, c, second.nextState, 'scheduled', NOW);
	assert.deepEqual(
		third.items.map((item) => item.activityId),
		['activity-400'],
	);
	assert.equal(third.nextState.checkpointMs, NOW);
});

test('A lookup cut short before its first batch fails loudly on the second attempt without advancing activity state', async () => {
	const checkpoint = NOW - 3600_000;
	const c = activityConfig({ pollDeadlineMs: Date.now() + 60_000 });
	const request = async (options) => {
		if (!options.url.includes('/sdl/')) throw new PollBudgetError();
		const end = Date.parse(JSON.parse(options.body).endTime);
		return feedWindow([activity('first', BigInt(end - 1) * 1000000n)]);
	};
	const first = await pollAlertActivities(
		request,
		c,
		activityState(c, checkpoint),
		'scheduled',
		NOW,
	);
	assert.deepEqual(first.items, []);
	const previous = first.nextState;
	const snapshot = structuredClone(previous);
	await assert.rejects(
		pollAlertActivities(request, c, previous, 'scheduled', NOW),
		/poll time budget.*current alert lookup.*state was not advanced/,
	);
	assert.deepEqual(previous, snapshot);
});

test('An activity baseline the budget cuts short saves its completed slices and activation, resumes silently, and never replays pre-activation activity', async () => {
	const c = activityConfig({ pollDeadlineMs: Date.now() + 60_000 });
	const activation = NOW;
	const old = activity('old', BigInt(activation - 200_000) * 1000000n);
	const fresh = activity('fresh', BigInt(activation + 30_000) * 1000000n);
	// The whole baseline window saturates and splits; the older half completes and the budget stops the newer half.
	const first = await pollAlertActivities(
		async (options) => {
			if (options.method === 'DELETE') return {};
			const body = JSON.parse(options.body);
			const start = Date.parse(body.startTime);
			const end = Date.parse(body.endTime);
			if (end - start > 150_000)
				return feedWindow(
					Array.from({ length: 1000 }, (_, index) =>
						activity(`dense-${index}`, BigInt(start) * 1000000n + BigInt(index)),
					),
				);
			if (start > activation - 200_000) throw new PollBudgetError();
			return feedWindow([old]);
		},
		c,
		{},
		'scheduled',
		activation,
	);
	assert.deepEqual(first.items, []);
	assert.equal(first.nextState.activityActivationMs, activation);
	assert.equal(first.nextState.checkpointMs, activation - 150_000);
	const feed = async (options) =>
		options.url.includes('/sdl/') ? feedFor([old, fresh])(options) : alertPage([parentAlert()]);
	const second = await pollAlertActivities(
		feed,
		c,
		first.nextState,
		'scheduled',
		activation + 60_000,
	);
	assert.deepEqual(
		second.items.map((item) => item.activityId),
		['fresh'],
	);
	const third = await pollAlertActivities(
		feed,
		c,
		second.nextState,
		'scheduled',
		activation + 120_000,
	);
	assert.deepEqual(third.items, []);
});

test('Rate limits that reach the feed deadline end the read at its completed windows, while a permission failure still fails it', async () => {
	const checkpoint = NOW - 3600_000;
	const run = async (failure) => {
		const c = activityConfig({ pollDeadlineMs: Date.now() + 60_000 });
		let launches = 0;
		let time = 0;
		return await pollAlertActivities(
			async (options) => {
				if (!options.url.includes('/sdl/')) return alertPage([parentAlert()]);
				if (options.method === 'GET') {
					time += 1_000;
					throw failure;
				}
				if (options.method === 'DELETE') return {};
				const end = Date.parse(JSON.parse(options.body).endTime);
				if (++launches > 1) return { id: 'query', stepsCompleted: 0, stepsTotal: 1 };
				return feedWindow([activity('first-window', BigInt(end - 1) * 1000000n)]);
			},
			c,
			activityState(c, checkpoint),
			'scheduled',
			NOW,
			{ now: () => time, sleep: async () => {}, deadlineMs: 5_000, lifecycleMs: 5_000 },
		);
	};
	const stopped = await run({ statusCode: 429 });
	assert.deepEqual(
		stopped.items.map((item) => item.activityId),
		['first-window'],
	);
	assert.equal(stopped.nextState.checkpointMs, checkpoint + 300_000);
	await assert.rejects(run({ statusCode: 403 }), /permission denied/);
});
