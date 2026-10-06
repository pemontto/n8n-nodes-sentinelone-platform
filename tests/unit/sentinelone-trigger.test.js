const {
	loadScopeOptions,
	discoverVisibleScopes,
	isScopePermissionError,
} = require('../../dist/nodes/shared/Scopes');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const test = require('node:test');
const { NodeApiError } = require('n8n-workflow');

const packageRoot = resolve('.');
const builtHelpers = join(
	packageRoot,
	'dist/nodes/SentinelOnePlatformTrigger/SentinelOneTriggerHelpers.js',
);
const builtNode = join(
	packageRoot,
	'dist/nodes/SentinelOnePlatformTrigger/SentinelOnePlatformTrigger.node.js',
);
const sourceHelpers = join(
	packageRoot,
	'nodes/SentinelOnePlatformTrigger/SentinelOneTriggerHelpers.ts',
);

const {
	MAX_SEEN_ALERT_IDS,
	MAX_SEEN_ALERT_VERSIONS,
	MAX_SCOPE_IDS_PER_QUERY,
	advancedFilterSelection,
	fingerprintConfig,
	TRIGGER_STATE_VERSION,
	pollSentinelOne,
} = require(existsSync(builtHelpers) ? builtHelpers : sourceHelpers);
const { SentinelOnePlatformTrigger } = existsSync(builtNode) ? require(builtNode) : {};

const NOW = Date.parse('2026-08-26T12:00:00.000Z');

function config(overrides = {}) {
	return {
		baseUrl: 'https://tenant.example',
		credentialIdentity: { type: 'sentinelOnePlatformApi', id: 'credential-1', name: 'Tenant' },
		scopeType: 'ACCOUNT',
		scopeIds: ['account-1'],
		allVisibleAccounts: false,
		events: ['alert.new'],
		severities: [],
		statuses: [],
		alertName: '',
		simplifyOutput: false,
		debug: false,
		overlapSeconds: 300,
		concurrentRequests: 5,
		requestTimeoutMs: 30_000,
		alertPageSize: 200,
		maxAlertPages: 25,
		...overrides,
	};
}

function initializedState(triggerConfig, overrides = {}) {
	const checkpointMs = overrides.checkpointMs ?? NOW - 60_000;
	const alertCursors = {};
	if (triggerConfig.events.includes('alert.new'))
		alertCursors['createdAt:fixture'] = { throughMs: checkpointMs, ids: [] };
	if (triggerConfig.events.includes('alert.updated'))
		alertCursors['updatedAt:fixture'] = { throughMs: checkpointMs, ids: [] };
	return {
		version: TRIGGER_STATE_VERSION,
		configFingerprint: fingerprintConfig(triggerConfig),
		initialized: true,
		activationMs: 0,
		checkpointMs,
		alertCursors,
		seenAlertIds: [],
		seenAlertVersions: [],
		...overrides,
	};
}

function alertIdentity(record, scopeId = 'account-1') {
	return `${record.id}\u0000${record.createdAt}\u0000${scopeId}`;
}

function alert(id, createdAt = '2026-08-26T11:59:00.000Z', updatedAt = createdAt) {
	return {
		id,
		externalId: `external-${id}`,
		name: `Alert ${id}`,
		severity: 'HIGH',
		status: 'NEW',
		createdAt,
		updatedAt,
		detectedAt: createdAt,
		firstSeenAt: createdAt,
		lastSeenAt: updatedAt,
		noteExists: false,
		realTime: {
			scope: {
				account: { id: 'account-1', name: 'Account One' },
				site: { id: 'site-1', name: 'Site One' },
				group: { id: 'group-1', name: 'Group One' },
			},
		},
	};
}

function alertWithNotes(id, createdAt = '2026-08-26T11:59:00.000Z', updatedAt = createdAt) {
	return { ...alert(id, createdAt, updatedAt), noteExists: true };
}

function alertResponse(alerts, pageInfo = { hasNextPage: false, endCursor: null }) {
	return {
		data: {
			alerts: {
				edges: alerts.map((node) => ({ node })),
				pageInfo,
			},
		},
	};
}

function queryVariables(options) {
	return options.body.variables;
}

function createNodeContext(params, request, mode = 'manual') {
	const staticData = {};
	return {
		staticData,
		logger: { debug: () => {}, info: () => {}, warn: () => {} },
		helpers: {
			httpRequestWithAuthentication: async (_credentialName, options) => await request(options),
			returnJsonArray: (items) => items.map((json) => ({ json })),
		},
		getCredentials: async () => ({ baseUrl: 'https://tenant.example', apiToken: 'hidden' }),
		getMode: () => mode,
		getNode: () => ({
			id: 'node-1',
			credentials: { sentinelOnePlatformApi: { id: 'credential-1', name: 'Tenant' } },
		}),
		getNodeParameter: (name, fallback) => params[name] ?? fallback,
		getWorkflowStaticData: () => staticData,
		getWorkflow: () => ({ id: 'workflow-1' }),
	};
}

test('trigger polling preserves sanitised HTTP status and distinguishes authentication from permission errors', async () => {
	const node = new SentinelOnePlatformTrigger();
	const messages = new Map();
	for (const statusCode of [401, 403, 429]) {
		const now = Date.now();
		const context = createNodeContext(
			{
				resource: 'alertActivity',
				operation: 'occurred',
				activityTypes: ['16007'],
				accountIds: ['account-1'],
			},
			async (request) => {
				if (request.url.includes('/sdl/v2/api/queries'))
					return {
						id: 'job',
						stepsCompleted: 1,
						stepsTotal: 1,
						data: {
							matches: [
								{
									timestamp: String(BigInt(now - 1000) * 1000000n),
									values: {
										activity_id: 'event',
										activity_type: '16007',
										created_at: new Date(now - 1000).toISOString(),
										'data.alert.id': 'example-alert',
										'data.payload.note_text': 'private note',
									},
								},
							],
						},
					};
				if (request.method === 'GET')
					return { data: [{ id: 'account-1', name: 'Account' }], pagination: { nextCursor: null } };
				throw {
					statusCode,
					message: 'private response with token secret-token',
					response: { status: statusCode, data: { message: 'private response secret-body' } },
				};
			},
		);
		await assert.rejects(node.poll.call(context), (error) => {
			assert.ok(
				error instanceof NodeApiError,
				`${error.constructor.name}: ${error.message}; cause=${error.cause?.constructor?.name} api=${error.cause instanceof NodeApiError} http=${error.cause?.httpCode}`,
			);
			assert.equal(error.httpCode, String(statusCode));
			assert.equal(error.statusCode, statusCode);
			assert.doesNotMatch(error.message, /secret-token|secret-body/);
			messages.set(statusCode, error.message);
			return true;
		});
	}
	assert.notEqual(messages.get(401), messages.get(403));
	assert.match(messages.get(401), /authentication/);
	assert.match(messages.get(403), /denied access/);
});

test('scope discovery drains REST cursors and parses each envelope', async () => {
	const accountCalls = [];
	const accountOptions = await loadScopeOptions(
		async (options) => {
			accountCalls.push(options);
			if (!options.qs.cursor) {
				return { data: [{ id: '2', name: 'Zulu' }], pagination: { nextCursor: 'account-next' } };
			}
			return { data: [{ id: '1', name: 'Alpha' }], pagination: { nextCursor: null } };
		},
		'https://tenant.example',
		'ACCOUNT',
	);
	assert.deepEqual(accountOptions, [
		{ name: 'Alpha', value: '1' },
		{ name: 'Zulu', value: '2' },
	]);
	assert.equal(accountCalls[0].qs.limit, 1000);
	assert.equal(accountCalls[0].qs.states, 'active');
	// Per-attempt timeout is a share of the 30-second deadline, floored so a slow read is not cut short.
	assert.equal(accountCalls[0].timeout, 15_000);
	assert.equal(accountCalls[1].qs.cursor, 'account-next');

	let siteRequest;
	const siteOptions = await loadScopeOptions(
		async (options) => {
			siteRequest = options;
			return {
				data: {
					sites: [{ id: 90071992547409931234n.toString(), name: 'Paris', accountName: 'Acme' }],
				},
				pagination: { nextCursor: null },
			};
		},
		'https://tenant.example',
		'SITE',
		{ accountIds: ['account-1', 'account-2'] },
	);
	assert.deepEqual(siteOptions, [{ name: 'Acme / Paris', value: '90071992547409931234' }]);
	assert.equal(siteRequest.qs.accountIds, 'account-1,account-2');

	let groupRequest;
	const groupOptions = await loadScopeOptions(
		async (options) => {
			groupRequest = options;
			return {
				data: [{ id: 'group-1', name: 'Servers', siteId: 'site-1' }],
				pagination: { nextCursor: null },
			};
		},
		'https://tenant.example',
		'GROUP',
		{ accountIds: ['account-1'], siteIds: ['site-1'] },
	);
	assert.deepEqual(groupOptions, [{ name: 'Servers', value: 'group-1' }]);
	assert.equal(groupRequest.qs.accountIds, 'account-1');
	assert.equal(groupRequest.qs.siteIds, 'site-1');
});

