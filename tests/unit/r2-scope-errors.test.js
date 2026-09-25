const assert = require('node:assert/strict');
const test = require('node:test');
const { NodeApiError, NodeOperationError } = require('n8n-workflow');
const {
	loadListScopeOptions,
	readListScope,
	discoverVisibleScopes,
} = require('../../dist/nodes/shared/Scopes.js');
const {
	SentinelOnePlatformTrigger,
} = require('../../dist/nodes/SentinelOnePlatformTrigger/SentinelOnePlatformTrigger.node.js');
const {
	pollAlertActivities,
} = require('../../dist/nodes/SentinelOnePlatformTrigger/ActivityNotePoll.js');
const {
	fingerprintConfig,
} = require('../../dist/nodes/SentinelOnePlatformTrigger/SentinelOneTriggerHelpers.js');
const { PollBudgetError } = require('../../dist/nodes/shared/transport/request.js');
const {
	updateUnifiedAlert,
} = require('../../dist/nodes/SentinelOnePlatform/actions/alert/update.operation.js');
const {
	executeSdlQuery,
} = require('../../dist/nodes/SentinelOnePlatform/actions/sdlQuery/execute.operation.js');
const {
	SentinelOnePlatform,
} = require('../../dist/nodes/SentinelOnePlatform/SentinelOnePlatform.node.js');

const now = Date.parse('2026-09-25T12:00:00.000Z');

function triggerContext(resource, statusCode) {
	const staticData = {};
	const parameters = {
		resource,
		operation: resource === 'alertActivity' ? 'occurred' : 'new',
		accountIds: ['account-1'],
		siteIds: [],
		groupIds: [],
		activityTypes: ['any'],
		options: {},
	};
	return {
		staticData,
		logger: { debug() {}, info() {}, warn() {} },
		helpers: {
			httpRequestWithAuthentication: async (_credential, request) => {
				assert.match(request.url, /\/accounts$/);
				throw { statusCode, message: `HTTP ${statusCode}` };
			},
			returnJsonArray: (items) => items.map((json) => ({ json })),
		},
		getCredentials: async () => ({ baseUrl: 'https://tenant.example', apiToken: 'hidden' }),
		getMode: () => 'scheduled',
		getNode: () => ({
			id: 'trigger-1',
			name: 'SentinelOne Trigger',
			credentials: { sentinelOnePlatformApi: { id: 'credential-1' } },
		}),
		getNodeParameter: (name, fallback) => parameters[name] ?? fallback,
		getWorkflowStaticData: () => staticData,
		getWorkflow: () => ({ id: 'workflow-1' }),
	};
}

test('saved-scope validation keeps 401, 403 and 429 for both trigger resources', async () => {
	const trigger = new SentinelOnePlatformTrigger();
	for (const resource of ['alert', 'alertActivity']) {
		for (const statusCode of [401, 403, 429]) {
			await assert.rejects(trigger.poll.call(triggerContext(resource, statusCode)), (error) => {
				assert.ok(error instanceof NodeApiError);
				assert.equal(error.httpCode, String(statusCode));
				return true;
			});
		}
	}
});

test('site fallback failures keep their HTTP status after account discovery is denied', async () => {
	for (const statusCode of [401, 429]) {
		const paths = [];
		await assert.rejects(
			discoverVisibleScopes(
				async (request) => {
					paths.push(request.url);
					if (request.url.endsWith('/accounts')) throw { statusCode: 403 };
					throw { statusCode };
				},
				'https://tenant.example',
				{ name: 'SentinelOne Trigger' },
			),
			(error) => {
				assert.ok(error instanceof NodeApiError);
				assert.equal(error.httpCode, String(statusCode));
				return true;
			},
		);
		assert.equal(paths[0], 'https://tenant.example/web/api/v2.1/accounts');
		assert.ok(paths.length >= 2);
		assert.ok(paths.slice(1).every((path) => path === 'https://tenant.example/web/api/v2.1/sites'));
	}
});

function loadOptionsContext(request, parameters = {}) {
	return {
		getNode: () => ({ name: 'SentinelOne' }),
		getCredentials: async () => ({ baseUrl: 'https://tenant.example' }),
		getNodeParameter: (name, fallback) => parameters[name] ?? fallback,
		helpers: { httpRequestWithAuthentication: async (_credential, options) => request(options) },
	};
}

