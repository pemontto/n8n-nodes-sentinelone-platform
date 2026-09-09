const assert = require('node:assert/strict');
const test = require('node:test');
const {
	readActivityFeed,
	ACTIVITY_FEED_LOG_FILTER,
} = require('../../dist/nodes/SentinelOnePlatformTrigger/ActivityFeed.js');

const BASE = 'https://tenant.example';
const START = 1788776400000;
const ns = (ms, extra = 0n) => (BigInt(ms) * 1000000n + extra).toString();
const row = (id = 'activity-1', time = START, alertId = 'alert-1') => [
	id,
	new Date(time).toISOString(),
	alertId,
	ns(time),
	'note text',
	null,
	null,
];
const response = (rows = [], data = {}) => ({
	id: 'query-1',
	stepsCompleted: 1,
	stepsTotal: 1,
	data: {
		matches: rows.map((input) => ({
			timestamp: input[3],
			values: {
				activity_id: input[0],
				created_at: input[1],
				'data.alert.id': input[2],
				activity_type: '16007',
				'data.payload.note_text': input[4],
				'data.user.id': input[5],
				'data.user.enriched_name': input[6],
			},
		})),
		omittedEvents: 0,
		discardedArrayItems: 0,
		...data,
	},
});
const clock = () => {
	let time = 0;
	return {
		now: () => time,
		sleep: async (ms) => {
			time += ms;
		},
		deadlineMs: 10000,
		lifecycleMs: 5000,
	};
};

test('ActivityFeed completes inline, preserves nanoseconds and restricts account scope', async () => {
	const input = row();
	input[3] = ns(START, 999999n);
	const events = await readActivityFeed(
		async (request) => {
			assert.equal(request.method, 'POST');
			assert.equal(JSON.parse(request.body).log.filter, ACTIVITY_FEED_LOG_FILTER);
			assert.deepEqual(JSON.parse(request.body).accountIds, ['account-1']);
			assert.equal(JSON.parse(request.body).tenant, false);
			assert.equal(JSON.parse(request.body).startTime, new Date(START).toISOString());
			return response([input]);
		},
		BASE,
		START,
		START + 1,
		['account-1'],
	);
	assert.equal(events[0].timestampNs, input[3]);
});

test('ActivityFeed retries poll 404/429 and requires completed counters plus data', async () => {
	let gets = 0;
	const events = await readActivityFeed(
		async (request) => {
			if (request.method === 'POST')
				return { id: 'query-1', stepsCompleted: 0, stepsTotal: 1, data: {} };
			gets++;
			if (gets <= 2) throw { statusCode: gets === 1 ? 404 : 429 };
			return response([row()]);
		},
		BASE,
		START,
		START + 1,
		[],
		clock(),
	);
	assert.equal(gets, 3);
	assert.equal(events.length, 1);
});

test('ActivityFeed cancels abandoned queries on deadline and poll failure', async () => {
	for (const status of [404, 500]) {
		const calls = [];
		await assert.rejects(
			() =>
				readActivityFeed(
					async (request) => {
						calls.push(request.method);
						if (request.method === 'POST') return { id: 'query-1' };
						if (request.method === 'GET') throw { statusCode: status };
						throw new Error('cleanup also failed');
					},
					BASE,
					START,
					START + 1,
					[],
					clock(),
				),
			/deadline|polling failed/,
		);
		assert.equal(calls.at(-1), 'DELETE');
	}
});

test('ActivityFeed fails on partial data, errors, warnings and malformed LOG matches', async () => {
	for (const data of [
		{ warnings: ['partial'] },
		{ errors: [{}] },
		{ partialResultsDueToTimeLimit: true },
		{ omittedEvents: 1 },
		{ discardedArrayItems: 1 },
		{ matches: null },
		{ matches: [{}] },
		{ matches: undefined },
	]) {
		await assert.rejects(
			() =>
				readActivityFeed(
					async (request) => (request.method === 'DELETE' ? {} : response([], data)),
					BASE,
					START,
					START + 1,
				),
			/ActivityFeed/,
		);
	}
	for (const index of [0, 2, 3]) {
		const bad = row();
		bad[index] = {};
		await assert.rejects(
			() =>
				readActivityFeed(
					async (request) => (request.method === 'DELETE' ? {} : response([bad])),
					BASE,
					START,
					START + 1,
				),
			/identity, timestamps or note text/,
		);
	}
});

