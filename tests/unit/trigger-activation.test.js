const assert = require('node:assert/strict');
const test = require('node:test');
const {
	SentinelOnePlatformTrigger,
} = require('../../dist/nodes/SentinelOnePlatformTrigger/SentinelOnePlatformTrigger.node.js');

const START = Date.parse('2026-10-01T12:00:00Z');

function context(id, rows, { budget, operation = 'new', nodeId = 'node-1' } = {}) {
	const staticData = {};
	const requests = [];
	const warnings = [];
	const parameters = { resource: 'alert', operation, options: {} };
	return {
		staticData,
		requests,
		warnings,
		parameters,
		logger: {
			info() {},
			warn(message) {
				warnings.push(message);
			},
		},
		getCredentials: async () => ({ baseUrl: 'https://console.example' }),
		getMode: () => 'scheduled',
		getNode: () => ({
			id: nodeId,
			name: 'Trigger',
			credentials: { sentinelOnePlatformApi: { id: 'credential-1' } },
		}),
		getWorkflow: () => ({ id }),
		getNodeParameter: (name, fallback) => parameters[name] ?? fallback,
		getWorkflowStaticData: () => staticData,
		...(budget === undefined ? {} : { getPollBudgetMs: () => budget }),
		helpers: {
			returnJsonArray: (items) => items.map((json) => ({ json })),
			async httpRequestWithAuthentication(_credential, request) {
				requests.push(request);
				if (request.url.endsWith('/accounts'))
					return { data: [{ id: 'account-1', name: 'Example' }], pagination: { nextCursor: null } };
				const { sortBy, sortOrder, filters, after, first } = request.body.variables;
				assert.equal(sortOrder, 'ASC');
				const range = filters.find((filter) => filter.fieldId === sortBy).dateTimeRange;
				const excluded = filters.find((filter) => filter.fieldId === 'id')?.stringIn.values ?? [];
				const matches = rows
					.filter(
						(row) =>
							Date.parse(row[sortBy]) >= range.start &&
							Date.parse(row[sortBy]) <= range.end &&
							!excluded.includes(row.id),
					)
					.sort(
						(a, b) => Date.parse(a[sortBy]) - Date.parse(b[sortBy]) || a.id.localeCompare(b.id),
					);
				const offset = Number(after ?? 0);
				return {
					data: {
						alerts: {
							edges: matches.slice(offset, offset + first).map((node) => ({ node })),
							pageInfo: {
								hasNextPage: offset + first < matches.length,
								endCursor: String(offset + first),
							},
						},
					},
				};
			},
		},
	};
}

function row(id, time) {
	return {
		id,
		createdAt: new Date(time).toISOString(),
		updatedAt: new Date(time).toISOString(),
		name: 'Example',
		realTime: { scope: { account: { id: 'account-1' } } },
	};
}

async function at(time, run) {
	const saved = Date.now;
	Date.now = () => time;
	try {
		return await run();
	} finally {
		Date.now = saved;
	}
}

test('activation baseline survives discarded static data and ends when committed state is seen', async () => {
	const trigger = new SentinelOnePlatformTrigger();
	const rows = [];
	const activation = context('activation-persistence', rows);
	assert.equal(await at(START, () => trigger.poll.call(activation)), null);
	assert.equal(activation.staticData.sentinelOneTrigger.activationMs, START);
	rows.push(row('later/id', START + 20_000));
	const scheduled = context('activation-persistence', rows);
	const output = await at(START + 60_000, () => trigger.poll.call(scheduled));
	assert.equal(output[0][0].json.eventId, 'console.example/alert/later%2Fid/new');
	assert.equal(scheduled.staticData.sentinelOneTrigger.activationMs, START);
	const committed = context('activation-persistence', rows);
	committed.staticData.sentinelOneTrigger = structuredClone(
		scheduled.staticData.sentinelOneTrigger,
	);
	assert.equal(await at(START + 120_000, () => trigger.poll.call(committed)), null);
	// Once committed state was observed, a genuinely fresh state establishes a new baseline.
	const fresh = context('activation-persistence', rows);
	assert.equal(await at(START + 180_000, () => trigger.poll.call(fresh)), null);
	assert.equal(fresh.staticData.sentinelOneTrigger.activationMs, START + 180_000);
});