test('Sites falls back to unscoped site discovery when account discovery is empty', async () => {
	const paths = [];
	const result = await loadListScopeOptions(
		loadOptionsContext(async (request) => {
			paths.push(request.url);
			return request.url.endsWith('/accounts')
				? { data: [], pagination: { nextCursor: null } }
				: { data: { sites: [{ id: 'site-1', name: 'London' }] }, pagination: { nextCursor: null } };
		}),
		'SITE',
	);
	assert.deepEqual(paths, [
		'https://tenant.example/web/api/v2.1/accounts',
		'https://tenant.example/web/api/v2.1/sites',
	]);
	assert.deepEqual(result, [{ name: 'London', value: 'site-1' }]);
});

test('Sites uses the selected account directly without loading every account', async () => {
	const paths = [];
	await loadListScopeOptions(
		loadOptionsContext(
			async (request) => {
				paths.push(request.url);
				assert.equal(request.qs.accountIds, 'account-1');
				return {
					data: { sites: [{ id: 'site-1', name: 'London' }] },
					pagination: { nextCursor: null },
				};
			},
			{ accountIds: ['account-1'] },
		),
		'SITE',
	);
	assert.deepEqual(paths, ['https://tenant.example/web/api/v2.1/sites']);
});

test('legacy Get Many rejects group selections without a site', async () => {
	let calls = 0;
	const context = {
		getNode: () => ({ name: 'SentinelOne' }),
		getNodeParameter(name, _itemIndex, fallback) {
			return (
				{ options: {}, accountIds: ['account-1'], siteIds: [], groupIds: ['group-1'] }[name] ??
				fallback
			);
		},
		getCredentials: async () => ({ baseUrl: 'https://tenant.example' }),
		helpers: {
			httpRequestWithAuthentication: async () => {
				calls++;
			},
		},
	};
	await assert.rejects(readListScope(context, 0), (error) => {
		assert.ok(error instanceof NodeOperationError);
		assert.match(error.message, /Group selections require a site selection/);
		return true;
	});
	assert.equal(calls, 0);
});

function updateContext(request) {
	const parameters = {
		resource: 'alert',
		operation: 'update',
		alertId: 'alert-1',
		updateFields: { status: 'RESOLVED' },
		options: { verifyUpdate: false },
	};
	return {
		getNode: () => ({
			name: 'SentinelOne',
			type: 'sentinelOnePlatform',
			typeVersion: 1,
			parameters,
		}),
		getNodeParameter: (name, _index, fallback) => parameters[name] ?? fallback,
		getCredentials: async () => ({ baseUrl: 'https://tenant.example', apiToken: 'hidden' }),
		helpers: {
			httpRequestWithAuthentication: async (_credential, options) => request(options.body),
		},
	};
}

function rejectedUpdate(body) {
	if (body.query.includes('SentinelOneAvailableAlertActions'))
		return {
			data: {
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
					errors: [],
				},
			},
		};
	return {
		data: {
			alertTriggerActions: {
				__typename: 'TriggerActionsError',
				errors: [{ errorType: 'INVALID_STATE', errorMessage: 'Rejected by service' }],
			},
		},
	};
}

test('HTTP 200 update rejection omits invented status and retains safe rejection details', async () => {
	await assert.rejects(updateUnifiedAlert(updateContext(rejectedUpdate), 0), (error) => {
		assert.ok(error instanceof NodeApiError);
		assert.equal(error.httpCode, undefined);
		assert.equal(error.alertId, 'alert-1');
		assert.deepEqual(error.requested, { status: 'RESOLVED' });
		assert.equal(error.mutationAcknowledged, false);
		assert.equal(error.context.errors[0].errorType, 'INVALID_STATE');
		assert.match(error.description, /INVALID_STATE/);
		return true;
	});
});

