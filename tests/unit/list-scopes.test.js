const assert = require('node:assert/strict');
const test = require('node:test');
const { readListScope, loadListScopeOptions } = require('../../dist/nodes/shared/Scopes');

function fixture(
	parameters,
	request = async () => {
		throw new Error('Unexpected request');
	},
) {
	return {
		getNode: () => ({ name: 'SentinelOne', parameters }),
		getNodeParameter: (name, index, fallback) => parameters[name] ?? fallback,
		getCredentials: async () => ({ baseUrl: 'https://tenant.example' }),
		helpers: { httpRequestWithAuthentication: async (_name, options) => request(options) },
	};
}

test('empty Get Many hierarchy uses all accessible alerts without management requests', async () => {
	assert.equal(
		await readListScope(fixture({ accountIds: [], siteIds: [], groupIds: [] }), 0),
		null,
	);
});

test('legacy group selections without a site are rejected before management requests', async () => {
	let requests = 0;
	await assert.rejects(
		readListScope(
			fixture({ accountIds: ['a'], siteIds: [], groupIds: ['old-group'] }, async () => {
				requests++;
			}),
			0,
		),
		/Group selections require a site selection/,
	);
	assert.equal(requests, 0);
});

test('Get Many validates every selected level and uses the narrowest scope', async () => {
	const calls = [];
	const context = fixture(
		{ accountIds: ['a'], siteIds: ['s'], groupIds: ['g', 'g'] },
		async (request) => {
			calls.push(request);
			if (request.url.endsWith('/accounts')) return { data: [{ id: 'a' }] };
			if (request.url.endsWith('/sites')) return { data: { sites: [{ id: 's' }] } };
			return { data: [{ id: 'g' }] };
		},
	);
	assert.deepEqual(await readListScope(context, 0), { scopeType: 'GROUP', scopeIds: ['g'] });
	assert.equal(calls[1].qs.accountIds, 'a');
	assert.equal(calls[1].qs.siteIds, 's');
	assert.equal(calls[2].qs.accountIds, 'a');
	assert.equal(calls[2].qs.siteIds, 's');
	assert.equal(calls[2].qs.groupIds, 'g');
});

test('stale child selections fail instead of broadening the list query', async () => {
	const context = fixture({ accountIds: ['a'], siteIds: ['wrong'] }, async (request) =>
		request.url.endsWith('/accounts') ? { data: [{ id: 'a' }] } : { data: { sites: [] } },
	);
	await assert.rejects(readListScope(context, 0), /no longer belongs/);
});

test('malformed selections fail before requesting management data', async () => {
	await assert.rejects(readListScope(fixture({ siteIds: 's' }), 0), /array/);
	await assert.rejects(readListScope(fixture({ siteIds: [9007199254740992] }), 0), /safe integer/);
});

test('old scope parameters are ignored by the fresh platform package', async () => {
	assert.equal(await readListScope(fixture({ scopeType: 'SITE', scopeIds: ['s'] }), 0), null);
});

test('site and group option loaders pass the selected parents', async () => {
	const calls = [];
	const context = fixture({ accountIds: ['a'], siteIds: ['s'] }, async (request) => {
		calls.push(request);
		return request.url.endsWith('/sites') ? { data: { sites: [] } } : { data: [] };
	});
	context.getNodeParameter = (name, fallback) => context.getNode().parameters[name] ?? fallback;
	await loadListScopeOptions(context, 'SITE');
	await loadListScopeOptions(context, 'GROUP');
	assert.equal(calls[0].qs.accountIds, 'a');
	assert.equal(calls[0].qs.siteIds, undefined);
	assert.equal(calls[1].qs.accountIds, 'a');
	assert.equal(calls[1].qs.siteIds, 's');
});

test('nested scope replaces the complete legacy selection and explicit empty clears it', async () => {
	const { readManagementScopeIds } = require('../../dist/nodes/shared/Scopes');
	for (const scope of [
		{},
		{ selection: {} },
		{ selection: { accountIds: [], siteIds: [], groupIds: [] } },
	]) {
		const context = fixture({
			accountIds: ['legacy-account'],
			siteIds: ['legacy-site'],
			groupIds: ['legacy-group'],
			options: { scope },
		});
		for (const name of ['accountIds', 'siteIds', 'groupIds'])
			assert.deepEqual(readManagementScopeIds(context, name, 0), []);
		assert.equal(await readListScope(context, 0), null);
	}
	const context = fixture(
		{
			accountIds: ['legacy-account'],
			siteIds: ['legacy-site'],
			groupIds: ['legacy-group'],
			options: { scope: { selection: { accountIds: ['new-account'] } } },
		},
		async (request) => {
			assert.ok(request.url.endsWith('/accounts'));
			return { data: [{ id: 'new-account' }] };
		},
	);
	assert.deepEqual(await readListScope(context, 0), {
		scopeType: 'ACCOUNT',
		scopeIds: ['new-account'],
	});
});