test('activation cache is keyed by workflow and node and replaces changed configurations', async () => {
	const trigger = new SentinelOnePlatformTrigger();
	await at(START, () => trigger.poll.call(context('activation-config', [])));
	const changed = context('activation-config', [], { operation: 'updated' });
	await at(START + 60_000, () => trigger.poll.call(changed));
	assert.equal(changed.staticData.sentinelOneTrigger.activationMs, START + 60_000);

	// Returning to the original fingerprint must not recover its older activation state.
	const returned = context('activation-config', []);
	await at(START + 120_000, () => trigger.poll.call(returned));
	assert.equal(returned.staticData.sentinelOneTrigger.activationMs, START + 120_000);

	const otherWorkflow = context('activation-other-workflow', []);
	await at(START + 180_000, () => trigger.poll.call(otherWorkflow));
	assert.equal(otherWorkflow.staticData.sentinelOneTrigger.activationMs, START + 180_000);
	const otherNode = context('activation-config', [], { nodeId: 'node-2' });
	await at(START + 240_000, () => trigger.poll.call(otherNode));
	assert.equal(otherNode.staticData.sentinelOneTrigger.activationMs, START + 240_000);
});

test('activation baseline expires after one hour', async () => {
	const trigger = new SentinelOnePlatformTrigger();
	await at(START, () => trigger.poll.call(context('activation-expiry', [])));
	const expired = context('activation-expiry', []);
	await at(START + 3_600_001, () => trigger.poll.call(expired));
	assert.equal(expired.staticData.sentinelOneTrigger.activationMs, START + 3_600_001);
});

test('empty scheduled polls refresh the pending activation baseline', async () => {
	const trigger = new SentinelOnePlatformTrigger();
	await at(START, () => trigger.poll.call(context('activation-refresh', [])));
	await at(START + 59 * 60_000, () => trigger.poll.call(context('activation-refresh', [])));
	const withinRefreshedTtl = context('activation-refresh', []);
	await at(START + 3_600_001, () => trigger.poll.call(withinRefreshedTtl));
	assert.equal(withinRefreshedTtl.staticData.sentinelOneTrigger.activationMs, START);
});

test('emitting polls do not refresh the pending activation baseline', async () => {
	const trigger = new SentinelOnePlatformTrigger();
	await at(START, () => trigger.poll.call(context('activation-emission', [])));
	const rows = [row('emitted-alert', START + 20_000)];
	const emitted = context('activation-emission', rows);
	const output = await at(START + 59 * 60_000, () => trigger.poll.call(emitted));
	assert.equal(output[0][0].json.eventId, 'console.example/alert/emitted-alert/new');
	assert.equal(emitted.staticData.sentinelOneTrigger.activationMs, START);
	const discarded = context('activation-emission', rows);
	const repeated = await at(START + 59 * 60_000 + 1000, () => trigger.poll.call(discarded));
	assert.equal(
		repeated[0][0].json.eventId,
		output[0][0].json.eventId,
		'an emitting poll must not advance the pending state',
	);

	// Model n8n discarding data from the null activation poll; the emitting poll does not
	// extend the in-memory entry, so it has expired one hour after activation.
	const afterExpiry = context('activation-emission', []);
	await at(START + 3_600_001, () => trigger.poll.call(afterExpiry));
	assert.equal(afterExpiry.staticData.sentinelOneTrigger.activationMs, START + 3_600_001);
});

test('overlapping poll warns and leaves state untouched', async () => {
	const trigger = new SentinelOnePlatformTrigger();
	const first = context('activation-overlap', []);
	let release;
	let entered;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const started = new Promise((resolve) => {
		entered = resolve;
	});
	const send = first.helpers.httpRequestWithAuthentication;
	first.helpers.httpRequestWithAuthentication = async (...args) => {
		entered();
		await gate;
		return send(...args);
	};
	const active = at(START, () => trigger.poll.call(first));
	await started;
	const overlap = context('activation-overlap', []);
	assert.equal(await trigger.poll.call(overlap), null);
	assert.deepEqual(overlap.staticData, {});
	assert.equal(overlap.requests.length, 0);
	assert.match(overlap.warnings[0], /overlapping poll/);
	release();
	await active;
});

test('hosts without getPollBudgetMs use a five-minute deadline', async () => {
	const trigger = new SentinelOnePlatformTrigger();
	const activation = context('activation-fallback', []);
	await at(START, () => trigger.poll.call(activation));
	const rows = Array.from({ length: 5_001 }, (_, index) =>
		row(`alert-${String(index).padStart(5, '0')}`, START + 10_000 + index),
	);
	const olderHost = context('activation-fallback', rows);
	olderHost.staticData.sentinelOneTrigger = structuredClone(
		activation.staticData.sentinelOneTrigger,
	);
	const send = olderHost.helpers.httpRequestWithAuthentication;
	let elapsed = 0;
	const realNow = Date.now;
	Date.now = () => START + 60_000 + elapsed;
	olderHost.helpers.httpRequestWithAuthentication = async (...args) => {
		const result = await send(...args);
		if (args[1].body?.query) elapsed += 15_000;
		return result;
	};
	try {
		const result = await trigger.poll.call(olderHost);
		assert.equal(elapsed, 300_000);
		assert.equal(result[0].length, 4_000);
		assert.ok(Object.values(olderHost.staticData.sentinelOneTrigger.alertCursors)[0].resumeMs);
	} finally {
		Date.now = realNow;
	}
});

