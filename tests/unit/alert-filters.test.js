const assert = require('node:assert/strict');
const test = require('node:test');
const {
	SentinelOnePlatformTrigger,
} = require('../../dist/nodes/SentinelOnePlatformTrigger/SentinelOnePlatformTrigger.node.js');

const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const metadata = [
	{
		fieldId: 'ticketIdExists',
		filterTypes: ['BOOLEAN_EQUAL'],
		enableNegation: false,
	},
	{
		fieldId: 'alertName',
		filterTypes: ['FULLTEXT', 'STRING_IN'],
		enableNegation: true,
	},
	{
		fieldId: 'createdAt',
		filterTypes: ['DATE_RANGE'],
		enableNegation: true,
	},
	{ fieldId: 'unfilterableField', filterTypes: [], enableNegation: false },
	{ fieldId: 'legacyNullTypes', filterTypes: null, enableNegation: false },
	{ fieldId: 'legacyMissingTypes', enableNegation: false },
];

function filterMatches(alert, filter) {
	const field = filter.fieldId === 'alertName' ? 'name' : filter.fieldId;
	const value = alert[field];
	let matches = true;
	if (filter.dateTimeRange) {
		const timestamp = Date.parse(value);
		const range = filter.dateTimeRange;
		matches =
			Number.isFinite(timestamp) &&
			(range.start === undefined || timestamp >= range.start) &&
			(range.end === undefined || timestamp <= range.end);
	} else if (filter.stringIn) {
		matches = filter.stringIn.values.includes(value);
	} else if (filter.stringEqual) {
		matches = value === filter.stringEqual.value;
	} else if (filter.booleanEqual) {
		matches = value === filter.booleanEqual.value;
	} else if (filter.match) {
		const actual = String(value ?? '').toLowerCase();
		const expected = filter.match.values.map((entry) => String(entry).toLowerCase());
		const operator = filter.match.operator ?? 'contains';
		matches = expected.some((entry) => {
			if (operator === 'startsWith') return actual.startsWith(entry);
			if (operator === 'endsWith') return actual.endsWith(entry);
			if (operator === 'exactMatch') return actual === entry;
			return actual.includes(entry);
		});
	}
	return filter.isNegated === true ? !matches : matches;
}