test('large visible-account selections are chunked into bounded GraphQL requests', async () => {
	const scopeIds = Array.from(
		{ length: MAX_SCOPE_IDS_PER_QUERY + 1 },
		(_, index) => `account-${index}`,
	);
	const triggerConfig = config({ scopeIds });
	const observedChunkSizes = [];
	await pollSentinelOne(
		async (options) => {
			observedChunkSizes.push(queryVariables(options).scope.scopeIds.length);
			return alertResponse([]);
		},
		triggerConfig,
		initializedState(triggerConfig),
		'scheduled',
		NOW,
	);

	assert.deepEqual(
		observedChunkSizes.sort((left, right) => right - left),
		[500, 1],
	);
});

test('empty scope selection discovers all accounts and the deepest selected scope wins', async () => {
	assert.equal(typeof SentinelOnePlatformTrigger, 'function');
	const node = new SentinelOnePlatformTrigger();
	const baseParams = {
		resource: 'alert',
		operation: 'new',
		accountIds: [],
		siteIds: [],
		groupIds: [],
		options: {
			simplifyOutput: false,
		},
	};
	let discoveredQuery;
	let discoveredVariables;
	const discoveryContext = createNodeContext(baseParams, async (options) => {
		if (options.method === 'GET') {
			return {
				data: [
					{ id: 'account-1', name: 'Account One' },
					{ id: 'account-2', name: 'Account Two' },
				],
				pagination: { nextCursor: null },
			};
		}
		discoveredQuery = options.body.query;
		discoveredVariables = queryVariables(options);
		discoveredQuery = options.body.query;
		return alertResponse([alert('preview-alert')]);
	});
	const discoveryResult = await node.poll.call(discoveryContext);

	assert.deepEqual(discoveredVariables.scope, {
		scopeType: 'ACCOUNT',
		scopeIds: ['account-1', 'account-2'],
	});
	for (const field of [
		'ticketId',
		'result',
		'storylineId',
		'dataSources',
		'detectionSource',
		'availableActionIds',
	]) {
		assert.match(discoveredQuery, new RegExp(`\\b${field}\\b`));
	}
	assert.equal(discoveryResult[0][0].json.eventType, 'alert.new');

	let hierarchyVariables;
	const hierarchyContext = createNodeContext(
		{
			...baseParams,
			accountIds: ['account-1'],
			siteIds: ['site-1'],
			groupIds: ['group-1'],
		},
		async (options) => {
			if (options.method === 'GET') {
				if (options.url.endsWith('/accounts')) {
					return {
						data: [{ id: 'account-1', name: 'Account One' }],
						pagination: { nextCursor: null },
					};
				}
				if (options.url.endsWith('/sites')) {
					return {
						data: { sites: [{ id: 'site-1', name: 'Site One' }] },
						pagination: { nextCursor: null },
					};
				}
				return {
					data: [{ id: 'group-1', name: 'Group One', siteId: 'site-1' }],
					pagination: { nextCursor: null },
				};
			}
			hierarchyVariables = queryVariables(options);
			return alertResponse([alert('group-preview')]);
		},
	);
	await node.poll.call(hierarchyContext);
	assert.deepEqual(hierarchyVariables.scope, {
		scopeType: 'GROUP',
		scopeIds: ['group-1'],
	});
});

test('poll rejects stale descendant scopes that do not belong to the selected parent', async () => {
	const node = new SentinelOnePlatformTrigger();
	let graphQlRequests = 0;
	const context = createNodeContext(
		{
			resource: 'alert',
			operation: 'new',
			accountIds: ['account-b'],
			siteIds: ['site-from-account-a'],
			groupIds: ['group-from-account-a'],
		},
		async (options) => {
			if (options.method !== 'GET') {
				graphQlRequests += 1;
				return alertResponse([]);
			}
			if (options.url.endsWith('/accounts')) {
				return {
					data: [{ id: 'account-b', name: 'Account B' }],
					pagination: { nextCursor: null },
				};
			}
			if (options.url.endsWith('/sites')) {
				return { data: { sites: [] }, pagination: { nextCursor: null } };
			}
			return { data: [], pagination: { nextCursor: null } };
		},
	);

	await assert.rejects(node.poll.call(context), /no longer belongs to the selected parent scope/);
	assert.equal(graphQlRequests, 0);
});

test('overlapping polls are coalesced before they can read or overwrite the same state', async () => {
	const node = new SentinelOnePlatformTrigger();
	let releaseGraphQl;
	let markGraphQlStarted;
	const graphQlStarted = new Promise((resolve) => {
		markGraphQlStarted = resolve;
	});
	const graphQlGate = new Promise((resolve) => {
		releaseGraphQl = resolve;
	});
	let graphQlRequests = 0;
	const context = createNodeContext(
		{
			resource: 'alert',
			operation: 'new',
			accountIds: [],
			siteIds: [],
			groupIds: [],
		},
		async (options) => {
			if (options.method === 'GET') {
				return {
					data: [{ id: 'account-1', name: 'Account One' }],
					pagination: { nextCursor: null },
				};
			}
			graphQlRequests += 1;
			markGraphQlStarted();
			await graphQlGate;
			return alertResponse([]);
		},
		'trigger',
	);

	const firstPoll = node.poll.call(context);
	await graphQlStarted;
	const overlappingResult = await node.poll.call(context);
	assert.equal(overlappingResult, null);
	assert.equal(graphQlRequests, 1);
	releaseGraphQl();
	await firstPoll;
});

test('first scheduled poll creates a bounded baseline without output', async () => {
	const triggerConfig = config({
		severities: ['CRITICAL', 'HIGH'],
		statuses: ['NEW'],
		alertName: 'Example detection',
	});
	let observedVariables;
	const result = await pollSentinelOne(
		async (options) => {
			observedVariables = queryVariables(options);
			return alertResponse([alert('baseline-alert')]);
		},
		triggerConfig,
		{},
		'scheduled',
		NOW,
	);

	assert.deepEqual(result.items, []);
	assert.equal(result.nextState.initialized, true);
	assert.deepEqual(
		result.nextState.seenAlertIds.map((entry) => entry.split('\u0000')[0]),
		['baseline-alert'],
	);
	assert.equal(observedVariables.filters[0].dateTimeRange.start, NOW - 300_000);
	assert.deepEqual(observedVariables.filters.slice(1), [
		{ fieldId: 'severity', stringIn: { values: ['CRITICAL', 'HIGH'] } },
		{ fieldId: 'status', stringIn: { values: ['NEW'] } },
		{ fieldId: 'alertName', match: { values: ['Example detection'] } },
	]);
});

test('GraphQL requests use the configured finite timeout', async () => {
	const triggerConfig = config({ requestTimeoutMs: 12_345 });
	let observedTimeout;
	await pollSentinelOne(
		async (options) => {
			observedTimeout = options.timeout;
			return alertResponse([]);
		},
		triggerConfig,
		initializedState(triggerConfig),
		'scheduled',
		NOW,
	);
	assert.equal(observedTimeout, 12_345);
});

test('manual poll previews a previously seen alert without mutating durable state', async () => {
	const triggerConfig = config();
	const previous = initializedState(triggerConfig, {
		seenAlertIds: [alertIdentity(alert('preview-alert'))],
	});
	const snapshot = structuredClone(previous);
	const result = await pollSentinelOne(
		async () => alertResponse([alert('preview-alert')]),
		triggerConfig,
		previous,
		'manual',
		NOW,
	);

	assert.equal(result.items.length, 1);
	assert.equal(result.items[0].eventType, 'alert.new');
	assert.equal(result.nextState, undefined);
	assert.deepEqual(previous, snapshot);
});

test('manual alert preview ignores durable version dedupe state', async () => {
	const updatedConfig = config({ events: ['alert.updated'] });
	const updatedAlert = alert(
		'updated-preview',
		'2026-08-26T10:00:00.000Z',
		'2026-08-26T11:59:00.000Z',
	);
	const updatedVersion = `${updatedAlert.id}\u0000${updatedAlert.updatedAt}`;
	const updatedResult = await pollSentinelOne(
		async () => alertResponse([updatedAlert]),
		updatedConfig,
		initializedState(updatedConfig, {
			seenAlertIds: [alertIdentity(updatedAlert)],
			seenAlertVersions: [updatedVersion],
		}),
		'manual',
		NOW,
	);
	assert.deepEqual(
		updatedResult.items.map((item) => item.eventType),
		['alert.updated'],
	);
	assert.equal(updatedResult.nextState, undefined);
});

test('manual poll uses the widest alert range and returns at most ten results', async () => {
	const triggerConfig = config();
	let observedVariables;
	const alerts = Array.from({ length: 15 }, (_, index) =>
		alert(`manual-${index}`, new Date(NOW - index * 60_000).toISOString()),
	);
	const result = await pollSentinelOne(
		async (options) => {
			observedVariables = queryVariables(options);
			return alertResponse(alerts);
		},
		triggerConfig,
		{},
		'manual',
		NOW,
	);

	assert.equal(observedVariables.first, 10);
	assert.equal(observedVariables.filters[0].dateTimeRange.start, 0);
	assert.equal(result.items.length, 10);
	assert.equal(result.nextState, undefined);
});