test('activity HTTP failures reach the node boundary with status and retry metadata', async () => {
	const { NodeApiError } = require('n8n-workflow');
	const trigger = new SentinelOnePlatformTrigger();
	for (const statusCode of [401, 403, 404, 429, 503]) {
		const activity = context(`activation-activity-error-${statusCode}`, [], { budget: 36_000 });
		activity.parameters.resource = 'alertActivity';
		activity.parameters.operation = 'occurred';
		activity.parameters.activityTypes = ['any'];
		const send = activity.helpers.httpRequestWithAuthentication;
		activity.helpers.httpRequestWithAuthentication = async (credential, request) => {
			if (request.url.includes('/sdl/')) throw { statusCode, headers: { 'retry-after': '60' } };
			return send(credential, request);
		};
		await assert.rejects(
			at(START, () => trigger.poll.call(activity)),
			(error) => {
				assert.ok(error instanceof NodeApiError);
				assert.equal(error.httpCode, String(statusCode));
				assert.equal(error.statusCode, statusCode);
				assert.equal(error.retryAfterMs, 60_000);
				assert.deepEqual(activity.staticData, {});
				return true;
			},
		);
	}
});

test('SDL requests reaching the reserved reader deadline hand over a completed prefix and cancel the query', async () => {
	const trigger = new SentinelOnePlatformTrigger();
	const activities = [];
	const make = () => {
		const activity = context('activation-activity-deadline', [], { budget: 36_000 });
		Object.assign(activity.parameters, {
			resource: 'alertActivity',
			operation: 'occurred',
			activityTypes: ['any'],
		});
		const send = activity.helpers.httpRequestWithAuthentication;
		const cancelled = [];
		let queries = 0;
		activity.cancelled = cancelled;
		activity.helpers.httpRequestWithAuthentication = async (credential, request) => {
			if (request.url.includes('/sdl/')) {
				if (request.method === 'DELETE') {
					cancelled.push(request.url);
					return {};
				}
				if (request.method === 'GET') {
					elapsed += request.timeout;
					throw Object.assign(new Error(`timeout of ${request.timeout}ms exceeded`), {
						code: 'ECONNABORTED',
					});
				}
				const query = JSON.parse(request.body);
				const id = `query-${++queries}`;
				if (queries > 1) return { id, stepsCompleted: 0, stepsTotal: 1 };
				return {
					id,
					stepsCompleted: 1,
					stepsTotal: 1,
					data: {
						matches: activities
							.filter(
								(time) => time >= Date.parse(query.startTime) && time < Date.parse(query.endTime),
							)
							.map((time) => ({
								timestamp: String(BigInt(time) * 1000000n),
								values: {
									activity_id: 'activity-1',
									created_at: new Date(time).toISOString(),
									'data.alert.id': 'parent-1',
									activity_type: '16001',
									'dataSource.name': 'ActivityFeed',
								},
							})),
					},
				};
			}
			if (request.body?.variables && !request.body.variables.sortBy)
				return {
					data: {
						alerts: {
							edges: [
								{
									node: {
										id: 'parent-1',
										name: 'Example',
										realTime: { scope: { account: { id: 'account-1' } } },
									},
								},
							],
							pageInfo: { hasNextPage: false },
						},
					},
				};
			return send(credential, request);
		};
		return activity;
	};
	let elapsed = 0;
	const activation = make();
	assert.equal(await at(START, () => trigger.poll.call(activation)), null);
	activities.push(START + 10_000);
	const scheduled = make();
	const realNow = Date.now;
	Date.now = () => START + 3_600_000 + elapsed;
	try {
		const output = await trigger.poll.call(scheduled);
		assert.equal(output[0][0].json.eventId, 'console.example/alert/parent-1/activity/activity-1');
		assert.equal(scheduled.staticData.sentinelOneTrigger.activityActivationMs, START);
		assert.equal(scheduled.cancelled.length, 2);
		assert.equal(elapsed, 25_000);
		assert.ok(scheduled.staticData.sentinelOneTrigger.checkpointMs < START + 3_600_000);
	} finally {
		Date.now = realNow;
	}
});