function context(
	id,
	params = {},
	{ mode = 'manual', metadataResponse = metadata, alerts = [] } = {},
) {
	const requests = [];
	const staticData = {};
	const parameters = {
		resource: 'alert',
		operation: 'new',
		accountIds: ['account-1'],
		alertFilters: {},
		alertFilterMatch: 'all',
		options: {},
		...params,
	};
	return {
		requests,
		staticData,
		parameters,
		logger: { debug() {}, info() {}, warn() {} },
		getCredentials: async () => ({ baseUrl: 'https://tenant.example', apiToken: 'test-token' }),
		getMode: () => mode,
		getNode: () => ({
			id: 'node-1',
			name: 'Alert Trigger',
			credentials: { sentinelOnePlatformApi: { id: 'credential-1' } },
		}),
		getWorkflow: () => ({ id }),
		getNodeParameter: (name, fallback) => parameters[name] ?? fallback,
		getWorkflowStaticData: () => staticData,
		helpers: {
			returnJsonArray: (items) => items.map((json) => ({ json })),
			async httpRequestWithAuthentication(_credential, request) {
				requests.push(request);
				if (request.url.endsWith('/accounts'))
					return { data: [{ id: 'account-1', name: 'Example account' }] };
				if (request.body?.query?.includes('alertColumnMetadata'))
					return { data: { alertColumnMetadata: metadataResponse } };
				const { filters, orFilter, first, after } = request.body.variables;
				const matches = alerts.filter((alert) =>
					orFilter
						? orFilter.or.some((group) => group.and.every((filter) => filterMatches(alert, filter)))
						: filters.every((filter) => filterMatches(alert, filter)),
				);
				const offset = Number(after ?? 0);
				const page = matches.slice(offset, offset + first);
				return {
					data: {
						alerts: {
							edges: page.map((node) => ({ node })),
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

async function poll(params, options = {}) {
	const trigger = new SentinelOnePlatformTrigger();
	const ctx = context(`alert-filters-${Math.random()}`, params, options);
	const originalNow = Date.now;
	Date.now = () => NOW;
	try {
		return { ctx, result: await trigger.poll.call(ctx) };
	} finally {
		Date.now = originalNow;
	}
}

function alertQuery(ctx) {
	return ctx.requests.find(
		(request) =>
			request.url.endsWith('/unifiedalerts/graphql') &&
			!request.body?.query?.includes('alertColumnMetadata'),
	);
}

function hasMetadataRequest(ctx) {
	return ctx.requests.some((request) => request.body?.query?.includes('alertColumnMetadata'));
}

function assertBaseFilters(variables) {
	const groups = variables.orFilter
		? variables.orFilter.or.map((group) => group.and)
		: [variables.filters];
	for (const filters of groups) {
		assert.ok(filters.some((filter) => filter.fieldId === 'createdAt' && filter.dateTimeRange));
		assert.ok(
			filters.some(
				(filter) => filter.fieldId === 'severity' && filter.stringIn?.values.includes('HIGH'),
			),
		);
		assert.ok(
			filters.some(
				(filter) => filter.fieldId === 'status' && filter.stringIn?.values.includes('NEW'),
			),
		);
		assert.ok(
			filters.some(
				(filter) => filter.fieldId === 'alertName' && filter.match?.values.includes('Base alert'),
			),
		);
	}
}

const rowCases = [
	[
		'contains',
		{
			fieldId: 'alertName',
			comparator: 'contains',
			value: '  Alpha  \n \tBeta \n  ',
			exclude: true,
		},
		{
			fieldId: 'alertName',
			match: { operator: 'contains', values: ['Alpha', 'Beta'] },
			isNegated: true,
		},
	],
	[
		'startsWith',
		{ fieldId: 'alertName', comparator: 'startsWith', value: 'Alpha' },
		{ fieldId: 'alertName', match: { operator: 'startsWith', values: ['Alpha'] } },
	],
	[
		'endsWith',
		{ fieldId: 'alertName', comparator: 'endsWith', value: 'Alpha' },
		{ fieldId: 'alertName', match: { operator: 'endsWith', values: ['Alpha'] } },
	],
	[
		'exactMatch',
		{ fieldId: 'alertName', comparator: 'exactMatch', value: 'Alpha' },
		{ fieldId: 'alertName', match: { operator: 'exactMatch', values: ['Alpha'] } },
	],
	[
		'stringIn',
		{ fieldId: 'alertName', comparator: 'stringIn', value: 'HIGH\nCRITICAL' },
		{ fieldId: 'alertName', stringIn: { values: ['HIGH', 'CRITICAL'] } },
	],
	[
		'isTrue',
		{ fieldId: 'ticketIdExists', comparator: 'isTrue' },
		{ fieldId: 'ticketIdExists', booleanEqual: { value: true } },
	],
	[
		'isFalse',
		{ fieldId: 'ticketIdExists', comparator: 'isFalse' },
		{ fieldId: 'ticketIdExists', booleanEqual: { value: false } },
	],
	[
		'after',
		{ fieldId: 'createdAt', comparator: 'after', date: '2026-10-01T00:00:00.000Z' },
		{ fieldId: 'createdAt', dateTimeRange: { start: Date.parse('2026-10-01T00:00:00.000Z') } },
	],
	[
		'before',
		{ fieldId: 'createdAt', comparator: 'before', date: '2026-10-01T00:00:00.000Z' },
		{ fieldId: 'createdAt', dateTimeRange: { end: Date.parse('2026-10-01T00:00:00.000Z') } },
	],
];

for (const [name, row, expected] of rowCases) {
	test(`alert filter ${name} maps to an API filter through the trigger`, async () => {
		const { ctx } = await poll({ alertFilters: { filter: [row] } });
		assert.deepEqual(
			alertQuery(ctx).body.variables.filters.findLast(
				(filter) => filter.fieldId === expected.fieldId,
			),
			expected,
		);
		assert.equal(
			ctx.requests.filter((request) => request.body?.query?.includes('alertColumnMetadata')).length,
			1,
		);
	});
}

const combinationCases = [
	{
		name: 'Match All with an Advanced Filters array',
		match: 'all',
		advanced: [{ fieldId: 'ticketId', stringEqual: { value: 'CASE-1' } }],
		check(variables, row) {
			assert.equal(variables.orFilter, null);
			assert.deepEqual(variables.filters.at(-2), row);
			assert.deepEqual(variables.filters.at(-1), {
				fieldId: 'ticketId',
				stringEqual: { value: 'CASE-1' },
			});
		},
	},
	{
		name: 'Match All with Advanced Filters OR groups',
		match: 'all',
		advanced: {
			or: [
				{ and: [{ fieldId: 'ticketId', stringEqual: { value: 'CASE-1' } }] },
				{ and: [{ fieldId: 'ticketId', stringEqual: { value: 'CASE-2' } }] },
			],
		},
		check(variables, row) {
			assert.equal(variables.filters, null);
			assert.equal(variables.orFilter.or.length, 2);
			for (const group of variables.orFilter.or) assert.deepEqual(group.and.at(-2), row);
		},
	},
	{
		name: 'Match Any with an Advanced Filters array',
		match: 'any',
		advanced: [{ fieldId: 'ticketId', stringEqual: { value: 'CASE-1' } }],
		check(variables, row) {
			assert.equal(variables.filters, null);
			assert.equal(variables.orFilter.or.length, 2);
			assert.deepEqual(
				variables.orFilter.or.map((group) => group.and.slice(-2)),
				[
					[row[0], { fieldId: 'ticketId', stringEqual: { value: 'CASE-1' } }],
					[row[1], { fieldId: 'ticketId', stringEqual: { value: 'CASE-1' } }],
				],
			);
		},
		rows: [
			{ fieldId: 'alertName', comparator: 'contains', value: 'Alpha' },
			{ fieldId: 'alertName', comparator: 'stringIn', value: 'Beta' },
		],
	},
	{
		name: 'Match Any with Advanced Filters OR groups',
		match: 'any',
		advanced: {
			or: [
				{ and: [{ fieldId: 'ticketId', stringEqual: { value: 'CASE-1' } }] },
				{ and: [{ fieldId: 'ticketId', stringEqual: { value: 'CASE-2' } }] },
			],
		},
		rows: [
			{ fieldId: 'alertName', comparator: 'contains', value: 'Alpha' },
			{ fieldId: 'alertName', comparator: 'stringIn', value: 'Beta' },
		],
		check(variables, row) {
			assert.equal(variables.filters, null);
			assert.equal(variables.orFilter.or.length, 4);
			assert.deepEqual(
				variables.orFilter.or.map((group) => [group.and.at(-2), group.and.at(-1)]),
				[
					[row[0], { fieldId: 'ticketId', stringEqual: { value: 'CASE-1' } }],
					[row[0], { fieldId: 'ticketId', stringEqual: { value: 'CASE-2' } }],
					[row[1], { fieldId: 'ticketId', stringEqual: { value: 'CASE-1' } }],
					[row[1], { fieldId: 'ticketId', stringEqual: { value: 'CASE-2' } }],
				],
			);
		},
	},
];

for (const combination of combinationCases) {
	test(`trigger combines ${combination.name}`, async () => {
		const inputRows = combination.rows ?? [
			{ fieldId: 'alertName', comparator: 'contains', value: 'Alpha' },
		];
		const { ctx } = await poll({
			alertFilters: { filter: inputRows },
			alertFilterMatch: combination.match,
			options: {
				severities: ['HIGH'],
				statuses: ['NEW'],
				alertName: 'Base alert',
				advancedFilters: JSON.stringify(combination.advanced),
			},
		});
		const rows = inputRows.map((entry) => {
			if (entry.comparator === 'stringIn')
				return { fieldId: entry.fieldId, stringIn: { values: [entry.value] } };
			return {
				fieldId: entry.fieldId,
				match: { operator: entry.comparator, values: [entry.value] },
			};
		});
		const variables = alertQuery(ctx).body.variables;
		assertBaseFilters(variables);
		combination.check(variables, rows.length === 1 ? rows[0] : rows);
	});
}

test('Match Any cross product emits alerts matching a filter row and an Advanced Filters branch', async () => {
	const alerts = [
		{
			id: 'alpha-case-b',
			name: 'Base alert Alpha',
			severity: 'HIGH',
			status: 'NEW',
			ticketId: 'CASE-B',
			createdAt: new Date(NOW - 60_000).toISOString(),
			updatedAt: new Date(NOW - 60_000).toISOString(),
			realTime: { scope: { account: { id: 'account-1', name: 'Example account' } } },
		},
		{
			id: 'beta-case-a',
			name: 'Base alert Beta',
			severity: 'HIGH',
			status: 'NEW',
			ticketId: 'CASE-A',
			createdAt: new Date(NOW - 55_000).toISOString(),
			updatedAt: new Date(NOW - 55_000).toISOString(),
			realTime: { scope: { account: { id: 'account-1', name: 'Example account' } } },
		},
		{
			id: 'alpha-wrong-ticket',
			name: 'Base alert Alpha',
			severity: 'HIGH',
			status: 'NEW',
			ticketId: 'CASE-X',
			createdAt: new Date(NOW - 50_000).toISOString(),
			updatedAt: new Date(NOW - 50_000).toISOString(),
			realTime: { scope: { account: { id: 'account-1', name: 'Example account' } } },
		},
		{
			id: 'low-severity',
			name: 'Base alert Alpha',
			severity: 'LOW',
			status: 'NEW',
			ticketId: 'CASE-A',
			createdAt: new Date(NOW - 45_000).toISOString(),
			updatedAt: new Date(NOW - 45_000).toISOString(),
			realTime: { scope: { account: { id: 'account-1', name: 'Example account' } } },
		},
	];
	const { ctx, result } = await poll(
		{
			alertFilters: {
				filter: [
					{ fieldId: 'alertName', comparator: 'contains', value: 'Alpha' },
					{ fieldId: 'alertName', comparator: 'contains', value: 'Beta' },
				],
			},
			alertFilterMatch: 'any',
			options: {
				severities: ['HIGH'],
				statuses: ['NEW'],
				alertName: 'Base alert',
				advancedFilters: JSON.stringify({
					or: [
						{ and: [{ fieldId: 'ticketId', stringEqual: { value: 'CASE-A' } }] },
						{ and: [{ fieldId: 'ticketId', stringEqual: { value: 'CASE-B' } }] },
					],
				}),
			},
		},
		{ alerts },
	);
	assertBaseFilters(alertQuery(ctx).body.variables);
	assert.deepEqual(
		result[0].map((item) => item.json.id),
		['alpha-case-b', 'beta-case-a'],
	);
});

test('Match Any rejects a filter and Advanced Filters cross product over 20 groups', async () => {
	const rows = Array.from({ length: 3 }, (_, index) => ({
		fieldId: 'alertName',
		comparator: 'contains',
		value: `Name ${index}`,
	}));
	const advanced = {
		or: Array.from({ length: 7 }, (_, index) => ({
			and: [{ fieldId: 'ticketId', stringEqual: { value: `CASE-${index}` } }],
		})),
	};
	const trigger = new SentinelOnePlatformTrigger();
	const ctx = context('alert-filters-over-limit', {
		alertFilters: { filter: rows },
		alertFilterMatch: 'any',
		options: { advancedFilters: JSON.stringify(advanced) },
	});
	await assert.rejects(trigger.poll.call(ctx), /at most 20 OR groups/);
	assert.equal(alertQuery(ctx), undefined);
});

for (const [name, input, metadataResponse, message] of [
	[
		'unknown field',
		{ fieldId: 'notAField', comparator: 'contains', value: 'x' },
		metadata,
		/notAField is not a filterable field/,
	],
	[
		'name alias points to alertName',
		{ fieldId: 'name', comparator: 'contains', value: 'x' },
		metadata,
		/name is not a filterable field\. Use alertName instead/,
	],
	[
		'comparator unsupported by field metadata',
		{ fieldId: 'ticketIdExists', comparator: 'contains', value: 'x' },
		metadata,
		/ticketIdExists does not support match/,
	],
	[
		'Exclude unsupported by field metadata',
		{ fieldId: 'ticketIdExists', comparator: 'isTrue', exclude: true },
		metadata,
		/ticketIdExists does not support Exclude/,
	],
]) {
	test(`alert filter validation rejects ${name}`, async () => {
		const trigger = new SentinelOnePlatformTrigger();
		const ctx = context(
			`alert-filter-invalid-${name}`,
			{
				alertFilters: { filter: [input] },
			},
			{ metadataResponse },
		);
		await assert.rejects(trigger.poll.call(ctx), message);
		assert.equal(alertQuery(ctx), undefined);
	});
}

for (const [name, row, message] of [
	[
		'empty text values',
		{ fieldId: 'alertName', comparator: 'contains', value: ' \n ' },
		/needs at least one value/,
	],
	[
		'invalid date',
		{ fieldId: 'createdAt', comparator: 'after', date: 'not-a-date' },
		/needs a valid date/,
	],
	[
		'unknown comparator',
		{ fieldId: 'alertName', comparator: 'fuzzy', value: 'x' },
		/does not support fuzzy/,
	],
]) {
	test(`alert filter parsing rejects ${name} before metadata lookup`, async () => {
		const trigger = new SentinelOnePlatformTrigger();
		const ctx = context(`alert-filter-parse-${name}`, { alertFilters: { filter: [row] } });
		await assert.rejects(trigger.poll.call(ctx), message);
		assert.equal(hasMetadataRequest(ctx), false);
		assert.equal(alertQuery(ctx), undefined);
	});
}

for (const [name, row] of [
	['null row', null],
	['array row', []],
	['string row', 'not a filter object'],
]) {
	test(`alert filter parsing rejects an invalid ${name}`, async () => {
		const trigger = new SentinelOnePlatformTrigger();
		const ctx = context(`alert-filter-invalid-row-${name}`, {
			alertFilters: { filter: [row] },
		});
		await assert.rejects(trigger.poll.call(ctx), /each row must be a filter/);
		assert.equal(hasMetadataRequest(ctx), false);
		assert.equal(alertQuery(ctx), undefined);
	});
}

test('Alert filter field options are sorted and omit fields with null, missing, or empty filter types', async () => {
	const trigger = new SentinelOnePlatformTrigger();
	const ctx = context('alert-filter-options', {});
	const fields = await trigger.methods.loadOptions.getAlertFilterFields.call(ctx);
	assert.deepEqual(fields, [
		{ name: 'alertName', value: 'alertName' },
		{ name: 'createdAt', value: 'createdAt' },
		{ name: 'ticketIdExists', value: 'ticketIdExists' },
	]);
	assert.equal(ctx.requests.length, 1);
	assert.equal(ctx.requests[0].method, 'POST');
	assert.equal(ctx.requests[0].url, 'https://tenant.example/web/api/v2.1/unifiedalerts/graphql');
});

test('Alert filter field metadata failures are surfaced as a load option error', async () => {
	const trigger = new SentinelOnePlatformTrigger();
	const ctx = context('alert-filter-options-failure', {}, { metadataResponse: [] });
	ctx.helpers.httpRequestWithAuthentication = async (_credential, request) => {
		ctx.requests.push(request);
		return { data: { errors: [{ message: 'fixture failure' }] } };
	};
	await assert.rejects(
		trigger.methods.loadOptions.getAlertFilterFields.call(ctx),
		/Unable to load SentinelOne alert filter fields/,
	);
});

test('Alert filter field loading preserves authentication status errors', async () => {
	const trigger = new SentinelOnePlatformTrigger();
	const ctx = context('alert-filter-options-unauthorized', {});
	ctx.helpers.httpRequestWithAuthentication = async (_credential, request) => {
		ctx.requests.push(request);
		throw { statusCode: 401 };
	};
	await assert.rejects(
		trigger.methods.loadOptions.getAlertFilterFields.call(ctx),
		(error) => error.statusCode === 401,
	);
});

test('default alert filters skip metadata lookup', async () => {
	const { ctx } = await poll({});
	assert.equal(hasMetadataRequest(ctx), false);
	assert.ok(alertQuery(ctx));
});

test('scheduled polls skip metadata lookup after an empty activation poll loses static data', async () => {
	const trigger = new SentinelOnePlatformTrigger();
	const params = {
		alertFilters: { filter: [{ fieldId: 'alertName', comparator: 'contains', value: 'Alpha' }] },
	};
	const activation = context('alert-filter-steady-state', params, { mode: 'scheduled' });
	const originalNow = Date.now;
	let currentTime = NOW;
	Date.now = () => currentTime;
	try {
		await trigger.poll.call(activation);
		currentTime += 60_000;
		const scheduled = context('alert-filter-steady-state', params, { mode: 'scheduled' });
		assert.deepEqual(scheduled.staticData, {}, 'n8n discards static data after an empty poll');
		await trigger.poll.call(scheduled);
		assert.equal(hasMetadataRequest(scheduled), false);
		assert.ok(alertQuery(scheduled));
	} finally {
		Date.now = originalNow;
	}
});