test('ActivityFeed splits saturation into gapless half-open windows', async () => {
	const windows = [];
	const events = await readActivityFeed(
		async (request) => {
			const start = Date.parse(JSON.parse(request.body).startTime),
				end = Date.parse(JSON.parse(request.body).endTime);
			windows.push([start, end]);
			return response(
				end - start > 1
					? Array.from({ length: 1000 }, (_, i) => row(`sample-${i}`, start))
					: [row(String(start), start)],
			);
		},
		BASE,
		START,
		START + 2,
	);
	assert.deepEqual(windows, [
		[START, START + 2],
		[START, START + 1],
		[START + 1, START + 2],
	]);
	assert.equal(events.length, 2);
});

test('ActivityFeed fails at unsplittable saturation and total query budget', async () => {
	const saturated = async () => response(Array.from({ length: 1000 }, (_, i) => row(String(i))));
	await assert.rejects(
		() => readActivityFeed(saturated, BASE, START, START + 1),
		/one millisecond/,
	);
	await assert.rejects(
		() => readActivityFeed(saturated, BASE, START, START + 4, [], { maxQueries: 1 }),
		/query budget/,
	);
});

test('ActivityFeed filters nanosecond boundaries and deduplicates IDs', async () => {
	const before = row('before');
	before[3] = ns(START, -1n);
	const last = row('last');
	last[3] = ns(START + 1, -1n);
	const events = await readActivityFeed(
		async () => response([before, row(), row(), last, row('end', START + 1)]),
		BASE,
		START,
		START + 1,
	);
	assert.deepEqual(
		events.map((event) => event.activityId),
		['activity-1', 'last'],
	);
	await assert.rejects(
		() =>
			readActivityFeed(
				async (request) =>
					request.method === 'DELETE' ? {} : response([row(), row('activity-1', START, 'other')]),
				BASE,
				START,
				START + 1,
			),
		/conflicting duplicate/,
	);
});

test('ActivityFeed never accepts string completion counters or null result data', async () => {
	for (const malformed of [
		{ ...response(), stepsCompleted: '1' },
		{ ...response(), stepsTotal: '1' },
		{ ...response(), data: null },
	]) {
		let cancelled = false;
		await assert.rejects(
			() =>
				readActivityFeed(
					async (request) => {
						if (request.method === 'DELETE') {
							cancelled = true;
							return {};
						}
						return malformed;
					},
					BASE,
					START,
					START + 1,
					[],
					clock(),
				),
			/deadline/,
		);
		assert.equal(cancelled, true);
	}
});

test('ActivityFeed rejects top-level warnings and failure after a successful split', async () => {
	await assert.rejects(
		() =>
			readActivityFeed(
				async (request) =>
					request.method === 'DELETE' ? {} : { ...response(), warnings: ['incomplete'] },
				BASE,
				START,
				START + 1,
			),
		/warnings/,
	);
	let creates = 0;
	await assert.rejects(
		() =>
			readActivityFeed(
				async (request) => {
					if (request.method === 'DELETE') return {};
					creates++;
					if (creates === 1)
						return response(Array.from({ length: 1000 }, (_, i) => row(String(i))));
					if (creates === 2) return response([row('accepted-left')]);
					return response([], { omittedEvents: 1 });
				},
				BASE,
				START,
				START + 2,
			),
		/omitted/,
	);
	assert.equal(creates, 3);
});

test('ActivityFeed preserves optional note text and rejects invalid text values', async () => {
	const input = row();
	input[4] = 'A note with Unicode 🔎\nand another line';
	const result = await readActivityFeed(async () => response([input]), BASE, START, START + 1);
	assert.equal(result[0].noteText, input[4]);
	assert.ok(!ACTIVITY_FEED_LOG_FILTER.includes('16007'));
	for (const value of [42]) {
		const invalid = row();
		invalid[4] = value;
		await assert.rejects(
			() =>
				readActivityFeed(
					async (r) => (r.method === 'DELETE' ? {} : response([invalid])),
					BASE,
					START,
					START + 1,
				),
			/note text/,
		);
	}
});

