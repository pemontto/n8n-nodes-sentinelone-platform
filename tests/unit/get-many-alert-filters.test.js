const assert = require('node:assert/strict');
const test = require('node:test');
const {
	getManyUnifiedAlerts,
} = require('../../dist/nodes/SentinelOnePlatform/actions/alert/getMany.operation.js');
const {
	SentinelOnePlatform,
} = require('../../dist/nodes/SentinelOnePlatform/SentinelOnePlatform.node.js');
const {
	SentinelOnePlatformTrigger,
} = require('../../dist/nodes/SentinelOnePlatformTrigger/SentinelOnePlatformTrigger.node.js');

const metadata = [
	{ fieldId: 'alertName', filterTypes: ['FULLTEXT'], enableNegation: true },
	{ fieldId: 'ticketId', filterTypes: ['FULLTEXT', 'STRING_IN'], enableNegation: true },
	{ fieldId: 'ticketIdExists', filterTypes: ['BOOLEAN_EQUAL'], enableNegation: false },
];
let nextContextId = 0;

function actionContext(parameters = {}, metadataResponse = metadata) {
	const contextId = nextContextId++;
	const requests = [];
	const values = {
		options: {},
		filters: {},
		alertFilters: {},
		alertFilterMatch: 'all',
		returnAll: false,
		limit: 5,
		...parameters,
	};
	return {
		requests,
		parameters: values,
		getNode: () => ({
			id: 'action-node',
			name: 'SentinelOne',
			parameters: values,
			credentials: { sentinelOnePlatformApi: { id: `action-filter-test-${contextId}` } },
		}),
		getCredentials: async () => ({ baseUrl: 'https://tenant.example', apiToken: 'test-token' }),
		getNodeParameter: (name, _index, fallback) => values[name] ?? fallback,
		getWorkflow: () => ({ id: 'workflow' }),
		helpers: {
			async httpRequestWithAuthentication(_credential, request) {
				requests.push(request);
				if (request.body?.query?.includes('alertColumnMetadata')) {
					if (typeof metadataResponse === 'function')
						return metadataResponse(
							requests.filter((entry) => entry.body?.query?.includes('alertColumnMetadata')).length,
							request,
						);
					return { data: { alertColumnMetadata: metadataResponse } };
				}
				return {
					data: {
						alerts: {
							edges: [],
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				};
			},
		},
	};
}

function actionQuery(ctx) {
	return ctx.requests.find((request) => request.body?.query?.includes('SentinelOneGetManyAlerts'));
}

function hasMetadata(ctx) {
	return ctx.requests.some((request) => request.body?.query?.includes('alertColumnMetadata'));
}

function triggerContext(parameters = {}, metadataResponse = metadata) {
	const contextId = nextContextId++;
	const requests = [];
	const values = {
		resource: 'alert',
		operation: 'new',
		accountIds: ['account-1'],
		options: {},
		alertFilters: {},
		alertFilterMatch: 'all',
		...parameters,
	};
	const staticData = {};
	return {
		requests,
		staticData,
		getMode: () => 'manual',
		getNode: () => ({
			id: 'trigger-node',
			name: 'Alert Trigger',
			parameters: values,
			credentials: { sentinelOnePlatformApi: { id: `trigger-filter-test-${contextId}` } },
		}),
		getCredentials: async () => ({ baseUrl: 'https://tenant.example', apiToken: 'test-token' }),
		getWorkflow: () => ({ id: 'trigger-workflow' }),
		getTimezone: () => 'UTC',
		getNodeParameter: (name, fallback) => values[name] ?? fallback,
		getWorkflowStaticData: () => staticData,
		logger: { debug() {}, info() {}, warn() {} },
		helpers: {
			returnJsonArray: (items) => items.map((json) => ({ json })),
			async httpRequestWithAuthentication(_credential, request) {
				requests.push(request);
				if (request.url.endsWith('/accounts'))
					return { data: [{ id: 'account-1', name: 'Example' }] };
				if (request.url.endsWith('/sites')) return { data: { sites: [] } };
				if (request.body?.query?.includes('alertColumnMetadata'))
					return { data: { alertColumnMetadata: metadataResponse } };
				return {
					data: {
						alerts: {
							edges: [],
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				};
			},
		},
	};
}

function triggerQuery(ctx) {
	return ctx.requests.find(
		(request) =>
			request.url.endsWith('/unifiedalerts/graphql') &&
			!request.body?.query?.includes('alertColumnMetadata'),
	);
}

test('Get Many preserves the legacy filter request and skips metadata when no Alert Filters rows are present', async () => {
	const ctx = actionContext({
		filters: { severities: ['HIGH'], statuses: ['NEW'], ticketId: 'CASE-7' },
	});
	await getManyUnifiedAlerts(ctx, 0);
	assert.deepEqual(actionQuery(ctx).body.variables, {
		first: 5,
		scope: null,
		viewType: 'ALL',
		filters: [
			{ fieldId: 'severity', stringIn: { values: ['HIGH'] } },
			{ fieldId: 'status', stringIn: { values: ['NEW'] } },
			{ fieldId: 'ticketId', stringEqual: { value: 'CASE-7' } },
		],
		sorts: [{ by: 'createdAt', order: 'DESC' }],
	});
	assert.equal(hasMetadata(ctx), false);
});

test('Get Many retries temporary metadata 503 errors and disables cross-origin credentials', async () => {
	const ctx = actionContext(
		{
			alertFilters: {
				filter: [{ fieldId: 'alertName', comparator: 'contains', value: 'retry-marker' }],
			},
		},
		(attempt) => {
			if (attempt === 1) {
				const error = new Error('temporary service unavailable');
				error.statusCode = 503;
				throw error;
			}
			return { data: { alertColumnMetadata: metadata } };
		},
	);
	await getManyUnifiedAlerts(ctx, 0);
	const metadataRequests = ctx.requests.filter((request) =>
		request.body?.query?.includes('alertColumnMetadata'),
	);
	assert.equal(metadataRequests.length, 2);
	assert.ok(
		metadataRequests.every((request) => request.sendCredentialsOnCrossOriginRedirect === false),
	);
	assert.ok(actionQuery(ctx));
});

test('Get Many preserves metadata 401 status and does not issue an alert query', async () => {
	const ctx = actionContext(
		{
			alertFilters: {
				filter: [{ fieldId: 'alertName', comparator: 'contains', value: 'auth-marker' }],
			},
		},
		() => {
			const error = new Error('unauthorized');
			error.statusCode = 401;
			throw error;
		},
	);
	await assert.rejects(getManyUnifiedAlerts(ctx, 0), (error) => {
		assert.equal(error.statusCode, 401);
		assert.equal(error.httpCode, '401');
		return true;
	});
	assert.equal(
		ctx.requests.filter((request) => request.body?.query?.includes('alertColumnMetadata')).length,
		1,
	);
	assert.equal(actionQuery(ctx), undefined);
});

test('Get Many combines legacy status, Alert Filters, and Advanced Filters with Match All', async () => {
	const ctx = actionContext({
		filters: { statuses: ['NEW'] },
		alertFilters: {
			filter: [{ fieldId: 'alertName', comparator: 'contains', value: 'synthetic-marker' }],
		},
		alertFilterMatch: 'all',
		options: {
			advancedFilters: JSON.stringify([
				{ fieldId: 'ticketId', stringEqual: { value: 'CASE-7' }, isNegated: true },
			]),
		},
	});
	await getManyUnifiedAlerts(ctx, 0);
	assert.deepEqual(actionQuery(ctx).body.variables.filters, [
		{ fieldId: 'status', stringIn: { values: ['NEW'] } },
		{ fieldId: 'alertName', match: { operator: 'contains', values: ['synthetic-marker'] } },
		{ fieldId: 'ticketId', stringEqual: { value: 'CASE-7' }, isNegated: true },
	]);
	assert.equal(actionQuery(ctx).body.variables.orFilter, undefined);
	assert.equal(hasMetadata(ctx), true);
});

test('Get Many encodes an excluded ticketId contains row without requiring a value for boolean comparators', async () => {
	const ctx = actionContext({
		alertFilters: {
			filter: [
				{
					fieldId: 'ticketId',
					comparator: 'contains',
					value: 'SYNTHETIC-TICKET-MARKER',
					exclude: true,
				},
				{ fieldId: 'ticketIdExists', comparator: 'isTrue' },
			],
		},
	});
	await getManyUnifiedAlerts(ctx, 0);
	assert.deepEqual(actionQuery(ctx).body.variables.filters, [
		{
			fieldId: 'ticketId',
			match: { operator: 'contains', values: ['SYNTHETIC-TICKET-MARKER'] },
			isNegated: true,
		},
		{ fieldId: 'ticketIdExists', booleanEqual: { value: true } },
	]);
});

test('Get Many Match Any creates one OR branch per filter row and Advanced Filters group', async () => {
	const ctx = actionContext({
		filters: { statuses: ['NEW'] },
		alertFilters: {
			filter: [
				{ fieldId: 'alertName', comparator: 'contains', value: 'alpha' },
				{
					fieldId: 'ticketId',
					comparator: 'contains',
					value: 'SYNTHETIC-EXCLUDED-17',
					exclude: true,
				},
			],
		},
		alertFilterMatch: 'any',
		options: {
			advancedFilters: JSON.stringify({
				or: [
					{ and: [{ fieldId: 'ticketId', stringEqual: { value: 'CASE-A' } }] },
					{ and: [{ fieldId: 'ticketId', stringEqual: { value: 'CASE-B' } }] },
				],
			}),
		},
	});
	await getManyUnifiedAlerts(ctx, 0);
	const { filters, orFilter } = actionQuery(ctx).body.variables;
	assert.equal(filters, null);
	assert.deepEqual(
		orFilter.or.map((group) => group.and),
		[
			[
				{ fieldId: 'status', stringIn: { values: ['NEW'] } },
				{ fieldId: 'alertName', match: { operator: 'contains', values: ['alpha'] } },
				{ fieldId: 'ticketId', stringEqual: { value: 'CASE-A' } },
			],
			[
				{ fieldId: 'status', stringIn: { values: ['NEW'] } },
				{ fieldId: 'alertName', match: { operator: 'contains', values: ['alpha'] } },
				{ fieldId: 'ticketId', stringEqual: { value: 'CASE-B' } },
			],
			[
				{ fieldId: 'status', stringIn: { values: ['NEW'] } },
				{
					fieldId: 'ticketId',
					match: { operator: 'contains', values: ['SYNTHETIC-EXCLUDED-17'] },
					isNegated: true,
				},
				{ fieldId: 'ticketId', stringEqual: { value: 'CASE-A' } },
			],
			[
				{ fieldId: 'status', stringIn: { values: ['NEW'] } },
				{
					fieldId: 'ticketId',
					match: { operator: 'contains', values: ['SYNTHETIC-EXCLUDED-17'] },
					isNegated: true,
				},
				{ fieldId: 'ticketId', stringEqual: { value: 'CASE-B' } },
			],
		],
	);
});

test('Get Many and the trigger send the same encoded row filters', async () => {
	const row = {
		fieldId: 'alertName',
		comparator: 'contains',
		value: 'synthetic-parity-marker',
		exclude: true,
	};
	const action = actionContext({ alertFilters: { filter: [row] } });
	await getManyUnifiedAlerts(action, 0);
	const trigger = triggerContext({ alertFilters: { filter: [row] } });
	await new SentinelOnePlatformTrigger().poll.call(trigger);
	const actionFilters = actionQuery(action).body.variables.filters;
	const triggerFilters = triggerQuery(trigger).body.variables.filters.filter(
		(filter) => filter.fieldId !== 'createdAt',
	);
	assert.deepEqual(actionFilters, triggerFilters);
});

for (const [name, parameters, pattern, metadataResponse] of [
	[
		'unsupported comparator',
		{ alertFilters: { filter: [{ fieldId: 'ticketId', comparator: 'contains', value: 'x' }] } },
		/Contains is not available for this field/,
		[
			{ fieldId: 'alertName', filterTypes: ['FULLTEXT'], enableNegation: true },
			{ fieldId: 'ticketId', filterTypes: ['STRING_IN'], enableNegation: true },
		],
	],
	[
		'unsupported negation',
		{
			alertFilters: {
				filter: [{ fieldId: 'alertName', comparator: 'contains', value: 'x', exclude: true }],
			},
		},
		/Exclude is not available for this field/,
		[{ fieldId: 'alertName', filterTypes: ['FULLTEXT'], enableNegation: false }],
	],
	[
		'empty text',
		{
			alertFilters: { filter: [{ fieldId: 'alertName', comparator: 'contains', value: '  \n ' }] },
		},
		/needs at least one value/,
		metadata,
	],
]) {
	test(`Get Many rejects ${name} before issuing the alert query`, async () => {
		const ctx = actionContext(parameters, metadataResponse);
		await assert.rejects(getManyUnifiedAlerts(ctx, 0), pattern);
		assert.equal(actionQuery(ctx), undefined);
		if (name === 'empty text') assert.equal(hasMetadata(ctx), false);
	});
}

test('Get Many rejects more than 20 combined OR groups before the alert query', async () => {
	const ctx = actionContext({
		alertFilters: {
			filter: Array.from({ length: 3 }, (_, index) => ({
				fieldId: 'alertName',
				comparator: 'contains',
				value: `filter-${index}`,
			})),
		},
		alertFilterMatch: 'any',
		options: {
			advancedFilters: JSON.stringify({
				or: Array.from({ length: 7 }, (_, index) => ({
					and: [{ fieldId: 'ticketId', stringEqual: { value: `CASE-${index}` } }],
				})),
			}),
		},
	});
	await assert.rejects(getManyUnifiedAlerts(ctx, 0), /21 groups and up to 2 filters per group/);
	assert.equal(actionQuery(ctx), undefined);
});

test('Get Many permits 100 filters in one group and rejects 101', async () => {
	const advancedFilters = (length) =>
		Array.from({ length }, (_, index) => ({
			fieldId: 'ticketId',
			stringEqual: { value: `CASE-${index}` },
		}));
	const allowed = actionContext({ options: { advancedFilters: advancedFilters(100) } });
	await getManyUnifiedAlerts(allowed, 0);
	assert.equal(actionQuery(allowed).body.variables.filters.length, 100);

	const rejected = actionContext({ options: { advancedFilters: advancedFilters(101) } });
	await assert.rejects(getManyUnifiedAlerts(rejected, 0), /up to 101 filters per group/);
	assert.equal(actionQuery(rejected), undefined);
});

test('Get Many exposes Alert Filters and Advanced Filters for the getAll operation', () => {
	const properties = new SentinelOnePlatform().description.properties;
	const alertFilters = properties.find((property) => property.name === 'alertFilters');
	const options = properties.find(
		(property) =>
			property.name === 'options' && property.displayOptions?.show?.operation?.includes('getAll'),
	);
	const advancedFilters = options.options.find((property) => property.name === 'advancedFilters');
	assert.ok(alertFilters);
	assert.deepEqual(alertFilters.displayOptions.show.operation, ['getAll']);
	assert.ok(advancedFilters);
	assert.deepEqual(options.displayOptions.show.operation, ['getAll']);
});

test('Action and trigger share Alert Filter load option methods', () => {
	const action = new SentinelOnePlatform();
	const trigger = new SentinelOnePlatformTrigger();
	assert.equal(
		action.methods.loadOptions.getAlertFilterFields,
		trigger.methods.loadOptions.getAlertFilterFields,
	);
	assert.equal(
		action.methods.loadOptions.getAlertFilterComparators,
		trigger.methods.loadOptions.getAlertFilterComparators,
	);
});
