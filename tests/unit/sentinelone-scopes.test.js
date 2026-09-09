const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const test = require('node:test');

const packageRoot = resolve('.');
const builtScopes = join(packageRoot, 'dist/nodes/shared/Scopes.js');
const sourceScopes = join(packageRoot, 'nodes/shared/Scopes.ts');
const scopesModule = process.env.N8N_NODE_TEST_MODULE
	? resolve(process.env.N8N_NODE_TEST_MODULE)
	: existsSync(builtScopes)
		? builtScopes
		: sourceScopes;

const {
	MAX_MANAGEMENT_SCOPE_LOAD_MS,
	MAX_MANAGEMENT_SCOPE_OPTIONS,
	MAX_MANAGEMENT_SCOPE_PAGES,
	loadManagementScopeOptions,
	normalizeBaseUrl,
} = require(scopesModule);

function contextFor(request, baseUrl = ' https://tenant.example/// ') {
	const credentialCalls = [];
	const authenticationCalls = [];
	return {
		credentialCalls,
		authenticationCalls,
		context: {
			getCredentials: async (name) => {
				credentialCalls.push(name);
				return { baseUrl, apiToken: 'must-not-appear' };
			},
			getNode: () => ({ id: 'node-1', name: 'SentinelOne' }),
			helpers: {
				httpRequestWithAuthentication: async function (credentialName, options) {
					authenticationCalls.push({ credentialName, receiver: this, options });
					return await request(options);
				},
			},
		},
	};
}

test('normalizes the management console URL', () => {
	assert.equal(normalizeBaseUrl(' https://tenant.example//// '), 'https://tenant.example');
	assert.equal(normalizeBaseUrl(undefined), '');
});

test('loads every account page through the SentinelOne credential and sorts by name then ID', async () => {
	const requests = [];
	const fixture = contextFor(async (options) => {
		requests.push(options);
		if (options.qs.cursor === undefined) {
			return {
				data: [
					{ id: 12, name: 'Zulu' },
					{ id: '20', name: 'Same' },
				],
				pagination: { nextCursor: 'next-page' },
			};
		}
		return {
			data: [
				{ id: '10', name: 'Same' },
				{ id: '12', name: 'Duplicate is ignored' },
			],
			pagination: { nextCursor: null },
		};
	});

	const options = await loadManagementScopeOptions(fixture.context, 'ACCOUNT');

	assert.deepEqual(options, [
		{ name: 'Same', value: '10' },
		{ name: 'Same', value: '20' },
		{ name: 'Zulu', value: '12' },
	]);
	assert.deepEqual(fixture.credentialCalls, ['sentinelOnePlatformApi']);
	assert.equal(fixture.authenticationCalls.length, 2);
	for (const call of fixture.authenticationCalls) {
		assert.equal(call.credentialName, 'sentinelOnePlatformApi');
		assert.equal(call.receiver, fixture.context);
		assert.equal(call.options.method, 'GET');
		assert.equal(call.options.url, 'https://tenant.example/web/api/v2.1/accounts');
		assert.equal(call.options.timeout, 30_000);
		assert.equal(call.options.json, true);
		assert.equal(call.options.sendCredentialsOnCrossOriginRedirect, false);
		assert.equal(call.options.qs.limit, 1000);
		assert.equal(call.options.qs.states, 'active');
	}
	assert.equal(requests[0].qs.cursor, undefined);
	assert.equal(requests[1].qs.cursor, 'next-page');
});

test('parses site and group response envelopes and builds useful labels', async () => {
	const siteFixture = contextFor(async () => ({
		data: {
			sites: [
				{ id: 'site-2', name: 'London', accountName: 'Beta' },
				{ id: 'site-1', name: 'London', accountName: 'Acme' },
			],
		},
		pagination: { nextCursor: null },
	}));
	assert.deepEqual(await loadManagementScopeOptions(siteFixture.context, 'SITE'), [
		{ name: 'Acme / London', value: 'site-1' },
		{ name: 'Beta / London', value: 'site-2' },
	]);

	let groupRequest;
	const groupFixture = contextFor(async (options) => {
		groupRequest = options;
		return {
			data: [
				{ id: 'group-2', name: 'Servers', siteId: 'site-2' },
				{ id: 'group-1', name: 'Workstations', siteName: 'London' },
			],
			pagination: { nextCursor: null },
		};
	});
	assert.deepEqual(await loadManagementScopeOptions(groupFixture.context, 'GROUP'), [
		{ name: 'London / Workstations', value: 'group-1' },
		{ name: 'Site site-2 / Servers', value: 'group-2' },
	]);
	assert.equal(groupRequest.qs.states, undefined);
});

test('returns no accounts only when account discovery is denied', async () => {
	for (const error of [{ statusCode: 403 }, { response: { status: '403' } }]) {
		const fixture = contextFor(async () => {
			throw error;
		});
		assert.deepEqual(await loadManagementScopeOptions(fixture.context, 'ACCOUNT'), []);
	}
});