test('ActivityFeed forwards routing headers to polls and cancellation and updates the tag', async () => {
	let gets = 0;
	let cancelled = false;
	await assert.rejects(
		() =>
			readActivityFeed(
				async (r) => {
					assert.equal(r.returnFullResponse, true);
					if (r.method === 'POST')
						return {
							body: { id: 'q', stepsCompleted: 0, stepsTotal: 1 },
							headers: { 'X-Dataset-Query-Forward-Tag': 'route-A' },
						};
					if (r.method === 'GET') {
						gets++;
						assert.equal(
							r.headers['x-dataset-query-forward-tag'],
							gets === 1 ? 'route-A' : 'route-B',
						);
						if (gets === 1)
							return {
								body: { id: 'q', stepsCompleted: 0, stepsTotal: 1 },
								headers: { 'x-dataset-query-forward-tag': 'route-B' },
							};
						throw {
							statusCode: 500,
							response: { headers: { 'x-dataset-query-forward-tag': 'route-C' } },
						};
					}
					cancelled = true;
					assert.equal(r.headers['x-dataset-query-forward-tag'], 'route-C');
					return {};
				},
				BASE,
				START,
				START + 1,
				[],
				clock(),
			),
		/polling failed/,
	);
	assert.equal(cancelled, true);
	for (const tag of ['bad\r\nheader', 'x'.repeat(1025), ['array']]) {
		await assert.rejects(
			() =>
				readActivityFeed(
					async () => ({ body: response(), headers: { 'x-dataset-query-forward-tag': tag } }),
					BASE,
					START,
					START + 1,
				),
			/routing header/,
		);
	}
});

test('ActivityFeed splits oversized inline responses instead of truncating', async () => {
	const windows = [];
	const result = await readActivityFeed(
		async (r) => {
			const start = Date.parse(JSON.parse(r.body).startTime),
				end = Date.parse(JSON.parse(r.body).endTime);
			windows.push([start, end]);
			const input = row(String(start), start);
			input[4] = end - start > 1 ? 'x'.repeat(2000) : 'small';
			return response([input]);
		},
		BASE,
		START,
		START + 2,
		[],
		{ inlineBytes: 1000 },
	);
	assert.equal(windows.length, 3);
	assert.equal(result.length, 2);
	const huge = row();
	huge[4] = 'x'.repeat(2000);
	await assert.rejects(
		() =>
			readActivityFeed(async () => response([huge]), BASE, START, START + 1, [], {
				inlineBytes: 1000,
			}),
		/inline-byte/,
	);
});

test('ActivityFeed never ignores or downloads a full-result URL', async () => {
	let calls = 0;
	const result = await readActivityFeed(
		async (r) => {
			assert.ok(r.url.startsWith(BASE));
			calls++;
			const start = Date.parse(JSON.parse(r.body).startTime),
				end = Date.parse(JSON.parse(r.body).endTime);
			return end - start > 1
				? response([], { fullResultUrl: 'https://elsewhere.invalid/result' })
				: response([row(String(start), start)]);
		},
		BASE,
		START,
		START + 2,
	);
	assert.equal(calls, 3);
	assert.equal(result.length, 2);
	await assert.rejects(
		() =>
			readActivityFeed(
				async () => ({ ...response(), fullResultUrl: 'https://elsewhere.invalid/result' }),
				BASE,
				START,
				START + 1,
			),
		/external-result/,
	);
});

