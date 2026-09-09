const assert = require('node:assert/strict');
const test = require('node:test');
const {
	debugSetting,
	logGraphqlRequest,
	logGraphqlResult,
} = require('../../dist/nodes/shared/Debug.js');
const {
	getUnifiedAlert,
} = require('../../dist/nodes/SentinelOnePlatform/actions/alert/get.operation.js');

test('Debug is an opt-in node setting without expressions', () => {
	assert.equal(debugSetting.isNodeSetting, true);
	assert.equal(debugSetting.default, false);
	assert.equal(debugSetting.noDataExpression, true);
});

test('Debug off emits no request or response logs', () => {
	const logger = { info: () => assert.fail('Unexpected log') };
	logGraphqlRequest(logger, false, 'query Test { alert { id } }', {});
	logGraphqlResult(logger, false, { durationMs: 1, outcome: 'received' });
});

test('Debug preserves the GraphQL selection and variable structure without scalar data', () => {
	const logs = [];
	const logger = { info: (message, metadata) => logs.push({ message, metadata }) };
	const query =
		'mutation Update($actions: [TriggerActionInput!]!) { alertTriggerActions(actions: $actions) { __typename } }';
	logGraphqlRequest(
		logger,
		true,
		query,
		{
			actions: [
				{ id: 'action-secret', payload: { ticketId: { value: '{"secret":"ticket-secret"}' } } },
			],
			after: 'cursor-secret',
			text: 'note-secret',
			apiToken: 'token-secret',
			accountId: 123456789,
		},
		{ attempt: 2, itemIndex: 3 },
	);
	assert.equal(logs[0].metadata.query, query);
	assert.ok(logs[0].message.includes(query));
	assert.equal(logs[0].metadata.operation, 'Update');
	assert.equal(logs[0].metadata.attempt, 2);
	assert.equal(logs[0].metadata.itemIndex, 3);
	assert.equal(logs[0].metadata.variables.actions[0].payload.ticketId.value, '[REDACTED]');
	assert.doesNotMatch(
		JSON.stringify(logs),
		/action-secret|ticket-secret|cursor-secret|note-secret|token-secret|123456789/,
	);
});

test('Debug redacts escaped, multiline and block string literals and comments', () => {
	let entry;
	const logger = {
		info: (_message, metadata) => {
			entry = metadata;
		},
	};
	logGraphqlRequest(
		logger,
		true,
		String.raw`query Test {
		alert(id: "inline-secret#suffix", text: "quote\"secret", block: """block-secret
		\"""nested-secret
		""") { id } # comment-secret
	}`,
		{},
	);
	assert.match(entry.query, /query Test/);
	assert.match(entry.query, /\{ id \}/);
	assert.doesNotMatch(entry.query, /secret|suffix/);
});

test('Debug logging failure cannot change request outcomes', () => {
	const logger = {
		info: () => {
			throw new Error('logger failure');
		},
	};
	assert.doesNotThrow(() => logGraphqlRequest(logger, true, 'query Test { id }', {}));
	assert.doesNotThrow(() => logGraphqlResult(logger, true, { durationMs: 2, outcome: 'received' }));
	assert.doesNotThrow(() => logGraphqlRequest(undefined, true, 'query Test { id }', {}));
});

test('Action requests log each retry and sanitized response summary', async () => {
	const logs = [];
	let attempts = 0;
	const parameters = { alertId: 'alert-secret', nodeDebug: true };
	const context = {
		getNode: () => ({ name: 'SentinelOne', typeVersion: 1, parameters }),
		getNodeParameter: (name, _index, fallback) => parameters[name] ?? fallback,
		getCredentials: async () => ({
			baseUrl: 'https://tenant-secret.example',
			apiToken: 'credential-secret',
		}),
		logger: { info: (message, metadata) => logs.push({ message, metadata }) },
		helpers: {
			httpRequestWithAuthentication: async () => {
				attempts++;
				if (attempts === 1) throw Object.assign(new Error('response-secret'), { statusCode: 503 });
				return { data: { alert: { id: 'alert-secret', ticketId: 'ticket-secret' } } };
			},
		},
	};
	const result = await getUnifiedAlert(context, 4);
	assert.equal(result[0].ticketId, 'ticket-secret');
	assert.equal(logs.length, 4);
	assert.equal(logs[1].metadata.statusCode, 503);
	assert.equal(logs[1].metadata.outcome, 'transportError');
	assert.equal(logs[2].metadata.attempt, 2);
	assert.equal(logs[3].metadata.outcome, 'received');
	assert.equal(typeof logs[3].metadata.durationMs, 'number');
	assert.doesNotMatch(
		JSON.stringify(logs),
		/alert-secret|ticket-secret|tenant-secret|credential-secret|response-secret/,
	);

	parameters.nodeDebug = false;
	await getUnifiedAlert(context, 4);
	assert.equal(logs.length, 4);
});
