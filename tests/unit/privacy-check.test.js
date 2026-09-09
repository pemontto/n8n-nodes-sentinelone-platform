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
	assert.deepEqual(inspectText('11111111-1111-4111-8111-111111111111'), []);
});

test('package allowlist excludes documentation captures, schemas, workflows, and unexpected runtime files', async () => {
	const { allowedPackageFile } = await import('../../scripts/package-check.mjs');
	for (const file of [
		'package.json',
		'README.md',
		'dist/nodes/shared/fields.js',
		'dist/nodes/Example/Example.node.js.map',
		'dist/credentials/Example.credentials.d.ts',
	])
		assert.equal(allowedPackageFile(file), true, file);
	for (const file of [
		'docs/capture.json',
		'tests/fixtures/schema.graphql',
		'.env',
		'examples/workflow.json',
		'dist/nodes/private.txt',
		'dist/nodes/../../secret.json',
		'dist/nodes/../secret.json',
	])
		assert.equal(allowedPackageFile(file), false, file);
});
