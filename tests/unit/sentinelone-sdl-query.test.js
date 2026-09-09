const assert = require('node:assert/strict');
const test = require('node:test');
const {
	executeSdlQuery,
} = require('../../dist/nodes/SentinelOnePlatform/actions/sdlQuery/execute.operation.js');

const BASE_URL = 'https://tenant.example';
const START = '2026-09-07T00:00:00.000Z';
const END = '2026-09-07T01:00:00.000Z';

const full = (body, headers = {}, statusCode = 200) => ({ body, headers, statusCode });
const completed = (columns, values, data = {}, top = {}) => ({
	id: 'query-1',
	stepsCompleted: 2,
	stepsTotal: 2,
	data: {
		columns: columns.map((name) => ({ name })),
		values,
		...data,
	},
	...top,
});

function context(request, overrides = {}) {
	const parameters = {
		query: 'dataSource.name = "Process" | limit 10',
		startTime: START,
		endTime: END,
		queryScope: 'tenant',
		accountIds: [],
		outputMode: 'rows',
		options: {},
		...overrides,
	};
	return {
		getNodeParameter(name, _itemIndex, fallback) {
			return Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : fallback;
		},
		async getCredentials() {
			return { baseUrl: `${BASE_URL}/`, apiToken: 'top-secret-token' };
		},
		getExecutionCancelSignal() {
			return undefined;
		},
		helpers: {
			httpRequestWithAuthentication: async (credentialType, options) => {
				assert.equal(credentialType, 'sentinelOnePlatformApi');
				return request(options);
			},
		},
	};
}

test('SDL Query launches once, scopes the PQ request, maps safe unique columns, and cleans up', async () => {
	const calls = [];
	const ctx = context(
		async (request) => {
			calls.push(request);
			if (request.method === 'POST')
				return full(
					completed(
						['name', 'name', 'name__2', '_query', '__proto__', 'constructor', ''],
						[['one', 'two', 'three', 'four', 'five', 'six', 'seven']],
					),
					{ 'X-Dataset-Query-Forward-Tag': 'route-A' },
				);
			return full(undefined, {}, 204);
		},
		{
			queryScope: 'accounts',
			accountIds: ['account-1', 'account-2'],
		},
	);
	const result = await executeSdlQuery(ctx, 0);
	assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
	assert.equal(calls[0].encoding, 'text');
	assert.equal(calls[0].json, false);
	assert.equal(calls[0].sendCredentialsOnCrossOriginRedirect, false);
	assert.deepEqual(calls[0].body, {
		queryType: 'PQ',
		startTime: START,
		endTime: END,
		pq: { query: 'dataSource.name = "Process" | limit 10', resultType: 'TABLE' },
		tenant: false,
		accountIds: ['account-1', 'account-2'],
	});
	assert.equal(calls[1].method, 'DELETE');
	assert.equal(calls[1].sendCredentialsOnCrossOriginRedirect, false);
	assert.equal(calls[1].headers['x-dataset-query-forward-tag'], 'route-A');
	assert.deepEqual(Object.keys(result[0]), [
		'name',
		'name__2',
		'name__2__2',
		'_query__2',
		'__proto__',
		'constructor',
		'column_7',
		'_query',
	]);
	assert.equal(result[0].__proto__, 'five');
	assert.equal(result[0].constructor, 'six');
	assert.equal(result[0]._query.cleanupStatus, 'request_accepted');
	assert.equal(JSON.stringify(result).includes('dataSource.name'), false);
	assert.equal(JSON.stringify(result).includes('top-secret-token'), false);
});

test('SDL tenant scope does not evaluate hidden account expressions', async () => {
	const calls = [];
	const ctx = context(async (request) => {
		calls.push(request);
		return request.method === 'POST'
			? full(completed([], []), { 'x-dataset-query-forward-tag': 'route-A' })
			: full(undefined, {}, 204);
	});
	const getParameter = ctx.getNodeParameter;
	ctx.getNodeParameter = (name, ...args) => {
		assert.notEqual(name, 'accountIds', 'Hidden account expressions must not run');
		return getParameter(name, ...args);
	};
	await executeSdlQuery(ctx, 0);
	assert.equal(calls[0].body.tenant, true);
	assert.equal(Object.hasOwn(calls[0].body, 'accountIds'), false);
});