test('ActivityFeed rejects mismatched poll query IDs but accepts an omitted poll ID', async () => {
	let cancelled = false;
	await assert.rejects(
		() =>
			readActivityFeed(
				async (r) => {
					if (r.method === 'POST')
						return { id: 'requested-query', stepsCompleted: 0, stepsTotal: 1 };
					if (r.method === 'DELETE') {
						cancelled = true;
						assert.ok(r.url.endsWith('/requested-query'));
						return {};
					}
					return { ...response([row()]), id: 'different-query' };
				},
				BASE,
				START,
				START + 1,
				[],
				clock(),
			),
		/mismatched query ID/,
	);
	assert.equal(cancelled, true);
	const events = await readActivityFeed(
		async (r) => {
			if (r.method === 'POST') return { id: 'requested-query', stepsCompleted: 0, stepsTotal: 1 };
			const completed = response([row()]);
			delete completed.id;
			return completed;
		},
		BASE,
		START,
		START + 1,
		[],
		clock(),
	);
	assert.equal(events.length, 1);
});

const logMatch = (id = 'raw-activity', time = START) => ({
	cursor: 'native-cursor',
	serverInfo: { region: 'example' },
	sessionId: 'session',
	severity: 3,
	threadId: 'thread',
	timestamp: ns(time),
	values: {
		activity_id: id,
		activity_type: '16007',
		created_at: new Date(time).toISOString(),
		'data.alert.id': 'alert-1',
		'data.payload.note_text': 'all native fields',
		'data.user.id': 'user-1',
		'data.user.enriched_name': 'Author',
		'unknown.field': { list: [null, true, 1.5, { retained: 'yes' }] },
	},
});
const logResponse = (matches) => ({
	id: 'raw-query',
	stepsCompleted: 1,
	stepsTotal: 1,
	data: { estimatedMatchCount: matches.length, matches },
});
const readFull = (request, start = START, end = START + 1, timing = {}) =>
	readActivityFeed(request, BASE, start, end, ['account-1'], timing, undefined, true);

test('LOG full output preserves unsafe integer tokens and every native field', async () => {
	const raw = logMatch();
	raw.values['site.id'] = 'EXACT_SITE_INTEGER';
	const text = JSON.stringify(logResponse([raw]))
		.replace('"' + ns(START) + '"', ns(START))
		.replace('"EXACT_SITE_INTEGER"', '900719925474099312345');
	const events = await readFull(async (r) => {
		assert.equal(r.json, false);
		assert.equal(r.encoding, 'text');
		assert.equal(r.returnFullResponse, true);
		const body = JSON.parse(r.body);
		assert.equal(body.queryType, 'LOG');
		assert.equal(body.pq, undefined);
		assert.equal(body.log.limit, 1000);
		assert.ok(!body.log.filter.includes('|'));
		assert.deepEqual(body.accountIds, ['account-1']);
		assert.equal(body.tenant, false);
		return { body: text, headers: {} };
	});
	assert.equal(events[0].timestampNs, ns(START));
	assert.equal(events[0].rawActivity.timestamp, ns(START));
	assert.equal(events[0].rawActivity.values['site.id'], '900719925474099312345');
	assert.deepEqual(events[0].rawActivity.values['unknown.field'], raw.values['unknown.field']);
	assert.equal(events[0].rawActivity.cursor, raw.cursor);
	assert.equal(events[0].authorId, 'user-1');
	assert.equal(events[0].authorName, 'Author');
});

test('LOG textual polling preserves routing and embedded string escapes', async () => {
	let polls = 0;
	const match = logMatch();
	match.values.extra = '12345678901234567890 "quoted" \\ slash';
	const events = await readFull(
		async (r) => {
			assert.equal(r.json, false);
			assert.equal(r.encoding, 'text');
			if (r.method === 'POST')
				return {
					body: '{"id":"raw-query","stepsCompleted":0,"stepsTotal":1,"data":null}',
					headers: { 'x-dataset-query-forward-tag': 'raw-route' },
				};
			polls++;
			assert.equal(r.headers['x-dataset-query-forward-tag'], 'raw-route');
			return { body: JSON.stringify(logResponse([match])), headers: {} };
		},
		START,
		START + 1,
		clock(),
	);
	assert.equal(polls, 1);
	assert.equal(events[0].rawActivity.values.extra, match.values.extra);
});