test('updated-only mode skips a new alert and emits its later version', async () => {
	const triggerConfig = config({ events: ['alert.updated'] });
	let state = initializedState(triggerConfig);
	let current = alert('updated-only');
	const request = async () => alertResponse([current]);

	const first = await pollSentinelOne(request, triggerConfig, state, 'scheduled', NOW);
	assert.deepEqual(first.items, []);
	assert.deepEqual(
		first.nextState.seenAlertIds.map((entry) => entry.split('\u0000')[0]),
		[],
		'Updated-only polling does not need or save createdAt identities',
	);
	state = first.nextState;

	current = alert('updated-only', '2026-08-26T11:59:00.000Z', '2026-08-26T12:01:00.000Z');
	const second = await pollSentinelOne(request, triggerConfig, state, 'scheduled', NOW + 120_000);
	assert.deepEqual(
		second.items.map((item) => item.eventType),
		['alert.updated'],
	);
});

test('updated-only mode emits an alert revised after creation on the first poll', async () => {
	const triggerConfig = config({ events: ['alert.updated'] });
	const revised = alert('revised-alert', '2026-08-26T11:59:00.000Z', '2026-08-26T11:59:05.000Z');
	const request = async () => alertResponse([revised]);

	const first = await pollSentinelOne(
		request,
		triggerConfig,
		initializedState(triggerConfig),
		'scheduled',
		NOW,
	);
	assert.deepEqual(
		first.items.map((item) => item.eventType),
		['alert.updated'],
	);
});

test('new and updated mode emits a revised new alert once as new', async () => {
	const triggerConfig = config({ events: ['alert.new', 'alert.updated'] });
	const revised = alert('revised-alert', '2026-08-26T11:59:00.000Z', '2026-08-26T11:59:05.000Z');
	const request = async () => alertResponse([revised]);

	const first = await pollSentinelOne(
		request,
		triggerConfig,
		initializedState(triggerConfig),
		'scheduled',
		NOW,
	);
	assert.deepEqual(
		first.items.map((item) => item.eventType),
		['alert.new'],
	);
});

test('new alerts and later updated versions each emit once without same-poll double emission', async () => {
	const triggerConfig = config({ events: ['alert.new', 'alert.updated'] });
	let state = initializedState(triggerConfig);
	let current = alert('alert-1');
	const request = async () => alertResponse([current]);

	const first = await pollSentinelOne(request, triggerConfig, state, 'scheduled', NOW);
	assert.deepEqual(
		first.items.map((item) => item.eventType),
		['alert.new'],
	);
	state = first.nextState;

	current = alert('alert-1', current.createdAt, '2026-08-26T12:01:00.000Z');
	const second = await pollSentinelOne(request, triggerConfig, state, 'scheduled', NOW + 120_000);
	assert.deepEqual(
		second.items.map((item) => item.eventType),
		['alert.updated'],
	);
	state = second.nextState;

	const third = await pollSentinelOne(request, triggerConfig, state, 'scheduled', NOW + 180_000);
	assert.deepEqual(third.items, []);
});

test('concurrent new and updated snapshots emit the newest payload once', async () => {
	const triggerConfig = config({ events: ['alert.new', 'alert.updated'] });
	const createdSnapshot = alert(
		'racing-alert',
		'2026-08-26T11:59:00.000Z',
		'2026-08-26T11:59:00.000Z',
	);
	const updatedSnapshot = alert(
		'racing-alert',
		'2026-08-26T11:59:00.000Z',
		'2026-08-26T11:59:30.000Z',
	);
	const request = async (options) =>
		queryVariables(options).sortBy === 'createdAt'
			? alertResponse([createdSnapshot])
			: alertResponse([updatedSnapshot]);
	let state = initializedState(triggerConfig);
	const first = await pollSentinelOne(request, triggerConfig, state, 'scheduled', NOW);

	assert.deepEqual(
		first.items.map((item) => item.eventType),
		['alert.new'],
	);
	assert.equal(first.items[0].alert.updatedAt, '2026-08-26T11:59:30.000Z');
	state = first.nextState;
	const second = await pollSentinelOne(request, triggerConfig, state, 'scheduled', NOW + 60_000);
	assert.deepEqual(second.items, []);
});

test('simplified alert output resolves the actual scope hierarchy without configured scope lists', async () => {
	const triggerConfig = config({
		scopeType: 'GROUP',
		scopeIds: ['group-1', 'group-2'],
		simplifyOutput: true,
	});
	const result = await pollSentinelOne(
		async () => alertResponse([alert('simplified-alert')]),
		triggerConfig,
		initializedState(triggerConfig),
		'scheduled',
		NOW,
	);
	const item = result.items[0];

	assert.equal('scope' in item, false);
	assert.equal(item.accountName, 'Account One');
	assert.equal(item.siteName, 'Site One');
	assert.equal(item.groupName, 'Group One');
	assert.equal(item.alertId, 'simplified-alert');
	assert.equal('scopeIds' in item, false);
	assert.equal(typeof item.accountId, 'string');
	assert.equal('scopeId' in item, false);
	assert.equal('alert' in item, false);
});

test('overlap query emits a late unseen alert older than the checkpoint', async () => {
	const triggerConfig = config({ overlapSeconds: 300 });
	const checkpoint = NOW - 60_000;
	const previous = initializedState(triggerConfig, { checkpointMs: checkpoint });
	let rangeStart;
	const lateAlert = alert('late-alert', new Date(checkpoint - 120_000).toISOString());
	const result = await pollSentinelOne(
		async (options) => {
			rangeStart = queryVariables(options).filters[0].dateTimeRange.start;
			return alertResponse([lateAlert]);
		},
		triggerConfig,
		previous,
		'scheduled',
		NOW,
	);

	assert.equal(rangeStart, checkpoint - 300_000);
	assert.equal(result.items[0].alert.id, 'late-alert');
});

test('configuration change fully rebaselines without historical output', async () => {
	const oldConfig = config();
	const newConfig = config({ statuses: ['RESOLVED'] });
	const previous = initializedState(oldConfig, {
		seenAlertIds: [alertIdentity(alert('old-alert'))],
	});
	const result = await pollSentinelOne(
		async () => alertResponse([alert('resolved-alert')]),
		newConfig,
		previous,
		'scheduled',
		NOW,
	);

	assert.deepEqual(result.items, []);
	assert.deepEqual(
		result.nextState.seenAlertIds.map((entry) => entry.split('\u0000')[0]),
		['resolved-alert'],
	);
	assert.equal(result.nextState.configFingerprint, fingerprintConfig(newConfig));
});

test('advanced filter arrays append with AND and grouped OR applies guided filters to each branch', () => {
	const base = [{ fieldId: 'createdAt', dateTimeRange: { start: NOW - 60_000 } }];
	assert.deepEqual(
		advancedFilterSelection(
			base,
			JSON.stringify([
				{ fieldId: 'detectionProduct', stringEqual: { value: 'STAR' } },
				{
					fieldId: 'ticketId',
					match: { operator: 'contains', values: ['"externalTicketId":"'] },
				},
			]),
		),
		{
			filters: [
				...base,
				{ fieldId: 'detectionProduct', stringEqual: { value: 'STAR' } },
				{
					fieldId: 'ticketId',
					match: { operator: 'contains', values: ['"externalTicketId":"'] },
				},
			],
			orFilter: null,
		},
	);

	const grouped = advancedFilterSelection(base, {
		or: [
			{ and: [{ fieldId: 'detectionProduct', stringEqual: { value: 'STAR' } }] },
			{ and: [{ fieldId: 'severity', stringIn: { values: ['HIGH', 'CRITICAL'] } }] },
		],
	});
	assert.equal(grouped.filters, null);
	assert.deepEqual(grouped.orFilter, {
		or: [
			{
				and: [...base, { fieldId: 'detectionProduct', stringEqual: { value: 'STAR' } }],
			},
			{
				and: [...base, { fieldId: 'severity', stringIn: { values: ['HIGH', 'CRITICAL'] } }],
			},
		],
	});
});

test('advanced grouped filters use orFilter and malformed input fails before a request', async () => {
	const advancedFilters = {
		or: [
			{ and: [{ fieldId: 'detectionProduct', stringEqual: { value: 'STAR' } }] },
			{ and: [{ fieldId: 'ticketId', isNegated: true, match: { values: ['internal'] } }] },
		],
	};
	await pollSentinelOne(
		async (request) => {
			assert.equal(request.body.variables.filters, null);
			assert.equal(request.body.variables.orFilter.or.length, 2);
			assert.match(request.body.query, /\$orFilter: OrFilterSelectionInput/);
			return alertResponse([]);
		},
		config({ advancedFilters }),
		{},
		'manual',
		NOW,
	);
	for (const value of [
		[{ fieldId: '', stringEqual: { value: 'STAR' } }],
		[{ fieldId: 'status', stringEqual: { value: 'NEW' }, stringIn: { values: ['NEW'] } }],
		{ or: [{ filters: [] }] },
	]) {
		await assert.rejects(
			() =>
				pollSentinelOne(
					async () => assert.fail('must not request'),
					config({ advancedFilters: value }),
					{},
					'manual',
					NOW,
				),
			/advanced filter/i,
		);
	}
});

