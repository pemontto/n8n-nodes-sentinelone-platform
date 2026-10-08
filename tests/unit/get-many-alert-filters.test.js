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

function actionContext(parameters = {}, metadataResponse = metadata, alertResponse) {
	const contextId = nextContextId++;
	const requests = [];
	const logs = [];
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
		logs,
		parameters: values,
		getMode: () => values.mode ?? 'manual',
		getNode: () => ({
			id: 'action-node',
			name: 'SentinelOne',
			parameters: values,
			credentials: { sentinelOnePlatformApi: { id: `action-filter-test-${contextId}` } },
		}),
		getCredentials: async () => ({ baseUrl: 'https://tenant.example', apiToken: 'test-token' }),
		getNodeParameter: (name, _index, fallback) => values[name] ?? fallback,
		getWorkflow: () => ({ id: 'workflow' }),
		logger: {
			debug: (...args) => logs.push(['debug', ...args]),
			info: (...args) => logs.push(['info', ...args]),
			warn: (...args) => logs.push(['warn', ...args]),
		},
		helpers: {
			async httpRequestWithAuthentication(_credential, request) {
				requests.push(request);
				if (request.body?.query?.includes('alertColumnMetadata')) {
					if (typeof metadataResponse === 'function')
						return metadataResponse(
							requests.filter((entry) => entry.body?.query?.includes('alertColumnMetadata')).length,
							request,
						);
					return typeof metadataResponse === 'object' &&
						metadataResponse !== null &&
						!Array.isArray(metadataResponse)
						? metadataResponse
						: { data: { alertColumnMetadata: metadataResponse } };
				}
				if (typeof alertResponse === 'function') return alertResponse(request, requests);
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

test('Get Many fails a regular metadata error in manual mode', async () => {
	const ctx = actionContext(
		{
			alertFilters: {
				filter: [{ fieldId: 'alertName', comparator: 'contains', value: 'manual-marker' }],
			},
		},
		() => {
			const error = new Error('not found');
			error.statusCode = 404;
			throw error;
		},
	);

	await assert.rejects(getManyUnifiedAlerts(ctx, 0), (error) => {
		assert.equal(error.statusCode, 404);
		return true;
	});
	assert.equal(actionQuery(ctx), undefined);
});

test('Get Many warns and uses the original Alert Filters in non-manual mode after metadata 503', async () => {
	const row = { fieldId: 'alertName', comparator: 'contains', value: 'scheduled-marker' };
	const ctx = actionContext({ mode: 'trigger', alertFilters: { filter: [row] } }, () => {
		const error = new Error('temporary service unavailable');
		error.statusCode = 503;
		throw error;
	});

	await getManyUnifiedAlerts(ctx, 0);
	assert.equal(actionQuery(ctx).body.variables.filters[0].fieldId, 'alertName');
	assert.deepEqual(actionQuery(ctx).body.variables.filters[0].match, {
		operator: 'contains',
		values: ['scheduled-marker'],
	});
	assert.ok(ctx.logs.some(([level]) => level === 'warn'));
});

test('Get Many warns and continues after non-manual statusless metadata failures', async () => {
	const row = { fieldId: 'alertName', comparator: 'contains', value: 'scheduled-timeout-marker' };
	const ctx = actionContext({ mode: 'trigger', alertFilters: { filter: [row] } }, () => {
		throw Object.assign(new Error('metadata connection timed out'), { code: 'ETIMEDOUT' });
	});

	await getManyUnifiedAlerts(ctx, 0);
	assert.deepEqual(actionQuery(ctx).body.variables.filters[0].match, {
		operator: 'contains',
		values: ['scheduled-timeout-marker'],
	});
	assert.ok(ctx.logs.some(([level]) => level === 'warn'));
});

test('Get Many warns and continues after a non-manual GraphQL metadata error envelope', async () => {
	const row = { fieldId: 'alertName', comparator: 'contains', value: 'metadata-envelope-marker' };
	const ctx = actionContext(
		{ mode: 'trigger', alertFilters: { filter: [row] } },
		{ errors: [{ message: 'metadata lookup is unavailable' }] },
	);

	await getManyUnifiedAlerts(ctx, 0);
	assert.deepEqual(actionQuery(ctx).body.variables.filters[0].match, {
		operator: 'contains',
		values: ['metadata-envelope-marker'],
	});
	assert.ok(ctx.logs.some(([level]) => level === 'warn'));
});

test('Get Many keeps non-manual metadata authentication failures fatal', async (t) => {
	for (const status of [401, 403]) {
		await t.test(`HTTP ${status}`, async () => {
			const ctx = actionContext(
				{
					mode: 'trigger',
					alertFilters: {
						filter: [{ fieldId: 'alertName', comparator: 'contains', value: 'auth-marker' }],
					},
				},
				() => {
					const error = new Error('denied');
					error.statusCode = status;
					throw error;
				},
			);

			await assert.rejects(getManyUnifiedAlerts(ctx, 0), (error) => {
				assert.equal(error.statusCode, status);
				assert.equal(error.httpCode, String(status));
				return true;
			});
			assert.equal(actionQuery(ctx), undefined);
		});
	}
});

test('Get Many keeps metadata validation failures fatal in non-manual mode', async () => {
	const ctx = actionContext(
		{
			mode: 'trigger',
			alertFilters: {
				filter: [{ fieldId: 'alertName', comparator: 'contains', value: 'invalid-field-marker' }],
			},
		},
		[{ fieldId: 'alertName', filterTypes: ['STRING_IN'], enableNegation: true }],
	);

	await assert.rejects(getManyUnifiedAlerts(ctx, 0), /not available for this field/);
	assert.equal(actionQuery(ctx), undefined);
});

test('Get Many preserves manual metadata timeout and DNS details and item pairing', async (t) => {
	for (const [name, transportError, marker] of [
		[
			'timeout',
			Object.assign(new Error('connect ETIMEDOUT tenant.example'), { code: 'ETIMEDOUT' }),
			'timeout-marker',
		],
		[
			'DNS failure',
			Object.assign(new Error('getaddrinfo EAI_AGAIN tenant.example'), { code: 'EAI_AGAIN' }),
			'dns-marker',
		],
	]) {
		await t.test(name, async () => {
			const ctx = actionContext(
				{
					alertFilters: {
						filter: [{ fieldId: 'alertName', comparator: 'contains', value: marker }],
					},
				},
				async () => {
					throw transportError;
				},
			);

			await assert.rejects(getManyUnifiedAlerts(ctx, 7), (error) => {
				assert.equal(error.message, transportError.message);
				assert.equal(error.errorCode, transportError.code);
				assert.equal(error.cause, transportError);
				assert.equal(error.httpCode, undefined);
				assert.equal(error.context.itemIndex, 7);
				return true;
			});
		});
	}
});

test('Get Many includes the item index on metadata HTTP errors', async () => {
	const ctx = actionContext(
		{
			alertFilters: {
				filter: [{ fieldId: 'alertName', comparator: 'contains', value: 'http-marker' }],
			},
		},
		() => {
			const error = new Error('forbidden');
			error.statusCode = 403;
			throw error;
		},
	);

	await assert.rejects(getManyUnifiedAlerts(ctx, 4), (error) => {
		assert.equal(error.httpCode, '403');
		assert.equal(error.context.itemIndex, 4);
		return true;
	});
});

test('Get Many logs a redacted metadata request when Debug is enabled', async () => {
	const ctx = actionContext({
		nodeDebug: true,
		alertFilters: {
			filter: [{ fieldId: 'alertName', comparator: 'contains', value: 'private-filter-marker' }],
		},
	});

	await getManyUnifiedAlerts(ctx, 0);
	const debugLogs = ctx.logs.map((entry) => entry.slice(1).join(' ')).join('\n');
	assert.match(debugLogs, /SentinelOne GraphQL request/);
	assert.match(debugLogs, /alertColumnMetadata/);
	assert.doesNotMatch(debugLogs, /private-filter-marker/);
});

test('Get Many rejects an invalid saved Match Filters value', async () => {
	const ctx = actionContext({
		alertFilterMatch: 'first',
		alertFilters: {
			filter: [{ fieldId: 'alertName', comparator: 'contains', value: 'invalid-match-marker' }],
		},
	});

	await assert.rejects(getManyUnifiedAlerts(ctx, 0), /Match Filters must be All or Any/);
	assert.equal(hasMetadata(ctx), false);
	assert.equal(actionQuery(ctx), undefined);
});

test('Get Many deduplicates overlapping pages, preserves the first match, and limits unique alerts', async () => {
	const pages = [
		{
			data: {
				alerts: {
					edges: [
						{ cursor: 'edge-1', node: { id: 'alert-a', severity: 'HIGH' } },
						{ cursor: 'edge-2', node: { id: 'alert-a', severity: 'LOW' } },
						{ cursor: 'edge-3', node: { id: 'alert-b', severity: 'MEDIUM' } },
					],
					pageInfo: { hasNextPage: true, endCursor: 'page-1' },
				},
			},
		},
		{
			data: {
				alerts: {
					edges: [{ cursor: 'edge-4', node: { id: 'alert-a', severity: 'INFO' } }],
					pageInfo: { hasNextPage: true, endCursor: 'page-2' },
				},
			},
		},
		{
			data: {
				alerts: {
					edges: [{ cursor: 'edge-5', node: { id: 'alert-c', severity: 'LOW' } }],
					pageInfo: { hasNextPage: false, endCursor: 'page-3' },
				},
			},
		},
	];
	const ctx = actionContext(
		{
			limit: 3,
			alertFilters: {
				filter: [
					{ fieldId: 'alertName', comparator: 'contains', value: 'first-or-branch' },
					{ fieldId: 'ticketId', comparator: 'contains', value: 'second-or-branch' },
				],
			},
			alertFilterMatch: 'any',
		},
		metadata,
		() => pages.shift(),
	);

	const alerts = await getManyUnifiedAlerts(ctx, 0);
	assert.deepEqual(
		alerts.map(({ id }) => id),
		['alert-a', 'alert-b', 'alert-c'],
	);
	assert.equal(alerts[0].severity, 'HIGH');
	const alertRequests = ctx.requests.filter((request) =>
		request.body?.query?.includes('SentinelOneGetManyAlerts'),
	);
	assert.equal(alertRequests.length, 3);
	assert.equal(alertRequests[1].body.variables.after, 'page-1');
	assert.equal(alertRequests[2].body.variables.after, 'page-2');
	assert.ok(alertRequests[0].body.variables.orFilter);
});

test('Get Many Return All fails when pages repeat alert IDs with fresh cursors', async () => {
	let requestCount = 0;
	const ctx = actionContext({ returnAll: true }, metadata, () => {
		requestCount++;
		if (requestCount > 4) throw new Error('Fake alert API request limit exceeded.');
		return {
			data: {
				alerts: {
					edges: [
						{ cursor: `edge-${requestCount}-a`, node: { id: 'alert-a' } },
						{ cursor: `edge-${requestCount}-b`, node: { id: 'alert-b' } },
					],
					pageInfo: { hasNextPage: true, endCursor: `page-${requestCount}` },
				},
			},
		};
	});

	await assert.rejects(
		getManyUnifiedAlerts(ctx, 0),
		/SentinelOne returned an alert page with no new alerts\./,
	);
	assert.equal(requestCount, 4);
});

test('Get Many Return All applies its safety cap to unique alert IDs', async () => {
	const edges = [
		{ cursor: 'duplicate-1', node: { id: 'alert-duplicate' } },
		{ cursor: 'duplicate-2', node: { id: 'alert-duplicate' } },
		...Array.from({ length: 9_999 }, (_, index) => ({
			cursor: `edge-${index}`,
			node: { id: `alert-${index}` },
		})),
	];
	const ctx = actionContext({ returnAll: true }, metadata, () => ({
		data: {
			alerts: {
				edges,
				pageInfo: { hasNextPage: false, endCursor: null },
			},
		},
	}));

	const alerts = await getManyUnifiedAlerts(ctx, 0);
	assert.equal(alerts.length, 10_000);
	assert.equal(alerts[0].id, 'alert-duplicate');
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
	assert.match(advancedFilters.description, /ANDed with Filters and Alert Filters/);
	assert.match(advancedFilters.description, /docs\/actions\.md#get-many-filters/);
	assert.doesNotMatch(advancedFilters.description, /docs\/trigger\.md/);
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