test('continue-error-output rejection keeps item error, detail fields and pairedItem', async () => {
	const node = new SentinelOnePlatform();
	const parameters = {
		resource: 'alert',
		operation: 'update',
		alertId: 'alert-1',
		updateFields: { status: 'RESOLVED' },
		options: { verifyUpdate: false },
	};
	const context = {
		continueOnFail: () => true,
		getInputData: () => [{ json: {} }],
		getNode: () => ({
			name: 'SentinelOne',
			type: 'sentinelOnePlatform',
			typeVersion: 1,
			parameters,
			onError: 'continueErrorOutput',
		}),
		getNodeParameter: (name, index, fallback) => parameters[name] ?? fallback,
		getCredentials: async () => ({ baseUrl: 'https://tenant.example', apiToken: 'hidden' }),
		helpers: {
			httpRequestWithAuthentication: async (_credential, options) => rejectedUpdate(options.body),
		},
	};
	const [items] = await node.execute.call(context);
	assert.equal(items.length, 1);
	assert.ok(items[0].error instanceof NodeApiError);
	assert.equal(items[0].json.alertId, 'alert-1');
	assert.deepEqual(items[0].json.requested, { status: 'RESOLVED' });
	assert.deepEqual(items[0].json.errors[0].errorType, 'INVALID_STATE');
	assert.equal(items[0].json.mutationAcknowledged, false);
	assert.deepEqual(items[0].pairedItem, { item: 0 });
});

test('activity budget failures identify the checkpoint as an ISO timestamp', async () => {
	const config = {
		baseUrl: 'https://tenant.example',
		credentialIdentity: { id: 'credential-1' },
		scopeType: 'ACCOUNT',
		scopeIds: ['account-1'],
		allVisibleAccounts: false,
		events: ['alert.activity'],
		severities: [],
		statuses: [],
		alertName: '',
		simplifyOutput: true,
		debug: false,
		overlapSeconds: 300,
		requestTimeoutMs: 30000,
	};
	const checkpoint = now - 60_000;
	const previous = {
		configFingerprint: `${fingerprintConfig(config)}:sdl-activities-v1`,
		initialized: true,
		checkpointMs: checkpoint,
		activityActivationMs: checkpoint - 1000,
		seenActivityIds: [],
		seenActivityTimestamps: {},
	};
	await assert.rejects(
		pollAlertActivities(
			async () => {
				throw new PollBudgetError();
			},
			config,
			previous,
			'scheduled',
			now,
		),
		(error) => {
			assert.match(error.message, new RegExp(new Date(checkpoint).toISOString()));
			assert.doesNotMatch(error.message, new RegExp(String(checkpoint)));
			return true;
		},
	);
});

test('SDL HTTP failures retain status as NodeApiError', async () => {
	const context = {
		getNode: () => ({ name: 'SentinelOne' }),
		getNodeParameter: (name, _index, fallback) =>
			({
				query: 'dataSource.name = "Process"',
				startTime: '2026-09-25T00:00:00Z',
				endTime: '2026-09-25T01:00:00Z',
				queryScope: 'tenant',
				accountIds: [],
				outputMode: 'rows',
				options: {},
			})[name] ?? fallback,
		getCredentials: async () => ({ baseUrl: 'https://tenant.example', apiToken: 'hidden' }),
		getExecutionCancelSignal: () => undefined,
		helpers: {
			httpRequestWithAuthentication: async () => ({ body: '{}', headers: {}, statusCode: 401 }),
		},
	};
	await assert.rejects(executeSdlQuery(context, 0), (error) => {
		assert.ok(error instanceof NodeApiError);
		assert.equal(error.httpCode, '401');
		return true;
	});
});

test('SDL polling HTTP failures retain status after query cleanup', async () => {
	const context = {
		getNode: () => ({ name: 'SentinelOne' }),
		getNodeParameter: (name, _index, fallback) =>
			({
				query: 'dataSource.name = "Process"',
				startTime: '2026-09-25T00:00:00Z',
				endTime: '2026-09-25T01:00:00Z',
				queryScope: 'tenant',
				accountIds: [],
				outputMode: 'rows',
				options: { pollIntervalMs: 1000 },
			})[name] ?? fallback,
		getCredentials: async () => ({ baseUrl: 'https://tenant.example', apiToken: 'hidden' }),
		getExecutionCancelSignal: () => undefined,
		helpers: {
			httpRequestWithAuthentication: async (_credential, request) => {
				if (request.method === 'POST')
					return {
						body: JSON.stringify({ id: 'query-1', stepsCompleted: 0, stepsTotal: 1, data: null }),
						headers: { 'x-dataset-query-forward-tag': 'route-A' },
						statusCode: 200,
					};
				return { body: '{}', headers: {}, statusCode: request.method === 'GET' ? 400 : 204 };
			},
		},
	};
	await assert.rejects(executeSdlQuery(context, 0), (error) => {
		assert.ok(error instanceof NodeApiError);
		assert.equal(error.httpCode, '400');
		assert.match(error.message, /poll failed with HTTP 400/);
		return true;
	});
});
