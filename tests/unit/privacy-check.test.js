const assert = require('node:assert/strict');
const { test } = require('node:test');

test('privacy check detects private values without exposing them in findings', async () => {
	const { inspectText } = await import('../../scripts/privacy-check.mjs');
	const privatePath = ['/', 'Users', '/', 'example-person', '/', 'project'].join('');
	const tenant = ['https://', 'customer-console', '.sentinelone.net'].join('');
	const token = ['npm_', 'a'.repeat(36)].join('');
	assert.deepEqual(inspectText(privatePath), ['private filesystem path']);
	assert.deepEqual(inspectText(tenant), ['non-example SentinelOne tenant hostname']);
	assert.deepEqual(inspectText(token), ['embedded access token']);
	assert.deepEqual(
		inspectText(
			JSON.stringify({
				nodes: [{ credentials: { service: { id: 'example-id', name: 'Example' } } }],
			}),
			'workflow.json',
		),
		['embedded workflow credential reference'],
	);
});

test('privacy check permits generic examples and credential type definitions', async () => {
	const { inspectText } = await import('../../scripts/privacy-check.mjs');
	assert.deepEqual(
		inspectText(
			'https://your-tenant.sentinelone.net https://docs.sentinelone.com externalTicketId',
		),
		[],
	);
	assert.deepEqual(
		inspectText(
			JSON.stringify({ n8n: { credentials: ['dist/credentials/Example.credentials.js'] } }),
			'package.json',
		),
		[],
	);
	const uuid = ['7d3e91a2', 'c4b0', '4f19', '9a6e', '2b58c0d4e713'].join('-');
	assert.deepEqual(inspectText(uuid), ['UUID record identifier']);
	assert.deepEqual(inspectText(['7d3e91a2', 'c4b0', '5f19', '9a6e', '2b58c0d4e713'].join('-')), [
		'UUID record identifier',
	]);
});

test('privacy check ignores placeholder and documented example UUIDs', async () => {
	const { inspectText } = await import('../../scripts/privacy-check.mjs');
	assert.deepEqual(inspectText(['11111111', '1111', '4111', '8111', '111111111111'].join('-')), []);
	assert.deepEqual(inspectText(['00000000', '0000', '4000', '8000', '000000000007'].join('-')), []);
	assert.deepEqual(inspectText(['abc000e0', '9c3e', '432b', '8654', '0360b10800cb'].join('-')), []);
	const mixed = `${['11111111', '1111', '4111', '8111', '111111111111'].join('-')} ${[
		'7d3e91a2',
		'c4b0',
		'4f19',
		'9a6e',
		'2b58c0d4e713',
	].join('-')}`;
	assert.deepEqual(inspectText(mixed), ['UUID record identifier']);
});

test('package allowlist excludes documentation captures, schemas, workflows, and unexpected runtime files', async () => {
	const { allowedPackageFile } = await import('../../scripts/package-check.mjs');
	for (const file of [
		'package.json',
		'README.md',
		'dist/nodes/shared/fields.js',
		'dist/nodes/Example/Example.node.js.map',
		'dist/credentials/Example.credentials.d.ts',
		'dist/icons/sentinelone.svg',
	])
		assert.equal(allowedPackageFile(file), true, file);
	for (const file of [
		'docs/capture.json',
		'tests/fixtures/schema.graphql',
		'.env',
		'examples/workflow.json',
		'dist/nodes/private.txt',
		'dist/icons/private.png',
		'dist/nodes/../../secret.json',
		'dist/nodes/../secret.json',
	])
		assert.equal(allowedPackageFile(file), false, file);
});