test('LOG rejects rounded object numbers and malformed events or match arrays', async () => {
	const unsafe = logMatch();
	unsafe.timestamp = Number(ns(START));
	for (const body of [
		logResponse([unsafe]),
		logResponse([{}]),
		{ ...logResponse([]), data: {} },
		logResponse([
			{ ...logMatch(), values: { ...logMatch().values, 'data.payload.note_text': 42 } },
		]),
	]) {
		await assert.rejects(
			() => readFull(async (r) => (r.method === 'DELETE' ? {} : body)),
			/ActivityFeed/,
		);
	}
	await assert.rejects(() => readFull(async () => '{"invalid":'), /JSON/);
});

test('LOG full output splits capped raw matches without dropping unknown fields', async () => {
	let creates = 0;
	const events = await readFull(
		async (r) => {
			creates++;
			const body = JSON.parse(r.body),
				start = Date.parse(body.startTime),
				end = Date.parse(body.endTime);
			return logResponse(
				end - start > 1
					? Array.from({ length: 1000 }, (_, i) => logMatch('sample-' + i, start))
					: [logMatch(String(start), start)],
			);
		},
		START,
		START + 2,
	);
	assert.equal(creates, 3);
	assert.equal(events.length, 2);
	assert.equal(events[1].rawActivity.values['unknown.field'].list[3].retained, 'yes');
});

test('ActivityFeed preserves exact string author IDs and nullable names', async () => {
	const input = row();
	input[5] = '90071992547409930002';
	input[6] = 'Example Analyst';
	const [event] = await readActivityFeed(async () => response([input]), BASE, START, START + 1);
	assert.equal(event.authorId, '90071992547409930002');
	assert.equal(event.authorName, 'Example Analyst');
	assert.match(ACTIVITY_FEED_LOG_FILTER, /dataset='activityLog'/);
	input[5] = 90071992547409930002;
	await assert.rejects(
		() => readActivityFeed(async () => response([input]), BASE, START, START + 1),
		/unsafe LOG numbers/,
	);
});

test('ActivityFeed decodes every known category and unknown alert-linked types without note text', async () => {
	const kinds = [
		'alertCreated',
		'statusChanged',
		'analystVerdictChanged',
		'severityChanged',
		'assigneeChanged',
		'mitigationActivity',
		'noteCreated',
		'unknown',
	];
	const ids = ['16000', '16001', '16002', '16003', '16004', '16005', '16007', '19999'];
	const matches = ids.map((id) => {
		const match = logMatch(id);
		match.values.activity_type = id;
		delete match.values['data.payload.note_text'];
		return match;
	});
	const events = await readFull(async () => logResponse(matches));
	assert.deepEqual(
		events.map((event) => event.activityKind),
		kinds,
	);
	assert.deepEqual(
		events.map((event) => event.activityTypeId),
		ids,
	);
	assert.ok(events.every((event) => !Object.hasOwn(event, 'noteText')));
});

test('ActivityFeed keeps every recorded change, including null, UNDEFINED and missing endpoints', async () => {
	const match = logMatch();
	Object.assign(match.values, {
		'data.payload.changes.old_status': 'RESOLVED',
		'data.payload.changes.new_status': 'IN_PROGRESS',
		'data.payload.changes.old_analyst_verdict': 'UNDEFINED',
		'data.payload.changes.new_analyst_verdict': null,
		'data.payload.changes.new_severity': 'HIGH',
		'data.payload.changes.new_assignee_email': 'analyst@example.invalid',
		'data.payload.changes.new_assignee_id': '90071992547409930002',
		'data.payload.changes.old_assignee_id': 'never-inferred',
		'data.payload.changes.old_verdict': 'never-aliased',
		'data.payload.mitigation_action_type': 'WORKFLOW',
		'data.payload.mitigation_action_status': 'RUNNING',
	});
	const [event] = await readFull(async () => logResponse([match]));
	assert.deepEqual(event.changes, [
		{ field: 'status', oldValue: 'RESOLVED', newValue: 'IN_PROGRESS' },
		{ field: 'analystVerdict', oldValue: 'UNDEFINED', newValue: null },
		{ field: 'severity', newValue: 'HIGH' },
		{ field: 'assigneeEmail', newValue: 'analyst@example.invalid' },
		{ field: 'assigneeId', newValue: '90071992547409930002' },
	]);
	assert.deepEqual(event.mitigation, { actionType: 'WORKFLOW', activityStatus: 'RUNNING' });
	assert.equal(event.rawActivity.values['data.payload.changes.old_verdict'], 'never-aliased');
});