test('SDL Query polls with monotonic lastStepSeen and replaces the routing tag', async () => {
	const calls = [];
	let polls = 0;
	const result = await executeSdlQuery(
		context(async (request) => {
			calls.push(request);
			if (request.method === 'POST')
				return full(
					{ id: 'query-1', stepsCompleted: 1, stepsTotal: 3, data: null },
					{ 'x-dataset-query-forward-tag': 'route-A' },
				);
			if (request.method === 'GET') {
				polls++;
				if (polls === 1)
					return full(
						{ id: 'query-1', stepsCompleted: 2, stepsTotal: 3, data: null },
						{ 'X-Dataset-Query-Forward-Tag': 'route-B' },
					);
				return full(completed(['event.id'], [['event-1']]));
			}
			return full(undefined, {}, 204);
		}),
		0,
	);
	const getCalls = calls.filter((call) => call.method === 'GET');
	assert.deepEqual(
		getCalls.map((call) => call.qs.lastStepSeen),
		[1, 2],
	);
	assert.equal(getCalls[0].headers['x-dataset-query-forward-tag'], 'route-A');
	assert.equal(getCalls[1].headers['x-dataset-query-forward-tag'], 'route-B');
	assert.equal(calls.at(-1).headers['x-dataset-query-forward-tag'], 'route-B');
	assert.equal(result[0]['event.id'], 'event-1');
});

test('SDL Query retries plaintext and HTML transient poll responses without launching again', async () => {
	let posts = 0;
	let gets = 0;
	const result = await executeSdlQuery(
		context(
			async (request) => {
				if (request.method === 'POST') {
					posts++;
					return full(
						{ id: 'query-1', stepsCompleted: 0, stepsTotal: 1, data: null },
						{ 'x-dataset-query-forward-tag': 'route-A' },
					);
				}
				if (request.method === 'GET') {
					gets++;
					if (gets === 1) return full('not found', {}, 404);
					if (gets === 2) return full('<html>throttled</html>', {}, 429);
					if (gets === 3) return full('bad gateway', {}, 502);
					return full(completed(['id'], [['one']]));
				}
				return full(undefined, {}, 204);
			},
			{ options: { pollIntervalMs: 1000 } },
		),
		0,
	);
	assert.equal(posts, 1);
	assert.equal(gets, 4);
	assert.equal(result[0].id, 'one');
});

test('SDL Query fails permanent poll responses and still cleans up', async () => {
	const methods = [];
	await assert.rejects(
		() =>
			executeSdlQuery(
				context(
					async (request) => {
						methods.push(request.method);
						if (request.method === 'POST')
							return full(
								{ id: 'query-1', stepsCompleted: 0, stepsTotal: 1, data: null },
								{ 'x-dataset-query-forward-tag': 'route-A' },
							);
						if (request.method === 'GET') return full({}, {}, 400);
						return full(undefined, {}, 204);
					},
					{ options: { pollIntervalMs: 1000 } },
				),
				0,
			),
		(error) => {
			assert.match(error.message, /poll failed with HTTP 400/);
			assert.match(error.message, /queryId=query-1/);
			assert.match(error.message, /cleanupStatus=request_accepted/);
			return true;
		},
	);
	assert.deepEqual(methods, ['POST', 'GET', 'DELETE']);
});