test('semantic changes rebaseline but operational tuning and display names do not', () => {
	const original = config();
	assert.notEqual(
		fingerprintConfig(original),
		fingerprintConfig(config({ baseUrl: 'https://other-tenant.example' })),
	);
	assert.notEqual(
		fingerprintConfig(original),
		fingerprintConfig(
			config({
				advancedFilters: [{ fieldId: 'detectionProduct', stringEqual: { value: 'STAR' } }],
			}),
		),
	);
	assert.equal(
		fingerprintConfig(original),
		fingerprintConfig(
			config({
				credentialIdentity: {
					...original.credentialIdentity,
					name: 'Renamed Credential',
				},
				overlapSeconds: 3600,
				concurrentRequests: 20,
				requestTimeoutMs: 300_000,
				alertPageSize: 1000,
				maxAlertPages: 100,
			}),
		),
	);
	assert.equal(
		fingerprintConfig(config({ allVisibleAccounts: true, scopeIds: ['account-a'] })),
		fingerprintConfig(config({ allVisibleAccounts: true, scopeIds: ['account-a', 'account-b'] })),
	);
});

test('newly visible accounts do not rebaseline an all-visible-accounts poll', async () => {
	const previousConfig = config({
		allVisibleAccounts: true,
		scopeIds: ['account-a'],
	});
	const currentConfig = config({
		allVisibleAccounts: true,
		scopeIds: ['account-a', 'account-b'],
	});
	const result = await pollSentinelOne(
		async () => alertResponse([alert('newly-visible-alert')]),
		currentConfig,
		initializedState(previousConfig),
		'scheduled',
		NOW,
	);

	assert.deepEqual(
		result.items.map((item) => item.alert.id),
		['newly-visible-alert'],
	);
});

test('alert Relay connection drains every page', async () => {
	const triggerConfig = config();
	const previous = initializedState(triggerConfig);
	const calls = [];
	const result = await pollSentinelOne(
		async (options) => {
			calls.push(queryVariables(options).after);
			if (queryVariables(options).after === null) {
				return alertResponse([alert('alert-1')], { hasNextPage: true, endCursor: 'next-page' });
			}
			return alertResponse([alert('alert-2')]);
		},
		triggerConfig,
		previous,
		'scheduled',
		NOW,
	);

	assert.deepEqual(calls, [null, 'next-page']);
	assert.deepEqual(
		result.items.map((item) => item.alert.id),
		['alert-1', 'alert-2'],
	);
});

test('pagination failure does not mutate or replace prior state', async () => {
	const triggerConfig = config();
	const previous = initializedState(triggerConfig, {
		seenAlertIds: [alertIdentity(alert('safe'))],
	});
	const snapshot = structuredClone(previous);
	await assert.rejects(
		pollSentinelOne(
			async () => alertResponse([alert('unsafe')], { hasNextPage: true, endCursor: null }),
			triggerConfig,
			previous,
			'scheduled',
			NOW,
		),
		/without a continuation cursor/,
	);
	assert.deepEqual(previous, snapshot);
});

test('GraphQL errors fail the poll', async () => {
	const triggerConfig = config();
	await assert.rejects(
		pollSentinelOne(
			async () => ({ data: null, errors: [{ message: 'Unknown field' }] }),
			triggerConfig,
			initializedState(triggerConfig),
			'scheduled',
			NOW,
		),
		/SentinelOne rejected.*tenant schema/,
	);
});

test('GraphQL service errors cannot echo confidential response details', async () => {
	await assert.rejects(
		pollSentinelOne(
			async () => ({ errors: [{ message: 'secret-token ticketPayload private-name' }] }),
			config(),
			{},
			'manual',
			NOW,
		),
		(error) =>
			/rejected/.test(error.message) &&
			!/secret-token|ticketPayload|private-name/.test(error.message),
	);
});

test('malformed alert connections fail without a successful checkpoint', async () => {
	const triggerConfig = config();
	const previous = initializedState(triggerConfig);
	const snapshot = structuredClone(previous);
	for (const edges of [undefined, null, {}]) {
		await assert.rejects(
			pollSentinelOne(
				async () => ({ data: { alerts: { edges, pageInfo: { hasNextPage: false } } } }),
				triggerConfig,
				previous,
				'scheduled',
				NOW,
			),
			/incomplete/,
		);
		assert.deepEqual(previous, snapshot);
	}
});

test('diagnostic callback failure cannot change alert output or state advancement', async () => {
	const triggerConfig = config({
		debug: true,
		debugLog: () => {
			throw new Error('Logger unavailable');
		},
	});
	const result = await pollSentinelOne(
		async () => alertResponse([]),
		triggerConfig,
		{},
		'scheduled',
		NOW,
	);
	assert.ok(
		Object.values(result.nextState.alertCursors).every((cursor) => cursor.throughMs === NOW),
	);
	assert.equal('checkpointMs' in result.nextState, false);
});

test('alert polling rejects obsolete timeline note routing before making requests', async () => {
	await assert.rejects(
		pollSentinelOne(
			async () => assert.fail('No request expected'),
			config({ events: ['alert.note.created'] }),
			{},
			'manual',
			NOW,
		),
		/ActivityFeed polling/,
	);
});

test('missing alert identities or timestamps fail visibly', async () => {
	const alertConfig = config();
	await assert.rejects(
		pollSentinelOne(
			async () => alertResponse([{ id: 'bad-alert', createdAt: null }]),
			alertConfig,
			initializedState(alertConfig),
			'scheduled',
			NOW,
		),
		/without a usable createdAt timestamp/,
	);
});

test('debug logging captures sanitized request stages without credentials or response bodies', async () => {
	const entries = [];
	const triggerConfig = config({
		debug: true,
		debugLog: (message, details) => entries.push({ message, details }),
	});
	await pollSentinelOne(
		async () => alertResponse([alert('debug-alert')]),
		triggerConfig,
		initializedState(triggerConfig),
		'scheduled',
		NOW,
	);

	assert.deepEqual(
		entries.map((entry) => entry.message),
		[
			'Starting SentinelOne poll',
			'Read Unified Alerts range',
			'Completed alert candidate queries',
			'Completed scheduled SentinelOne poll',
		],
	);
	const serialized = JSON.stringify(entries);
	assert.doesNotMatch(serialized, /Authorization|ApiToken|apiToken|Content debug-alert/);
});

test('expired seen identities retire while current identities remain within documented limits', async () => {
	const triggerConfig = config({ events: ['alert.new', 'alert.updated'] });
	const previous = initializedState(triggerConfig, {
		seenAlertIds: Array.from({ length: MAX_SEEN_ALERT_IDS + 5 }, (_, index) =>
			alertIdentity(
				alert(`alert-${index}`, new Date(NOW - (index < 5 ? 600_000 : 60_000)).toISOString()),
			),
		),
		seenAlertVersions: Array.from(
			{ length: MAX_SEEN_ALERT_VERSIONS + 5 },
			(_, index) =>
				`version-${index}\u0000${new Date(NOW - (index < 5 ? 600_000 : 60_000)).toISOString()}`,
		),
	});
	const result = await pollSentinelOne(
		async () => alertResponse([]),
		triggerConfig,
		previous,
		'scheduled',
		NOW,
	);

	assert.equal(result.nextState.seenAlertIds.length, MAX_SEEN_ALERT_IDS);
	assert.equal(result.nextState.seenAlertVersions.length, MAX_SEEN_ALERT_VERSIONS);
});

test('ActivityFeed access requirements belong in credential docs, not a trigger banner', () => {
	const properties = new SentinelOnePlatformTrigger().description.properties;
	assert.equal(
		properties.some((property) => property.name === 'noteActivityFeedNotice'),
		false,
	);
	const documentation = readFileSync(join(packageRoot, 'docs/credentials.md'), 'utf8');
	assert.match(documentation, /Alert Activity > Occurred trigger requires SDL query access/);
});

test('trigger scope controls come first and site and group loaders depend on their parents', () => {
	const properties = new SentinelOnePlatformTrigger().description.properties;
	const scopeFields = Object.fromEntries(
		['accountIds', 'siteIds', 'groupIds'].map((name) => [
			name,
			properties.find((property) => property.name === name),
		]),
	);
	assert.ok(scopeFields.accountIds);
	assert.ok(scopeFields.siteIds);
	assert.ok(scopeFields.groupIds);
	assert.deepEqual(
		properties.slice(0, 3).map((property) => property.name),
		['accountIds', 'siteIds', 'groupIds'],
	);
	assert.deepEqual(scopeFields.siteIds.typeOptions.loadOptionsDependsOn, ['accountIds']);
	assert.deepEqual(scopeFields.groupIds.typeOptions.loadOptionsDependsOn, [
		'accountIds',
		'siteIds',
	]);
	for (const resource of ['alert', 'alertActivity']) {
		assert.deepEqual(scopeFields.accountIds.displayOptions.show, {
			resource: ['alert', 'alertActivity'],
		});
		assert.deepEqual(scopeFields.siteIds.displayOptions.show, {
			resource: ['alert', 'alertActivity'],
			accountIds: [{ _cnd: { exists: true } }],
		});
		assert.deepEqual(scopeFields.groupIds.displayOptions.show, {
			resource: ['alert', 'alertActivity'],
			siteIds: [{ _cnd: { exists: true } }],
		});
	}
});