test('ActivityFeed prefers newest duplicate source timestamp and ignores transport metadata differences', async () => {
	const old = logMatch();
	const newest = logMatch();
	newest.timestamp = ns(START, 50n);
	newest.values['data.payload.note_text'] = 'newest';
	const copy = { ...newest, cursor: 'different-cursor' };
	for (const matches of [
		[old, newest, copy],
		[newest, old, copy],
	]) {
		const events = await readFull(async () => logResponse(matches));
		assert.equal(events.length, 1);
		assert.equal(events[0].noteText, 'newest');
	}
	const conflict = structuredClone(newest);
	conflict.values['unrecognized.payload'] = true;
	await assert.rejects(
		() => readFull(async () => logResponse([newest, conflict])),
		/conflicting duplicate/,
	);
});

test('ActivityFeed normal and raw modes request identical LOG selection and preserve exact numbers', async () => {
	const bodies = [];
	for (const raw of [false, true]) {
		const events = await readActivityFeed(
			async (request) => {
				bodies.push(JSON.parse(request.body));
				return JSON.stringify(logResponse([logMatch()])).replace('"' + ns(START) + '"', ns(START));
			},
			BASE,
			START,
			START + 1,
			[],
			{},
			undefined,
			raw,
			['16001', '16007'],
		);
		assert.equal(events[0].timestampNs, ns(START));
	}
	assert.deepEqual(bodies[0], bodies[1]);
	assert.equal(bodies[0].queryType, 'LOG');
	assert.match(bodies[0].log.filter, /activity_type='16001' OR activity_type='16007'/);
});

test('ActivityFeed reports sanitized SDL launch and polling failures', async () => {
	for (const stage of ['launch', 'polling']) {
		await assert.rejects(
			() =>
				readFull(
					async (request) => {
						if (request.method === 'POST' && stage === 'polling') return { id: 'raw-query' };
						throw new Error('SECRET request body https://private.invalid');
					},
					START,
					START + 1,
					clock(),
				),
			(error) => {
				assert.match(error.message, new RegExp(stage));
				assert.ok(!error.message.includes('SECRET'));
				return true;
			},
		);
	}
});

test('ActivityFeed manual preview stops at the first matching window and reports budget exhaustion', async () => {
	let requests = 0;
	const matched = [];
	await readActivityFeed(
		async (request) => {
			requests++;
			const body = JSON.parse(request.body);
			return logResponse([logMatch('match', Date.parse(body.startTime))]);
		},
		BASE,
		Date.parse('2020-01-01'),
		START + 1,
		[],
		{},
		async (events) => {
			matched.push(...events);
			return events.length > 0;
		},
	);
	assert.equal(requests, 1);
	assert.equal(matched.length, 1);
	await assert.rejects(
		() =>
			readActivityFeed(
				async () => logResponse([]),
				BASE,
				Date.parse('2020-01-01'),
				START + 1,
				[],
				{ maxQueries: 1 },
				async () => false,
			),
		/query budget/,
	);
});

test('ActivityFeed rejects conflicting older duplicate payloads in every input order', async () => {
	const first = logMatch();
	const conflicting = structuredClone(first);
	conflicting.values['data.payload.note_text'] = 'conflicting older payload';
	const newest = logMatch();
	newest.timestamp = ns(START, 50n);
	const permutations = (items) =>
		items.length === 0
			? [[]]
			: items.flatMap((item, index) =>
					permutations(items.filter((_, i) => i !== index)).map((rest) => [item, ...rest]),
				);
	for (const matches of permutations([first, conflicting, newest])) {
		await assert.rejects(() => readFull(async () => logResponse(matches)), /conflicting duplicate/);
	}
});
