const assert = require('node:assert/strict');
const test = require('node:test');
const { activityAccountIds } = require('../../dist/nodes/shared/Scopes.js');

test('ActivityFeed resolves parent accounts through sites without listing accounts', async () => {
	const urls = [];
	const ids = await activityAccountIds(
		async (r) => {
			urls.push(r.url);
			assert.equal(r.qs.siteIds, 'site-1,site-2');
			return {
				data: {
					sites: [
						{ id: 'site-1', accountId: 'a' },
						{ id: 'site-2', accountId: 'a' },
					],
				},
			};
		},
		'https://tenant.example',
		'SITE',
		['site-1', 'site-2'],
	);
	assert.deepEqual(ids, ['a']);
	assert.equal(urls.length, 1);
	assert.ok(urls[0].endsWith('/sites'));
});

test('ActivityFeed group scopes resolve through their sites', async () => {
	const ids = await activityAccountIds(
		async (r) =>
			r.url.endsWith('/groups')
				? { data: [{ id: 'g', siteId: 's' }] }
				: { data: { sites: [{ id: 's', accountId: 'a' }] } },
		'https://tenant.example',
		'GROUP',
		['g'],
	);
	assert.deepEqual(ids, ['a']);
});

test('ActivityFeed scope discovery rejects missing parents and repeated cursors', async () => {
	await assert.rejects(
		() =>
			activityAccountIds(
				async () => ({ data: { sites: [{ id: 's' }] } }),
				'https://tenant.example',
				'SITE',
				['s'],
			),
		/parent/,
	);
	await assert.rejects(
		() =>
			activityAccountIds(async () => ({ data: { sites: [] } }), 'https://tenant.example', 'SITE', [
				's',
			]),
		/no longer visible/,
	);
	await assert.rejects(
		() =>
			activityAccountIds(
				async () => ({
					data: { sites: [{ id: 's', accountId: 'a' }] },
					pagination: { nextCursor: 'same' },
				}),
				'https://tenant.example',
				'SITE',
				['s'],
			),
		/repeated/,
	);
});