test('trigger UI uses resource, operation, and resource-specific options', () => {
	const node = new SentinelOnePlatformTrigger();
	const properties = node.description.properties;
	const source = readFileSync(
		join(packageRoot, 'nodes/SentinelOnePlatformTrigger/SentinelOnePlatformTrigger.node.ts'),
		'utf8',
	);

	assert.match(source, /displayName: 'Resource'[\s\S]*?name: 'resource'/);
	assert.match(source, /resource: \['alert'\][\s\S]*?value: 'newOrUpdated'/);
	const activityOperation = node.description.properties.find((p) => p.name === 'activityTypes');
	assert.equal(activityOperation.type, 'multiOptions');
	assert.deepEqual(activityOperation.default, ['any']);
	assert.equal(activityOperation.displayName, 'Operation');
	assert.equal(
		node.description.properties.some(
			(p) => p.name === 'operation' && p.displayOptions.show.resource.includes('alertActivity'),
		),
		false,
	);
	assert.equal(
		node.description.properties.indexOf(activityOperation),
		node.description.properties.findIndex((p) => p.name === 'operation') + 1,
	);
	assert.match(source, /displayName: 'Options'[\s\S]*?resource: \['alert'\]/);
	assert.match(source, /displayName: 'Options'[\s\S]*?resource: \['alertActivity'\]/);
	assert.doesNotMatch(source, /previewLookbackMinutes/);
	const debug = node.description.properties.find((property) => property.name === 'nodeDebug');
	assert.equal(debug.displayName, 'Debug');
	assert.equal(debug.isNodeSetting, true);
	assert.equal(debug.default, false);
	assert.match(source, /displayName: 'Simplify'[\s\S]*?default: true/);
	const alertOptions = node.description.properties.find(
		(property) =>
			property.name === 'options' && property.displayOptions?.show?.resource?.includes('alert'),
	);
	const additionalFields = alertOptions.options.find(
		(property) => property.name === 'additionalAlertFields',
	);
	assert.deepEqual(additionalFields.default, []);
	const noteOptions = node.description.properties.find(
		(property) =>
			property.name === 'options' &&
			property.displayOptions?.show?.resource?.includes('alertActivity'),
	);
	assert.equal(
		alertOptions.options.find((property) => property.name === 'severities').displayName,
		'Alert Severity',
	);
	assert.equal(
		alertOptions.options.find((property) => property.name === 'statuses').displayName,
		'Alert Status',
	);
	assert.equal(
		noteOptions.options.find((property) => property.name === 'severities').displayName,
		'Alert Severity',
	);
	assert.equal(
		noteOptions.options.find((property) => property.name === 'statuses').displayName,
		'Alert Status',
	);
	const activityConditionFields = properties.find(
		(property) => property.name === 'activityConditions',
	).options[0].values;
	const conditionField = activityConditionFields.find((property) => property.name === 'field');
	assert.ok(
		conditionField.options.some(
			(option) => option.name === 'Assignee' && option.value === 'assignment',
		),
	);
	for (const [name, label] of [
		['fromStatus', 'Previous Value'],
		['toStatus', 'New Value'],
		['previousEmail', 'Previous Assignee Email'],
		['newEmail', 'New Assignee Email'],
		['destinationIds', 'New Assignee ID'],
		['actionTypes', 'Mitigation Action'],
		['activityStatuses', 'Mitigation Status'],
	])
		assert.equal(
			activityConditionFields.find((property) => property.name === name).displayName,
			label,
		);
	assert.deepEqual(
		activityConditionFields
			.find((property) => property.name === 'actionTypes')
			.options.map((option) => option.name),
		[
			'Add to Blocklist',
			'Add Exclusion',
			'Identity',
			'Kill Process',
			'Partner',
			'Quarantine',
			'Remediate',
			'Remove Macros',
			'Restore Macros',
			'Rollback',
			'Remove from Quarantine',
			'Workflow',
		],
	);
	assert.deepEqual(
		activityConditionFields
			.find((property) => property.name === 'activityStatuses')
			.options.map((option) => option.name),
		[
			'Added',
			'Cancelled',
			'Failed',
			'Partial',
			'Pending',
			'Pending Reboot',
			'Running',
			'Sent',
			'Success',
		],
	);
	const advancedFilters = alertOptions.options.find(
		(property) => property.name === 'advancedFilters',
	);
	assert.equal(advancedFilters.type, 'json');
	assert.equal(advancedFilters.default, '[]');
	assert.match(advancedFilters.description, /docs\/trigger\.md#advanced-filters/);
	const metadata = JSON.parse(
		readFileSync(
			join(packageRoot, 'nodes/SentinelOnePlatformTrigger/SentinelOnePlatformTrigger.node.json'),
			'utf8',
		),
	);
	assert.equal(
		metadata.resources.primaryDocumentation[0].url,
		'https://github.com/pemontto/n8n-nodes-sentinelone-platform/blob/main/docs/trigger.md',
	);
	assert.doesNotMatch(
		source,
		/displayName: '(?:Alert Page Size|Concurrent Requests|Max Alert Pages|Max Timeline Pages|Overlap|Request Timeout \(Ms\)|Timeline Page Size)'/,
	);
});

const {
	compileExclusion,
	matchesExclusion,
} = require('../../dist/nodes/SentinelOnePlatformTrigger/Exclusions.js');
const testNode = {
	name: 'SentinelOne Platform Trigger',
	type: 'sentinelOnePlatformTrigger',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

test('exclusion regex supports names, anchors, alternatives and bounded native matching', () => {
	for (const pattern of ['demo|test', '^(demo|test)', '^demo.*$', 'test-[0-9]+']) {
		assert.ok(compileExclusion(pattern, 'Account'));
	}
	assert.equal(matchesExclusion(compileExclusion('demo|test', 'Account'), 'DEMO customer'), true);
	assert.equal(matchesExclusion(compileExclusion('^demo$', 'Account'), 'demo customer'), false);
	assert.equal(matchesExclusion(compileExclusion('.*', 'Account'), undefined), false);
	assert.equal(matchesExclusion(compileExclusion('.*', 'Account'), ''), false);
	assert.equal(compileExclusion('', 'Account'), undefined);
	for (const pattern of [
		'[',
		'(a+)+$',
		'(a|aa)+$',
		'(a|aa)(a|aa)',
		'a*a*',
		'(?=test)',
		'(a)\\1',
		'a{999999}',
		'x'.repeat(257),
	]) {
		assert.throws(() => compileExclusion(pattern, 'Account'), /Account: use a valid regex/);
	}
	assert.throws(() => matchesExclusion(/a/i, 'a'.repeat(1025)), /safety limit/);
});

test('scope exclusions cascade without changing query scope or dropping ungrouped alerts', async () => {
	const excludedAccount = alert('account');
	excludedAccount.realTime.scope.account.name = 'Demo customer';
	const excludedSite = alert('site');
	excludedSite.realTime.scope.site.name = 'TEST site';
	const excludedGroup = alert('group');
	excludedGroup.realTime.scope.group.name = 'Test group';
	const ungrouped = alert('ungrouped');
	ungrouped.realTime.scope.group = null;
	const cfg = config({
		excludeAccountName: 'demo',
		excludeSiteName: 'test',
		excludeGroupName: 'test',
	});
	const result = await pollSentinelOne(
		async (request) => {
			assert.equal(request.body.variables.scope.scopeType, 'ACCOUNT');
			return alertResponse([excludedAccount, excludedSite, excludedGroup, ungrouped]);
		},
		cfg,
		initializedState(cfg),
		'scheduled',
		NOW,
	);
	assert.deepEqual(
		result.items.map((item) => item.alert.id),
		['ungrouped'],
	);
});

test('manual preview paginates past excluded alerts without changing state', async () => {
	const cfg = config({ excludeAccountName: 'demo' });
	const excluded = alert('excluded');
	excluded.realTime.scope.account.name = 'Demo';
	let calls = 0;
	const result = await pollSentinelOne(
		async (request) => {
			calls++;
			return request.body.variables.after
				? alertResponse([alert('included')])
				: alertResponse([excluded], { hasNextPage: true, endCursor: 'next' });
		},
		cfg,
		initializedState(cfg),
		'manual',
		NOW,
	);
	assert.equal(calls, 2);
	assert.deepEqual(
		result.items.map((item) => item.alert.id),
		['included'],
	);
	assert.equal(result.nextState, undefined);
});

test('exclusion changes baseline and invalid patterns fail before any requests', async () => {
	const original = config();
	const changed = config({ excludeAccountName: 'demo' });
	const result = await pollSentinelOne(
		async () => alertResponse([alert('existing')]),
		changed,
		initializedState(original),
		'scheduled',
		NOW,
	);
	assert.equal(result.items.length, 0);
	assert.notEqual(result.nextState.configFingerprint, fingerprintConfig(original));
	await assert.rejects(
		() =>
			pollSentinelOne(
				async () => assert.fail('must not request'),
				config({ excludeSiteName: '[' }),
				{},
				'scheduled',
				NOW,
			),
		/Exclude Site Name/,
	);
});

test('visible scope discovery falls back to sites only for permission denial or no accounts', async () => {
	for (const status of [403, '403']) {
		const requests = [];
		const scopes = await discoverVisibleScopes(
			async (request) => {
				requests.push(request.url);
				if (request.url.endsWith('/accounts')) throw { statusCode: status };
				return { data: { sites: [{ id: 'site-1', name: 'Site' }] } };
			},
			'https://tenant.example',
			testNode,
		);
		assert.deepEqual(scopes, { scopeType: 'SITE', scopeIds: ['site-1'] });
		assert.equal(requests.length, 2);
	}
	for (const statusCode of [401, 429, 500]) {
		let calls = 0;
		await assert.rejects(() =>
			discoverVisibleScopes(
				async () => {
					calls++;
					throw { statusCode };
				},
				'https://tenant.example',
				testNode,
			),
		);
		assert.equal(calls, statusCode === 401 ? 1 : 3);
	}
});

test('manual Updated preview continues past never-updated alerts', async () => {
	const cfg = config({ events: ['alert.updated'] });
	const neverUpdated = Array.from({ length: 10 }, (_, index) => alert(`new-${index}`));
	const genuineUpdate = alert('updated', '2026-08-20T00:00:00Z', '2026-08-26T11:58:00Z');
	const result = await pollSentinelOne(
		async (request) => {
			const vars = request.body.variables;
			if (vars.sortBy === 'createdAt') return alertResponse(neverUpdated);
			return vars.after
				? alertResponse([genuineUpdate])
				: alertResponse(neverUpdated, { hasNextPage: true, endCursor: 'next' });
		},
		cfg,
		{},
		'manual',
		NOW,
	);
	assert.deepEqual(
		result.items.map((item) => item.alert.id),
		['updated'],
	);
});

test('site-scoped node polls accessible sites without account-list permission', async () => {
	const node = new SentinelOnePlatformTrigger();
	const calls = [];
	const request = async (options) => {
		calls.push(options.url);
		if (options.url.endsWith('/accounts')) throw { statusCode: 403 };
		if (options.url.endsWith('/sites'))
			return { data: { sites: [{ id: 'site-1', name: 'Site' }] } };
		assert.deepEqual(options.body.variables.scope, { scopeType: 'SITE', scopeIds: ['site-1'] });
		return alertResponse([alert('accessible')]);
	};
	const context = createNodeContext(
		{
			resource: 'alert',
			operation: 'new',
			accountIds: [],
			siteIds: [],
		},
		request,
	);
	assert.deepEqual(await node.methods.loadOptions.getAccounts.call(context), []);
	assert.equal((await node.methods.loadOptions.getSites.call(context)).length, 1);
	assert.equal((await node.poll.call(context))[0][0].json.alertId, 'accessible');
	calls.length = 0;
	const selected = createNodeContext(
		{
			resource: 'alert',
			operation: 'new',
			accountIds: [],
			siteIds: ['site-1'],
		},
		request,
	);
	assert.equal((await node.poll.call(selected))[0][0].json.alertId, 'accessible');
	assert.equal(
		calls.some((url) => url.endsWith('/accounts')),
		false,
	);
});

test('combined manual preview continues after updates already classified as new', async () => {
	const cfg = config({ events: ['alert.new', 'alert.updated'] });
	const recent = Array.from({ length: 10 }, (_, index) =>
		alert(`new-${index}`, '2026-08-26T11:00:00Z', '2026-08-26T11:59:00Z'),
	);
	const older = alert('older-update', '2026-08-20T00:00:00Z', '2026-08-26T11:30:00Z');
	let nextPageRead = false;
	const result = await pollSentinelOne(
		async (request) => {
			const vars = request.body.variables;
			if (vars.sortBy === 'createdAt') return alertResponse(recent);
			if (vars.after) {
				nextPageRead = true;
				return alertResponse([older]);
			}
			return alertResponse(recent, { hasNextPage: true, endCursor: 'next' });
		},
		cfg,
		{},
		'manual',
		NOW,
	);
	assert.equal(nextPageRead, true);
	assert.equal(result.items.length, 10);
	assert.equal(result.items.at(-1).alert.id, 'older-update');
	assert.equal(result.items.at(-1).eventType, 'alert.updated');
});

test('selected additional alert fields are queried and returned in simplified and raw outputs', async () => {
	for (const simplifyOutput of [true, false]) {
		const cfg = config({
			simplifyOutput,
			additionalAlertFields: [
				'ticketId',
				'assignee',
				'description',
				'assets',
				'process',
				'aiInvestigation',
			],
		});
		const item = {
			...alert('enriched'),
			ticketId: 'CASE-42',
			assignee: { userId: 'u', fullName: 'Analyst', email: 'a@example.com' },
			description: null,
			assets: [{ id: 'asset-1', name: 'endpoint', tags: [{ key: 'team', value: 'security' }] }],
			process: { cmdLine: 'example', file: { sha256: 'hash', name: 'example' } },
			aiInvestigation: { status: 'COMPLETED' },
		};
		const result = await pollSentinelOne(
			async (request) => {
				assert.match(request.body.query, /ticketId/);
				assert.match(request.body.query, /assignee \{ userId fullName email \}/);
				assert.match(request.body.query, /storylineId/);
				return alertResponse([item]);
			},
			cfg,
			{},
			'manual',
			NOW,
		);
		if (simplifyOutput) {
			for (const key of [
				'ticketId',
				'assignee',
				'description',
				'assets',
				'process',
				'aiInvestigation',
			]) {
				assert.equal(key in result.items[0], false);
				assert.ok(`alert${key[0].toUpperCase()}${key.slice(1)}` in result.items[0]);
			}
		}
		const output = simplifyOutput
			? Object.fromEntries(
					Object.entries(result.items[0])
						.filter(([key]) => key.startsWith('alert'))
						.map(([key, value]) => [key[5].toLowerCase() + key.slice(6), value]),
				)
			: result.items[0].alert;
		assert.equal(output.ticketId, 'CASE-42');
		assert.equal(output.assignee.fullName, 'Analyst');
		assert.equal(output.description, null);
		assert.deepEqual(output.assets, item.assets);
		assert.deepEqual(output.process, item.process);
		assert.deepEqual(output.aiInvestigation, item.aiInvestigation);
	}
});

test('unknown field expressions cannot become GraphQL source and output selection keeps the baseline', async () => {
	for (const value of [['ticketId } mutation { delete'], ['__proto__'], 'ticketId']) {
		await assert.rejects(
			() =>
				pollSentinelOne(
					async () => assert.fail('must not request'),
					config({ additionalAlertFields: value }),
					{},
					'manual',
					NOW,
				),
			/unsupported alert field/,
		);
	}
	assert.equal(
		fingerprintConfig(config()),
		fingerprintConfig(config({ additionalAlertFields: ['ticketId'] })),
	);
});

test('credential uses the same Bearer token for SDL, GraphQL, and management REST', async () => {
	const {
		SentinelOnePlatformApi,
	} = require('../../dist/credentials/SentinelOnePlatformApi.credentials.js');
	const credential = new SentinelOnePlatformApi();
	assert.equal(credential.name, 'sentinelOnePlatformApi');
	assert.equal(credential.displayName, 'SentinelOne Platform API');
	assert.equal(
		credential.documentationUrl,
		'https://github.com/pemontto/n8n-nodes-sentinelone-platform/blob/main/docs/credentials.md',
	);
	assert.deepEqual(credential.test, {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/$/, "")}}',
			url: '/web/api/v2.1/sites?limit=1&states=active',
			method: 'GET',
		},
	});
	const data = { baseUrl: 'https://tenant.example', apiToken: 'test-token' };
	for (const path of ['/sdl/v2/api/queries', '/sdl/v2/api/queries/query-id']) {
		for (const key of ['url', 'uri']) {
			const options = await credential.authenticate(data, {
				[key]: `https://tenant.example${path}`,
				headers: { 'X-Test': 'kept' },
			});
			assert.equal(options.headers.Authorization, 'Bearer test-token');
			assert.equal(options.headers['X-Test'], 'kept');
		}
	}
	const options = await credential.authenticate(data, {
		url: 'https://tenant.example/web/api/v2.1/unifiedalerts/graphql',
	});
	assert.equal(options.headers.Authorization, 'Bearer test-token');
	const rest = await credential.authenticate(data, {
		url: 'https://tenant.example/web/api/v2.1/sites',
	});
	assert.equal(rest.headers.Authorization, 'Bearer test-token');
});