test('fails other permission and service errors without exposing response details', async () => {
	for (const [scopeType, error, expected] of [
		['SITE', { statusCode: 403, apiToken: 'secret-value' }, /does not have permission/],
		['ACCOUNT', { statusCode: 401, body: 'secret-value' }, /authentication failed/],
		['GROUP', { statusCode: 429, message: 'secret-value' }, /rate limit/],
		['SITE', { response: { statusCode: 503, data: 'secret-value' } }, /service is unavailable/],
	]) {
		const fixture = contextFor(async () => {
			throw error;
		});
		await assert.rejects(
			() => loadManagementScopeOptions(fixture.context, scopeType),
			(caught) => {
				assert.match(caught.message, expected);
				assert.doesNotMatch(caught.message, /secret-value|must-not-appear/);
				return true;
			},
		);
	}
});

test('rejects repeated cursors instead of looping', async () => {
	let calls = 0;
	const fixture = contextFor(async () => {
		calls++;
		return {
			data: [],
			pagination: { nextCursor: 'same-cursor' },
		};
	});

	await assert.rejects(
		() => loadManagementScopeOptions(fixture.context, 'ACCOUNT'),
		/repeated the accounts cursor/,
	);
	assert.equal(calls, 2);
});

test('accepts an absent cursor as a terminal one-page response', async () => {
	for (const pagination of [undefined, {}]) {
		const response = { data: [{ id: 'account-1', name: 'Account' }] };
		if (pagination !== undefined) response.pagination = pagination;
		const fixture = contextFor(async () => response);
		assert.deepEqual(await loadManagementScopeOptions(fixture.context, 'ACCOUNT'), [
			{ name: 'Account', value: 'account-1' },
		]);
	}
});

test('rejects malformed pagination', async () => {
	for (const response of [
		{ data: [], pagination: null },
		{ data: [], pagination: { nextCursor: '' } },
		{ data: [], pagination: { nextCursor: 123 } },
	]) {
		const fixture = contextFor(async () => response);
		await assert.rejects(
			() => loadManagementScopeOptions(fixture.context, 'ACCOUNT'),
			/pagination/,
		);
	}
});

test('rejects malformed data envelopes and scope items', async () => {
	for (const [scopeType, data] of [
		['ACCOUNT', {}],
		['SITE', []],
		['SITE', { sites: null }],
		['GROUP', [null]],
		['ACCOUNT', [{ name: 'Missing ID' }]],
		['ACCOUNT', [{ id: '' }]],
	]) {
		const fixture = contextFor(async () => ({
			data,
			pagination: { nextCursor: null },
		}));
		await assert.rejects(
			() => loadManagementScopeOptions(fixture.context, scopeType),
			/response contains|expected data list/,
		);
	}
});

test('rejects unsafe and non-integer numeric IDs', async () => {
	for (const id of [Number.MAX_SAFE_INTEGER + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		const fixture = contextFor(async () => ({
			data: [{ id }],
			pagination: { nextCursor: null },
		}));
		await assert.rejects(
			() => loadManagementScopeOptions(fixture.context, 'ACCOUNT'),
			/without a valid ID/,
		);
	}
});

test('fails when unique cursors exceed the page bound', async () => {
	let calls = 0;
	const fixture = contextFor(async () => {
		calls++;
		return {
			data: [],
			pagination: { nextCursor: `cursor-${calls}` },
		};
	});

	await assert.rejects(
		() => loadManagementScopeOptions(fixture.context, 'ACCOUNT'),
		new RegExp(`exceeded ${MAX_MANAGEMENT_SCOPE_PAGES} pages`),
	);
	assert.equal(calls, MAX_MANAGEMENT_SCOPE_PAGES);
});

test('fails instead of truncating when the option-count bound is exceeded', async () => {
	const scopes = Array.from({ length: MAX_MANAGEMENT_SCOPE_OPTIONS + 1 }, (_, index) => ({
		id: `account-${index}`,
		name: `Account ${index}`,
	}));
	const fixture = contextFor(async () => ({
		data: scopes,
		pagination: { nextCursor: null },
	}));

	await assert.rejects(
		() => loadManagementScopeOptions(fixture.context, 'ACCOUNT'),
		new RegExp(`more than ${MAX_MANAGEMENT_SCOPE_OPTIONS} accounts scopes`),
	);
});

test('fails when management-scope loading exceeds its elapsed-time bound', async () => {
	const originalNow = Date.now;
	let now = 1_000;
	Date.now = () => now;
	try {
		const fixture = contextFor(async () => {
			now += MAX_MANAGEMENT_SCOPE_LOAD_MS;
			return { data: [], pagination: { nextCursor: null } };
		});
		await assert.rejects(
			() => loadManagementScopeOptions(fixture.context, 'ACCOUNT'),
			new RegExp(`exceeded ${MAX_MANAGEMENT_SCOPE_LOAD_MS / 1000} seconds`),
		);
	} finally {
		Date.now = originalNow;
	}
});

test('rejects a missing management console URL before making a request', async () => {
	let requested = false;
	const fixture = contextFor(async () => {
		requested = true;
	}, ' /// ');

	await assert.rejects(
		() => loadManagementScopeOptions(fixture.context, 'ACCOUNT'),
		/missing its Management Console URL/,
	);
	assert.equal(requested, false);
});