test('SDL Query never retries launch and does not expose API bodies, query text, or credentials', async () => {
	let posts = 0;
	const ctx = context(async (request) => {
		if (request.method === 'POST') {
			posts++;
			return full({ message: 'top-secret-token dataSource.name = "Process" | limit 10' }, {}, 503);
		}
		throw new Error('unexpected request');
	});
	await assert.rejects(
		() => executeSdlQuery(ctx, 0),
		(error) => {
			assert.match(error.message, /launch failed with HTTP 503/);
			assert.doesNotMatch(error.message, /top-secret-token|dataSource/);
			return true;
		},
	);
	assert.equal(posts, 1);
});

test('SDL Query attempts unrouted cleanup when launch omits its forward tag', async () => {
	const calls = [];
	await assert.rejects(
		() =>
			executeSdlQuery(
				context(async (request) => {
					calls.push(request);
					if (request.method === 'POST')
						return full({ id: 'query-1', stepsCompleted: 0, stepsTotal: 1, data: null });
					return full(undefined, {}, 204);
				}),
				0,
			),
		/routing header/,
	);
	assert.deepEqual(
		calls.map((call) => call.method),
		['POST', 'DELETE'],
	);
	assert.equal(calls[1].headers['x-dataset-query-forward-tag'], undefined);
});

test('SDL Query keeps successful data when cleanup fails and reports the unconfirmed cleanup', async () => {
	const result = await executeSdlQuery(
		context(async (request) => {
			if (request.method === 'POST')
				return full(completed(['id'], [['one']]), {
					'x-dataset-query-forward-tag': 'route-A',
				});
			return full({ message: 'failed' }, {}, 500);
		}),
		0,
	);
	assert.equal(result[0].id, 'one');
	assert.equal(result[0]._query.cleanupStatus, 'failed');
	assert.match(result[0]._query.warnings.at(-1), /did not confirm query cleanup/);
});

test('SDL Query uses a fresh cleanup signal after workflow cancellation', async () => {
	const cancellation = new AbortController();
	let cleanupSignal;
	const ctx = context(async (request) => {
		if (request.method === 'POST') {
			queueMicrotask(() => cancellation.abort());
			return full(
				{ id: 'query-1', stepsCompleted: 0, stepsTotal: 1, data: null },
				{ 'x-dataset-query-forward-tag': 'route-A' },
			);
		}
		cleanupSignal = request.abortSignal;
		return full(undefined, {}, 204);
	});
	ctx.getExecutionCancelSignal = () => cancellation.signal;
	await assert.rejects(() => executeSdlQuery(ctx, 0), /cancelled/);
	assert.ok(cleanupSignal);
	assert.notEqual(cleanupSignal, cancellation.signal);
	assert.equal(cleanupSignal.aborted, false);
});

test('SDL Query validates table shape before returning rows', async () => {
	for (const payload of [
		completed(['a', 'b'], [[1]]),
		completed(['a'], 'not rows'),
		{ ...completed(['a'], [[1]]), data: { columns: [{ name: 2 }], values: [[1]] } },
	]) {
		await assert.rejects(
			() =>
				executeSdlQuery(
					context(async (request) =>
						request.method === 'POST'
							? full(payload, { 'x-dataset-query-forward-tag': 'route-A' })
							: full(undefined, {}, 204),
					),
					0,
				),
			/invalid result|wrong number|invalid result column/,
		);
	}
});

test('SDL Query rejects malformed JSON from a successful response', async () => {
	await assert.rejects(
		() =>
			executeSdlQuery(
				context(async () => full('{broken', { 'x-dataset-query-forward-tag': 'route-A' })),
				0,
			),
		/invalid JSON response/,
	);
});

test('SDL Query parses unsafe JSON integers as exact strings', async () => {
	const responseText =
		'{"id":"query-1","stepsCompleted":1,"stepsTotal":1,"data":{"columns":[{"name":"positive"},{"name":"negative"}],"values":[[900719925474099312345,-900719925474099312346]]}}';
	const result = await executeSdlQuery(
		context(async (request) =>
			request.method === 'POST'
				? full(responseText, { 'x-dataset-query-forward-tag': 'route-A' })
				: full('', {}, 204),
		),
		0,
	);
	assert.equal(result[0].positive, '900719925474099312345');
	assert.equal(result[0].negative, '-900719925474099312346');
});