test('activity dispatch defaults to simplified output and ignores removed saved operations', async () => {
	for (const [simplifyOutput, operation] of [
		[false, 'occurred'],
		[true, undefined],
		[true, 'unsupported'],
	]) {
		const now = Date.now();
		const params = {
			resource: 'alertActivity',
			operation,
			activityTypes: ['16007'],
			accountIds: ['account-1'],
			options: {
				...(simplifyOutput ? {} : { simplifyOutput: false }),
				customActivityTypeIds: ['16006'],
			},
		};
		let sdlCalls = 0;
		const request = async (r) => {
			if (r.method === 'DELETE') return {};
			if (r.method === 'GET') return { data: [{ id: 'account-1', name: 'Account One' }] };
			if (r.url.includes('/sdl/v2/api/queries')) {
				sdlCalls++;
				const body = JSON.parse(r.body);
				assert.deepEqual(body.accountIds, ['account-1']);
				assert.equal(body.tenant, false);
				assert.equal(body.queryType, 'LOG');
				assert.match(body.log.filter, /16007/);
				return {
					id: 'job',
					stepsCompleted: 1,
					stepsTotal: 1,
					data: {
						matches: [
							{
								timestamp: String(BigInt(now - 1000) * 1000000n),
								values: {
									activity_id: 'event',
									activity_type: '16007',
									created_at: new Date(now - 1000).toISOString(),
									'data.alert.id': 'example-note-alert',
									'data.payload.note_text': 'Content from SDL',
								},
							},
						],
					},
				};
			}
			if (r.body.query.includes('ActivityAlerts'))
				return alertResponse([alertWithNotes('example-note-alert')]);
			assert.fail('Unexpected request path');
		};
		const node = new SentinelOnePlatformTrigger();
		const manual = createNodeContext(params, request);
		const result = await node.poll.call(manual);
		assert.equal(result[0][0].json.eventType, 'alert.activity');
		if (!simplifyOutput) {
			assert.equal(result[0][0].json.activityId, 'event');
			assert.equal(result[0][0].json.activityTypeId, '16007');
			assert.equal(result[0][0].json.note.text, 'Content from SDL');
			assert.equal(result[0][0].json.scope.source, 'current');
		} else {
			assert.equal(result[0][0].json.activityKind, 'noteCreated');
			assert.equal(result[0][0].json.note, 'Content from SDL');
			assert.equal(result[0][0].json.alertId, 'example-note-alert');
			assert.equal('activityId' in result[0][0].json, false);
		}
		assert.equal(manual.staticData.sentinelOneTrigger, undefined);
		assert.equal(sdlCalls, 1);
		const scheduled = createNodeContext(params, request, 'trigger');
		scheduled.getWorkflow = () => ({ id: `activity-output-${simplifyOutput}-${operation}` });
		assert.equal(await node.poll.call(scheduled), null);
		assert.match(scheduled.staticData.sentinelOneTrigger.configFingerprint, /:sdl-activities-v1$/);
		assert.equal(sdlCalls, 2);
	}
});