test('nested scope validates malformed objects without falling back to legacy scope', async () => {
	for (const scope of [
		null,
		[],
		'invalid',
		{ selection: null },
		{ selection: [] },
		{ selection: { accountIds: 'invalid' } },
		{ selection: { accountIds: null } },
	]) {
		await assert.rejects(
			readListScope(fixture({ accountIds: ['legacy-account'], options: { scope } }), 0),
			/object|array/,
		);
	}
});

test('nested scope option loaders use the visible selected parents', async () => {
	const calls = [];
	const context = fixture(
		{
			accountIds: ['legacy'],
			options: { scope: { selection: { accountIds: ['new-account'], siteIds: ['new-site'] } } },
		},
		async (request) => {
			calls.push(request);
			return request.url.endsWith('/sites') ? { data: { sites: [] } } : { data: [] };
		},
	);
	context.getNodeParameter = (name, fallback) => context.getNode().parameters[name] ?? fallback;
	await loadListScopeOptions(context, 'SITE');
	await loadListScopeOptions(context, 'GROUP');
	assert.equal(calls[0].qs.accountIds, 'new-account');
	assert.equal(calls[1].qs.siteIds, 'new-site');
});

test('nested scope loaders wait for the parent selection before listing children', async () => {
	const loaderContext = (parameters, request) => {
		const context = fixture(parameters, request);
		context.getNodeParameter = (name, fallback) => context.getNode().parameters[name] ?? fallback;
		return context;
	};
	const empty = loaderContext({ options: { scope: { selection: {} } } }, async (request) => {
		if (request.url.endsWith('/accounts')) return { data: [] };
		assert.ok(request.url.endsWith('/sites'));
		return { data: { sites: [{ id: 'site-1', name: 'London' }] } };
	});
	assert.deepEqual(await loadListScopeOptions(empty, 'SITE'), [
		{ name: 'London', value: 'site-1' },
	]);
	assert.deepEqual(await loadListScopeOptions(empty, 'GROUP'), [
		{ name: 'Select a Site First', value: '__selectParentFirst' },
	]);

	const calls = [];
	const selected = loaderContext(
		{ options: { scope: { selection: { accountIds: ['a'], siteIds: ['s'] } } } },
		async (request) => {
			calls.push(request);
			return request.url.endsWith('/sites') ? { data: { sites: [] } } : { data: [] };
		},
	);
	await loadListScopeOptions(selected, 'SITE');
	await loadListScopeOptions(selected, 'GROUP');
	assert.equal(calls[0].qs.accountIds, 'a');
	assert.equal(calls[0].qs.siteIds, undefined);
	assert.equal(calls[1].qs.accountIds, 'a');
	assert.equal(calls[1].qs.siteIds, 's');
});

test('parent placeholders are ignored while blank IDs are rejected', async () => {
	const { readManagementScopeIds } = require('../../dist/nodes/shared/Scopes');
	const context = fixture({
		options: {
			scope: {
				selection: {
					accountIds: ['a'],
					siteIds: ['__selectParentFirst'],
					groupIds: ['__selectParentFirst'],
				},
			},
		},
	});
	assert.deepEqual(readManagementScopeIds(context, 'siteIds', 0), []);
	assert.deepEqual(readManagementScopeIds(context, 'groupIds', 0), []);
	assert.throws(
		() => readManagementScopeIds(fixture({ siteIds: [''] }), 'siteIds', 0),
		/non-empty/,
	);
	assert.throws(
		() => readManagementScopeIds(fixture({ siteIds: ['  '] }), 'siteIds', 0),
		/non-empty/,
	);
});

test('site options stay available when account discovery returns 403', async () => {
	const calls = [];
	const context = fixture({ accountIds: [] }, async (request) => {
		calls.push(request);
		if (request.url.endsWith('/accounts')) throw { statusCode: 403 };
		return { data: { sites: [{ id: 'site-1', name: 'Site One' }] } };
	});
	context.getNodeParameter = (name, fallback) => context.getNode().parameters[name] ?? fallback;
	assert.deepEqual(await loadListScopeOptions(context, 'SITE'), [
		{ name: 'Site One', value: 'site-1' },
	]);
	assert.ok(calls[1].url.endsWith('/sites'));
	assert.equal(calls[1].qs.accountIds, undefined);
});

test('new Get Many scope rejects groups without sites before any request', async () => {
	let requests = 0;
	const context = fixture(
		{
			siteIds: ['legacy-site'],
			options: { scope: { selection: { accountIds: ['new-account'], groupIds: ['new-group'] } } },
		},
		async () => {
			requests++;
			assert.fail('Invalid nested group scope must not request data');
		},
	);
	await assert.rejects(
		readListScope(context, 0),
		/Group selections require a site selection.*Select the sites.*clear the group selections/,
	);
	assert.equal(requests, 0);
});