test('SDL Query rejects oversized text before parsing and reports cleanup context', async () => {
	let cleanupCalled = false;
	await assert.rejects(
		() =>
			executeSdlQuery(
				context(
					async (request) => {
						if (request.method === 'POST')
							return full('{"id":"query-1","stepsCompleted":0,"stepsTotal":1,"data":null}', {
								'x-dataset-query-forward-tag': 'route-A',
							});
						if (request.method === 'GET') return full(' '.repeat(1024 * 1024 + 1));
						cleanupCalled = true;
						return full('', {}, 204);
					},
					{ options: { pollIntervalMs: 1000, maxResponseSizeMiB: 1 } },
				),
				0,
			),
		(error) => {
			assert.match(error.message, /response-size limit/);
			assert.match(error.message, /queryId=query-1/);
			assert.match(error.message, /cleanupStatus=request_accepted/);
			return true;
		},
	);
	assert.equal(cleanupCalled, true);
});

test('SDL Query reports partial reasons, row truncation, and zero-row metadata', async () => {
	const table = await executeSdlQuery(
		context(
			async (request) =>
				request.method === 'POST'
					? full(
							completed(
								['id'],
								[['one'], ['two']],
								{ omittedEvents: 3, warnings: ['server warning'] },
								{
									partialResultsDueToTimeLimit: true,
									discardedArrayItems: 2,
									warnings: ['top warning'],
								},
							),
							{ 'x-dataset-query-forward-tag': 'route-A' },
						)
					: full(undefined, {}, 204),
			{ outputMode: 'table', options: { maxRows: 1 } },
		),
		0,
	);
	assert.deepEqual(table[0].values, [['one']]);
	assert.deepEqual(table[0].metadata.partialReasons, [
		'server_time_limit',
		'omitted_events',
		'discarded_array_items',
		'row_limit',
	]);
	assert.equal(table[0].metadata.truncatedRows, 1);
	assert.deepEqual(table[0].metadata.warnings, ['top warning', 'server warning']);

	const empty = await executeSdlQuery(
		context(async (request) =>
			request.method === 'POST'
				? full(completed(['id'], []), { 'x-dataset-query-forward-tag': 'route-A' })
				: full(undefined, {}, 204),
		),
		0,
	);
	assert.equal(empty.length, 1);
	assert.deepEqual(Object.keys(empty[0]), ['_query']);
	assert.equal(empty[0]._query.resultRows, 0);
});

test('SDL Query bounds materialised output and marks unfetched external results', async () => {
	const rows = Array.from({ length: 4000 }, (_, index) => [`${index}-${'x'.repeat(150)}`]);
	const oversized = await executeSdlQuery(
		context(
			async (request) =>
				request.method === 'POST'
					? full(completed(['large'], rows), {
							'x-dataset-query-forward-tag': 'route-A',
						})
					: full(undefined, {}, 204),
			{ options: { maxResponseSizeMiB: 1 } },
		),
		0,
	);
	assert.ok(oversized.length > 0 && oversized.length < rows.length);
	assert.ok(oversized[0]._query.partialReasons.includes('output_size_limit'));
	const wrapped = oversized.map((json) => ({ json, pairedItem: { item: 0 } }));
	assert.ok(Buffer.byteLength(JSON.stringify(wrapped), 'utf8') <= 1024 * 1024);

	const external = await executeSdlQuery(
		context(async (request) =>
			request.method === 'POST'
				? full(
						{
							id: 'query-1',
							stepsCompleted: 1,
							stepsTotal: 1,
							data: { fullResultUrl: 'https://results.example/result' },
						},
						{ 'x-dataset-query-forward-tag': 'route-A' },
					)
				: full(undefined, {}, 204),
		),
		0,
	);
	assert.ok(external[0]._query.partialReasons.includes('external_result_unfetched'));
});
