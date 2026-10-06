const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { NodeApiError } = require('n8n-workflow');
const {
	SentinelOnePlatform,
} = require('../../dist/nodes/SentinelOnePlatform/SentinelOnePlatform.node');

const missing = {
	errors: [
		{
			message: 'Exception while fetching data (/alert) : Required value was null.',
			locations: [{ line: 1, column: 21 }],
			path: ['alert'],
			extensions: { classification: 'DataFetchingException' },
		},
	],
	data: null,
};

async function run(t, operation, response, verification = false, continueOnFail = false) {
	const requests = [];
	const server = http.createServer(async (req, res) => {
		let body = '';
		for await (const chunk of req) body += chunk;
		const request = JSON.parse(body);
		requests.push(request);
		let value = response;
		if (verification && request.query.includes('SentinelOneAvailableAlertActions')) {
			value = {
				data: {
					alert: { id: 'missing-demo' },
					alertAvailableActions: {
						data: [
							{
								id: 'status',
								isDisabled: false,
								types: ['STATUS_UPDATE'],
								triggeredAfter: [],
								triggersActions: [],
							},
						],
					},
				},
			};
		} else if (verification && request.query.includes('mutation')) {
			value = {
				data: {
					alertTriggerActions: {
						__typename: 'TriggerActionsScheduled',
						executionId: 'execution-demo',
					},
				},
			};
		}
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify(value));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const parameters = {
		resource: 'alert',
		operation,
		alertId: 'missing-demo',
		updateFields: { status: 'RESOLVED' },
	};
	const context = {
		getNode: () => ({ name: 'Demo', type: 'sentinelOnePlatform', typeVersion: 1, parameters }),
		getCredentials: async () => ({ baseUrl: `http://127.0.0.1:${server.address().port}` }),
		getNodeParameter: (name, _index, fallback) => parameters[name] ?? fallback,
		getInputData: () => [{ json: {} }],
		continueOnFail: () => continueOnFail,
		helpers: {
			httpRequestWithAuthentication: async (_credential, options) => {
				const result = await fetch(options.url, {
					method: options.method,
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(options.body),
				});
				return result.json();
			},
		},
	};
	const execute = () => new SentinelOnePlatform().execute.call(context);
	return { execute, requests };
}

function isMissing(error) {
	assert.ok(error instanceof NodeApiError);
	assert.equal(error.httpCode, '404');
	assert.equal(error.message, 'Alert missing-demo not found.');
	assert.equal(error.description, 'Check the alert ID and that the credential can see it.');
	return true;
}

for (const operation of ['get', 'update']) {
	for (const [shape, response] of [
		['exact service error', missing],
		['null alert', { data: { alert: null } }],
	]) {
		test(`${operation} reports 404 for ${shape}`, async (t) => {
			const { execute, requests } = await run(t, operation, response);
			await assert.rejects(execute(), isMissing);
			assert.equal(requests.length, 1);
			assert.match(requests[0].query, /alert\(id: \$id\)/);
			assert.equal(requests[0].variables.id, 'missing-demo');
		});
	}
	test(`${operation} preserves missing alert identity with Continue On Fail`, async (t) => {
		const { execute } = await run(t, operation, missing, false, true);
		const [[item]] = await execute();
		isMissing(item.error);
		assert.equal(item.json.alertId, 'missing-demo');
		assert.equal(item.json.httpCode, '404');
		assert.deepEqual(item.pairedItem, { item: 0 });
	});
}
test('Update verification propagates the exact missing alert response', async (t) => {
	const { execute, requests } = await run(t, 'update', missing, true);
	await assert.rejects(execute(), isMissing);
	assert.equal(requests.length, 3);
});
test('Other GraphQL errors retain their existing identity even with a null alert', async (t) => {
	for (const error of [
		{ message: 'Required value was null', path: ['alert', 'status'] },
		{ message: 'Permission denied', path: ['alert'] },
	]) {
		const { execute } = await run(t, 'get', { errors: [error], data: { alert: null } });
		await assert.rejects(execute(), (failure) => {
			assert.equal(failure.httpCode, '400');
			assert.equal(failure.message, 'SentinelOne GraphQL operation failed.');
			return true;
		});
	}
});