test('activity builder exposes every shared enum and only recorded value controls', () => {
	const {
		statusOptions,
		severityOptions,
		analystVerdictOptions,
	} = require('../../dist/nodes/shared/Descriptions');
	const properties = new SentinelOnePlatformTrigger().description.properties;
	const resource = properties.find((p) => p.name === 'resource');
	assert.deepEqual(
		resource.options.map((o) => o.value),
		['alert', 'alertActivity'],
	);
	const types = properties.find((p) => p.name === 'activityTypes');
	assert.deepEqual(types.default, ['any']);
	assert.equal(types.displayName, 'Operation');
	assert.equal(types.description, undefined);
	assert.deepEqual(
		types.options.map((o) => o.value).sort(),
		[
			'any',
			'16000',
			'16001',
			'16002',
			'16003',
			'16004',
			'16005',
			'16007',
			'16008',
			'unknown',
		].sort(),
	);
	const builder = properties.find((p) => p.name === 'activityConditions');
	assert.equal(builder.type, 'fixedCollection');
	assert.equal(builder.typeOptions.multipleValues, true);
	const controls = builder.options[0].values;
	for (const [suffix, options] of [
		['Status', statusOptions],
		['Severity', severityOptions],
		['Verdict', analystVerdictOptions],
	]) {
		for (const endpoint of ['from', 'to']) {
			const control = controls.find((p) => p.name === endpoint + suffix);
			assert.deepEqual(control.options, options);
			assert.deepEqual(control.default, []);
		}
	}
	assert.equal(
		controls.some((p) => p.name === 'previousIds'),
		false,
	);
	assert.match(
		controls.find((p) => p.name === 'previousEmail').description,
		/previous assignee email/,
	);
	assert.match(
		controls.find((p) => p.name === 'destinationIds').description,
		/previous assignee is not required/,
	);
	const activityOptions = properties.find(
		(p) => p.name === 'options' && p.displayOptions?.show?.resource?.includes('alertActivity'),
	).options;
	for (const name of [
		'includeRawActivity',
		'includeCurrentAlert',
		'excludeActorName',
		'excludeActorIds',
	])
		assert.ok(activityOptions.find((p) => p.name === name));
	assert.deepEqual(
		['excludeActorName', 'excludeActorIds'].map(
			(name) => activityOptions.find((property) => property.name === name).displayName,
		),
		['Exclude User Name', 'Exclude User IDs'],
	);
	assert.equal(
		activityOptions.some((p) => p.name === 'customActivityTypeIds'),
		false,
	);
	assert.equal(
		activityOptions.some((p) => p.type === 'json' || p.name === 'advancedFilters'),
		false,
	);
});

test('all unsupported trigger resource and operation pairs fail before requests', async () => {
	const supportedPairs = new Set([
		'alert:new',
		'alert:newOrUpdated',
		'alert:updated',
		'alertActivity:occurred',
		// n8n retains the other resource's operation; these are remapped, not rejected.
		'alert:occurred',
		'alertActivity:new',
		'alertActivity:newOrUpdated',
		'alertActivity:updated',
	]);
	for (const resource of ['alert', 'alertActivity', 'alertNote', 'unsupported']) {
		for (const operation of [
			'new',
			'newOrUpdated',
			'updated',
			'occurred',
			'created',
			'unsupported',
		]) {
			if (resource === 'alertActivity' || supportedPairs.has(`${resource}:${operation}`)) continue;
			const params = { resource, operation };
			const context = createNodeContext(params, async () =>
				assert.fail('Unsupported configuration must not request data'),
			);
			await assert.rejects(
				new SentinelOnePlatformTrigger().poll.call(context),
				(error) => error.message === 'Unsupported trigger resource or operation.',
			);
			assert.equal(context.staticData.sentinelOneTrigger, undefined);
		}
	}
});

test('an alert resource treats a retained activity operation as the alert default', async () => {
	const { NodeHelpers } = require('n8n-workflow');
	const node = new SentinelOnePlatformTrigger();
	const fingerprints = [];
	for (const savedOperation of ['occurred', 'new']) {
		const params = NodeHelpers.getNodeParameters(
			node.description.properties,
			{
				resource: 'alert',
				operation: savedOperation,
				accountIds: ['account-1'],
			},
			true,
			false,
			{ typeVersion: 1 },
			node.description,
		);
		assert.equal(params.operation, savedOperation, 'n8n retains the prior resource operation');
		let alertQueries = 0;
		const context = createNodeContext(
			params,
			async (request) => {
				if (request.method === 'GET') return { data: [{ id: 'account-1', name: 'Account One' }] };
				assert.match(request.url, /\/unifiedalerts\/graphql$/);
				alertQueries++;
				return alertResponse([]);
			},
			'trigger',
		);
		context.getWorkflow = () => ({ id: `retained-operation-${savedOperation}` });
		assert.equal(await node.poll.call(context), null);
		assert.ok(alertQueries > 0, 'the alert resource must query alerts');
		fingerprints.push(context.staticData.sentinelOneTrigger.configFingerprint);
	}
	assert.equal(fingerprints[0], fingerprints[1]);
});

test('saved groups without sites fail before requests for both trigger resources', async () => {
	const { NodeHelpers } = require('n8n-workflow');
	const node = new SentinelOnePlatformTrigger();
	for (const [resource, operation] of [
		['alert', 'new'],
		['alertActivity', 'occurred'],
	]) {
		const params = NodeHelpers.getNodeParameters(
			node.description.properties,
			{
				resource,
				operation,
				accountIds: ['account-1'],
				siteIds: [],
				groupIds: ['group-1'],
			},
			true,
			false,
			{ typeVersion: 1 },
			node.description,
		);
		assert.deepEqual(params.groupIds, ['group-1']);
		let requests = 0;
		const context = createNodeContext(
			params,
			async () => {
				requests++;
				assert.fail('Invalid saved groups must not request scopes or data');
			},
			'trigger',
		);
		const state = {
			configFingerprint: 'existing',
			lastPollTime: NOW - 1000,
			seenActivityTimestamps: { 'existing-activity': '1000000' },
		};
		context.staticData.sentinelOneTrigger = state;
		await assert.rejects(
			new SentinelOnePlatformTrigger().poll.call(context),
			/Group selections require a site selection.*Select the sites.*clear the saved group selections/,
		);
		assert.equal(requests, 0);
		assert.equal(context.staticData.sentinelOneTrigger, state);
		assert.deepEqual(context.staticData.sentinelOneTrigger, {
			configFingerprint: 'existing',
			lastPollTime: NOW - 1000,
			seenActivityTimestamps: { 'existing-activity': '1000000' },
		});
	}
});

test('runtime parameter filtering preserves selected sites after accounts are cleared', async () => {
	const { NodeHelpers } = require('n8n-workflow');
	const node = new SentinelOnePlatformTrigger();
	const params = NodeHelpers.getNodeParameters(
		node.description.properties,
		{
			resource: 'alert',
			operation: 'new',
			accountIds: [],
			siteIds: ['site-1'],
			groupIds: [],
		},
		true,
		false,
		{ typeVersion: 1 },
		node.description,
	);
	assert.deepEqual(params.siteIds, ['site-1']);
	let scopedQuery = false;
	const context = createNodeContext(
		params,
		async (request) => {
			if (request.method === 'GET') {
				assert.ok(request.url.endsWith('/sites'));
				return { data: { sites: [{ id: 'site-1', name: 'Site One' }] } };
			}
			assert.deepEqual(request.body.variables.scope, { scopeType: 'SITE', scopeIds: ['site-1'] });
			scopedQuery = true;
			return alertResponse([]);
		},
		'trigger',
	);
	await node.poll.call(context);
	assert.equal(scopedQuery, true);
});

