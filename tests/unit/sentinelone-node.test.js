const assert = require('node:assert/strict');
const test = require('node:test');

const {
	SentinelOnePlatform,
} = require('../../dist/nodes/SentinelOnePlatform/SentinelOnePlatform.node.js');
const { routeSentinelOneOperation } = require('../../dist/nodes/SentinelOnePlatform/router.js');
const actionMetadata = require('../../nodes/SentinelOnePlatform/SentinelOnePlatform.node.json');

const ACCOUNT_ID = '90071992547409930001';
const ALERT_ID = '11111111-1111-4111-8111-111111111111';

const workflowNode = {
	id: 'sentinel-one',
	name: 'SentinelOne',
	type: 'n8n-nodes-sentinelone-platform.sentinelOnePlatform',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

function alert(id = ALERT_ID, accountId = ACCOUNT_ID) {
	return {
		id,
		status: 'NEW',
		realTime: {
			scope: {
				account: { id: accountId },
				site: { id: 'site-1' },
				group: { id: 'group-1' },
			},
		},
	};
}

function getManyEnvelope(alerts) {
	return {
		data: {
			alerts: {
				edges: alerts.map((node, index) => ({ cursor: `cursor-${index}`, node })),
				pageInfo: { hasNextPage: false, endCursor: null },
				totalCount: alerts.length,
			},
		},
	};
}

function executionContext(parametersByItem, request, { continueOnFail = false } = {}) {
	return {
		continueOnFail: () => continueOnFail,
		getCredentials: async () => ({
			baseUrl: 'https://tenant.example/',
			apiToken: 'never-return-this',
		}),
		getInputData: () => parametersByItem.map((parameters) => ({ json: parameters.input ?? {} })),
		getNode: () => ({ ...workflowNode, parameters: parametersByItem[0] ?? {} }),
		getNodeParameter(name, itemIndex, fallback) {
			const parameters = parametersByItem[itemIndex] ?? {};
			return Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : fallback;
		},
		helpers: {
			httpRequestWithAuthentication: async (credential, options) =>
				options.method === 'GET'
					? {
							data: [...new Set(parametersByItem.flatMap((p) => p.accountIds ?? []))].map((id) => ({
								id,
								name: 'Demo',
							})),
							pagination: { nextCursor: null },
						}
					: request(credential, options),
		},
	};
}

function alertParameters(overrides = {}) {
	return {
		resource: 'alert',
		operation: 'get',
		scopeType: 'ACCOUNT',
		accountIds: [ACCOUNT_ID],
		alertId: ALERT_ID,
		...overrides,
	};
}

function propertiesByName(description, name) {
	return description.properties.filter((property) => property.name === name);
}

test('action node description exposes the intended v1 resources, operations, and defaults', () => {
	const { description } = new SentinelOnePlatform();

	assert.equal(description.displayName, 'SentinelOne Platform');
	assert.equal(description.name, 'sentinelOnePlatform');
	assert.equal(description.version, 1);
	assert.deepEqual(description.icon, {
		light: 'file:../SentinelOnePlatformTrigger/sentinelone.svg',
		dark: 'file:../SentinelOnePlatformTrigger/sentinelone.dark.svg',
	});
	assert.deepEqual(description.inputs, ['main']);
	assert.deepEqual(description.outputs, ['main']);
	assert.deepEqual(description.credentials, [{ name: 'sentinelOnePlatformApi', required: true }]);
	assert.equal(description.usableAsTool, true);
	assert.equal(
		actionMetadata.resources.primaryDocumentation[0].url,
		'https://github.com/pemontto/n8n-nodes-sentinelone-platform/blob/main/docs/actions.md',
	);

	const [resource] = propertiesByName(description, 'resource');
	assert.equal(resource.default, 'alert');
	assert.deepEqual(
		resource.options.map(({ name, value }) => ({ name, value })),
		[
			{ name: 'Alert', value: 'alert' },
			{ name: 'Alert Note', value: 'alertNote' },
			{ name: 'SDL Query', value: 'sdlQuery' },
		],
	);

	const operations = propertiesByName(description, 'operation');
	assert.deepEqual(
		operations.map((property) => ({
			resource: property.displayOptions.show.resource,
			default: property.default,
			values: property.options.map((option) => option.value),
		})),
		[
			{ resource: ['alert'], default: 'get', values: ['get', 'getAll', 'update'] },
			{ resource: ['alertNote'], default: 'getAll', values: ['create', 'getAll'] },
			{ resource: ['sdlQuery'], default: 'execute', values: ['execute'] },
		],
	);

	assert.equal(propertiesByName(description, 'scopeType').length, 0);
	assert.equal(propertiesByName(description, 'returnFields').length, 0);
	const getOptions = propertiesByName(description, 'options').find((property) =>
		property.displayOptions.show.operation.includes('get'),
	);
	const additionalFields = getOptions.options.find(
		(property) => property.name === 'additionalAlertFields',
	);
	assert.equal(additionalFields.displayName, 'Additional Alert Fields');
	assert.deepEqual(additionalFields.default, []);
	assert.ok(additionalFields.options.some((field) => field.value === 'rawData'));
	const [advancedToggle] = propertiesByName(description, 'useAdvancedUpdatePayload');
	const [advancedPayload] = propertiesByName(description, 'advancedUpdatePayload');
	assert.equal(advancedToggle.default, false);
	assert.deepEqual(advancedPayload.displayOptions.show.useAdvancedUpdatePayload, [true]);
	assert.equal(advancedPayload.type, 'json');
	assert.equal(advancedPayload.typeOptions.rows, 5);
	assert.equal(propertiesByName(description, 'scopeIds').length, 0);
	for (const name of ['accountIds', 'siteIds', 'groupIds']) {
		const [field] = propertiesByName(description, name);
		assert.deepEqual(field.default, []);
		assert.deepEqual(field.displayOptions.show, {
			resource: ['alert'],
			operation: ['getAll'],
			...(name === 'groupIds' ? { siteIds: [{ _cnd: { exists: true } }] } : {}),
		});
	}

	assert.deepEqual(
		propertiesByName(description, 'alertId').map((property) => property.displayOptions.show),
		[
			{ resource: ['alert'], operation: ['get'] },
			{ resource: ['alert'], operation: ['update'] },
			{ resource: ['alertNote'], operation: ['getAll'] },
			{ resource: ['alertNote'], operation: ['create'] },
		],
	);
	const [queryScope] = propertiesByName(description, 'queryScope');
	const accountIds = propertiesByName(description, 'accountIds').find((field) =>
		field.displayOptions.show.resource.includes('sdlQuery'),
	);
	const [outputMode] = propertiesByName(description, 'outputMode');
	assert.equal(queryScope.default, 'tenant');
	assert.deepEqual(accountIds.default, []);
	assert.deepEqual(accountIds.displayOptions.show, {
		resource: ['sdlQuery'],
		operation: ['execute'],
		queryScope: ['accounts'],
	});
	assert.equal(outputMode.default, 'rows');
	assert.deepEqual(
		outputMode.options.map((option) => option.value),
		['rows', 'table'],
	);
});

test('router dispatches Alert Get and preserves the selected scope', async () => {
	let requestOptions;
	const context = executionContext([alertParameters()], async (_credentialName, options) => {
		requestOptions = options;
		return { data: { alert: alert() } };
	});

	const result = await routeSentinelOneOperation(context, 0);

	assert.deepEqual(result, [alert()]);
	assert.equal(requestOptions.method, 'POST');
	assert.equal(requestOptions.url, 'https://tenant.example/web/api/v2.1/unifiedalerts/graphql');
	assert.deepEqual(requestOptions.body.variables, {
		id: ALERT_ID,
	});
});

test('execute pairs every fanned-out result with its source input item', async () => {
	const accountTwo = '1926617403027401041';
	const parameters = [
		alertParameters({
			operation: 'getAll',
			returnAll: false,
			limit: 50,
			filters: {},
		}),
		alertParameters({
			operation: 'getAll',
			accountIds: [accountTwo],
			returnAll: false,
			limit: 50,
			filters: {},
		}),
	];
	const node = new SentinelOnePlatform();
	const result = await node.execute.call(
		executionContext(parameters, async (_credentialName, options) => {
			const accountId = options.body.variables.scope.scopeIds[0];
			return accountId === ACCOUNT_ID
				? getManyEnvelope([alert('alert-1'), alert('alert-2')])
				: getManyEnvelope([alert('alert-3', accountTwo)]);
		}),
	);

	assert.deepEqual(
		result[0].map(({ json, pairedItem }) => ({ id: json.id, pairedItem })),
		[
			{ id: 'alert-1', pairedItem: { item: 0 } },
			{ id: 'alert-2', pairedItem: { item: 0 } },
			{ id: 'alert-3', pairedItem: { item: 1 } },
		],
	);
});

test('execute emits no item when an operation returns no values', async () => {
	const node = new SentinelOnePlatform();
	const result = await node.execute.call(
		executionContext(
			[
				alertParameters({
					operation: 'getAll',
					returnAll: false,
					limit: 50,
					filters: {},
				}),
			],
			async () => getManyEnvelope([]),
		),
	);

	assert.deepEqual(result, [[]]);
});

test('Continue On Fail links an HTTP-200 GraphQL error to its input and continues', async () => {
	const secondAlertId = '11111111-1111-4111-8111-111111111112';
	const node = new SentinelOnePlatform();
	const result = await node.execute.call(
		executionContext(
			[alertParameters(), alertParameters({ alertId: secondAlertId })],
			async (_credentialName, options) => {
				if (options.body.variables.id === ALERT_ID) {
					return {
						data: { alert: alert() },
						errors: [
							{ message: `Access denied for ${ALERT_ID}`, extensions: { code: 'FORBIDDEN' } },
						],
					};
				}
				return { data: { alert: alert(secondAlertId) } };
			},
			{ continueOnFail: true },
		),
	);

	assert.equal(result[0].length, 2);
	assert.deepEqual(result[0][0].pairedItem, { item: 0 });
	assert.match(result[0][0].json.error, /GraphQL operation failed/);
	assert.doesNotMatch(result[0][0].json.error, new RegExp(ALERT_ID));
	assert.equal(result[0][0].error.context.itemIndex, 0);
	assert.equal(result[0][1].json.id, secondAlertId);
	assert.deepEqual(result[0][1].pairedItem, { item: 1 });
});

test('router rejects unsupported resource and operation pairs with the item index', async () => {
	const context = executionContext(
		[{}, {}, {}, {}, { resource: 'alert', operation: 'delete' }],
		async () => {
			throw new Error('request should not run');
		},
	);

	await assert.rejects(routeSentinelOneOperation(context, 4), (error) => {
		assert.match(error.message, /Unsupported SentinelOne operation: alert\.delete/);
		assert.equal(error.context.itemIndex, 4);
		return true;
	});
});

test('router rejects prototype property names as unsupported operations', async () => {
	for (const parameters of [
		{ resource: '__proto__', operation: 'toString' },
		{ resource: 'alert', operation: '__proto__' },
	]) {
		const context = executionContext([parameters], async () => {
			throw new Error('request should not run');
		});
		await assert.rejects(
			routeSentinelOneOperation(context, 0),
			/Unsupported SentinelOne operation/,
		);
	}
});

test('Continue On Fail preserves an indeterminate note mutation outcome', async () => {
	const submittedText = 'secret note with "quotes" and \\slashes';
	const parameters = {
		resource: 'alertNote',
		operation: 'create',
		scopeType: 'ACCOUNT',
		accountIds: [ACCOUNT_ID],
		alertId: ALERT_ID,
		text: submittedText,
		contentType: 'MARKDOWN',
	};
	const node = new SentinelOnePlatform();
	const result = await node.execute.call(
		executionContext(
			[parameters],
			async (_credentialName, options) => {
				const query = options.body.query;
				if (query.includes('SentinelOneGetAlertNotes')) {
					return { data: { alertNotes: { data: [] } } };
				}
				if (query.includes('SentinelOneGetAlert')) return { data: { alert: alert() } };
				if (query.includes('SentinelOneCreateAlertNote')) {
					return {
						data: { addAlertNote: { data: [] } },
						errors: [
							{
								message: `Mutation failed for ${JSON.stringify(submittedText)}`,
								extensions: { code: 'INTERNAL_SERVER_ERROR' },
							},
						],
					};
				}
				throw new Error('unexpected request');
			},
			{ continueOnFail: true },
		),
	);

	assert.equal(result[0].length, 1);
	assert.equal(result[0][0].json.outcome, 'unknown');
	assert.equal(result[0][0].json.mayHaveCommitted, true);
	assert.deepEqual(result[0][0].pairedItem, { item: 0 });
	assert.doesNotMatch(JSON.stringify(result[0][0].json), /secret note|quotes|slashes/);
});