test('runtime parameter filtering preserves blank scope IDs for validation', async () => {
	const { NodeHelpers } = require('n8n-workflow');
	const node = new SentinelOnePlatformTrigger();
	const params = NodeHelpers.getNodeParameters(
		node.description.properties,
		{
			resource: 'alert',
			operation: 'new',
			accountIds: [],
			siteIds: [''],
			groupIds: [],
		},
		true,
		false,
		{ typeVersion: 1 },
		node.description,
	);
	assert.deepEqual(params.siteIds, ['']);
	const context = createNodeContext(
		params,
		async () => {
			assert.fail('Blank scope IDs must fail before requests');
		},
		'trigger',
	);
	await assert.rejects(node.poll.call(context), /non-empty string or safe integer ID/);
});

test('activity trigger retains valid group selections and resolves their account', async () => {
	let queries = 0;
	const context = createNodeContext(
		{
			resource: 'alertActivity',
			operation: 'occurred',
			accountIds: ['account-1'],
			siteIds: ['site-1'],
			groupIds: ['group-1'],
		},
		async (request) => {
			if (request.method === 'DELETE') return {};
			if (request.method === 'GET') {
				if (request.url.endsWith('/accounts'))
					return { data: [{ id: 'account-1', name: 'Account One' }] };
				if (request.url.endsWith('/sites'))
					return { data: { sites: [{ id: 'site-1', name: 'Site One', accountId: 'account-1' }] } };
				if (request.url.endsWith('/groups'))
					return { data: [{ id: 'group-1', name: 'Group One', siteId: 'site-1' }] };
			}
			assert.match(request.url, /\/sdl\/v2\/api\/queries$/);
			const body = JSON.parse(request.body);
			assert.deepEqual(body.accountIds, ['account-1']);
			queries++;
			return { id: 'empty-job', stepsCompleted: 1, stepsTotal: 1, data: { matches: [] } };
		},
		'trigger',
	);
	assert.equal(await new SentinelOnePlatformTrigger().poll.call(context), null);
	assert.equal(queries, 1);
	assert.ok(context.staticData.sentinelOneTrigger.configFingerprint);
});

test('Match Conditions is always visible for activity immediately after recorded conditions', () => {
	const { NodeHelpers } = require('n8n-workflow');
	const properties = new SentinelOnePlatformTrigger().description.properties;
	const control = properties.find((p) => p.name === 'conditionMatch');
	assert.equal(control.default, 'any');
	assert.match(control.description, /two or more conditions/);
	assert.equal(
		properties.indexOf(control),
		properties.findIndex((p) => p.name === 'activityConditions') + 1,
	);
	for (const activityConditions of [
		{},
		{ conditions: [] },
		{ conditions: [{ field: 'status' }] },
	]) {
		assert.equal(
			NodeHelpers.displayParameter(
				{ resource: 'alertActivity', activityConditions },
				control,
				null,
				null,
			),
			true,
		);
	}
	assert.equal(NodeHelpers.displayParameter({ resource: 'alert' }, control, null, null), false);
});
test('top-level trigger scopes keep the group guard', async () => {
	for (const [resource, operation] of [
		['alert', 'new'],
		['alertActivity', 'occurred'],
	]) {
		const context = createNodeContext(
			{
				resource,
				operation,
				groupIds: ['new-group'],
			},
			async () => assert.fail('Must fail before requests'),
		);
		await assert.rejects(
			new SentinelOnePlatformTrigger().poll.call(context),
			/Group selections require a site selection/,
		);
	}
});

test('subtitle describes selected activity operations and alert operations', () => {
	const expression = new SentinelOnePlatformTrigger().description.subtitle;
	const evaluate = ($parameter) =>
		new Function('$parameter', 'return ' + expression.slice(3, -2))($parameter);
	assert.equal(evaluate({ resource: 'alertActivity' }), 'Alert activity: Any');
	assert.equal(
		evaluate({ resource: 'alertActivity', activityTypes: ['any'] }),
		'Alert activity: Any',
	);
	assert.equal(
		evaluate({ resource: 'alertActivity', activityTypes: ['16001', '16007'] }),
		'Alert activity: Status Changed, Note Created',
	);
	assert.equal(
		evaluate({ resource: 'alertActivity', activityTypes: ['16008', 'unknown'] }),
		'Alert activity: Agentic Investigation Triggered, Other (Unrecognised Types)',
	);
	assert.equal(evaluate({ resource: 'alert', operation: 'updated' }), 'Alert: Updated');
});

test('both resources expose the same Simplify option with default true', () => {
	const properties = new SentinelOnePlatformTrigger().description.properties;
	const controls = ['alert', 'alertActivity'].map((resource) =>
		properties
			.find((p) => p.name === 'options' && p.displayOptions.show.resource.includes(resource))
			.options.find((p) => p.name === 'simplifyOutput'),
	);
	assert.deepEqual(controls[0], controls[1]);
	assert.equal(controls[0].default, true);
	assert.equal(controls[0].type, 'boolean');
});

test('alert output renames only simplified fields and preserves full output', async () => {
	for (const simplifyOutput of [true, false]) {
		const c = config({ simplifyOutput });
		const parent = { ...alert('output-alert'), externalId: 'source-alert' };
		const result = await pollSentinelOne(
			async () => alertResponse([parent]),
			c,
			initializedState(c),
			'scheduled',
			NOW,
		);
		const item = result.items[0];
		if (simplifyOutput) {
			assert.equal(item.alertName, parent.name);
			assert.equal(item.alertStatus, parent.status);
			assert.equal(item.alertSeverity, parent.severity);
			assert.equal(item.alertExternalId, parent.externalId);
			for (const key of ['name', 'status', 'severity', 'externalId', 'eventTimestamp'])
				assert.equal(key in item, false);
			assert.equal(item.eventTime, parent.createdAt);
			for (const key of [
				'createdAt',
				'updatedAt',
				'detectedAt',
				'firstSeenAt',
				'lastSeenAt',
				'noteExists',
			])
				assert.equal(item[key], parent[key] ?? null);
		} else {
			assert.deepEqual(item, {
				eventId: 'tenant.example/alert/output-alert/new',
				eventType: 'alert.new',
				eventTime: parent.createdAt,
				eventTimestamp: parent.createdAt,
				scope: item.scope,
				alert: parent,
			});
		}
	}
});

test('SDL error routing survives the node authenticated request wrapper on 404 and 429 retries and cleanup', async () => {
	const routingHeader = 'x-dataset-query-forward-tag';
	const node = new SentinelOnePlatformTrigger();
	const now = Date.now();
	const sdlRequests = [];
	let polls = 0;
	const request = async (options) => {
		if (!options.url.includes('/sdl/')) {
			if (options.method === 'GET') return { data: [{ id: 'account-1' }] };
			return alertResponse([alert('routing-alert')]);
		}
		sdlRequests.push(options);
		if (options.method === 'DELETE') return {};
		if (options.method === 'POST')
			return {
				headers: { [routingHeader]: 'initial' },
				body: { id: 'routing-query', stepsCompleted: 0, stepsTotal: 1 },
			};
		polls++;
		if (polls <= 2) {
			assert.equal(options.headers[routingHeader], polls === 1 ? 'initial' : 'route-404');
			const status = polls === 1 ? 404 : 429;
			throw new NodeApiError(
				node.description,
				Object.assign(new Error(`HTTP ${status}`), {
					isAxiosError: true,
					response: {
						status,
						headers: { [routingHeader]: `route-${status}`, 'x-private': 'do not forward' },
						data: {},
					},
				}),
			);
		}
		assert.equal(options.headers[routingHeader], 'route-429');
		assert.equal('x-private' in options.headers, false);
		return {
			id: 'routing-query',
			stepsCompleted: 1,
			stepsTotal: 1,
			data: {
				matches: [
					{
						timestamp: String(BigInt(now - 1000) * 1000000n),
						values: {
							activity_id: 'routing-event',
							activity_type: '16007',
							created_at: new Date(now - 1000).toISOString(),
							'data.alert.id': 'routing-alert',
							'data.payload.note_text': 'Example note',
						},
					},
				],
			},
		};
	};
	const context = createNodeContext(
		{
			resource: 'alertActivity',
			activityTypes: ['16007'],
			accountIds: ['account-1'],
		},
		request,
	);
	const result = await node.poll.call(context);
	assert.equal(
		result[0][0].json.eventId,
		'tenant.example/alert/routing-alert/activity/routing-event',
	);
	assert.equal(
		sdlRequests.find((request) => request.method === 'DELETE').headers[routingHeader],
		'route-429',
	);
});

test('A dense manual alert preview stops at its page cap without splitting its time range', async () => {
	let calls = 0;
	const triggerConfig = config({
		maxAlertPages: 1,
		alertPageSize: 1,
		excludeAccountName: 'Account One',
	});
	await assert.rejects(
		pollSentinelOne(
			async () => {
				calls++;
				return alertResponse([alert('excluded')], { hasNextPage: true, endCursor: 'next' });
			},
			triggerConfig,
			{},
			'manual',
			NOW,
		),
		/configured page limit/,
	);
	assert.equal(calls, 1);
});
