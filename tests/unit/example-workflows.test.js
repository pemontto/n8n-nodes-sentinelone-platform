const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dir = path.resolve(__dirname, '../../examples/workflows');
const workflows = fs
	.readdirSync(dir)
	.filter((f) => f.endsWith('.json'))
	.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const run = (node, json, linked = {}) =>
	new Function('$json', '$', node.parameters.jsCode)(json, (name) => ({
		item: { json: linked[name] },
	}));

test('four public workflows are inactive, credential-free and use platform identifiers', () => {
	assert.equal(workflows.length, 4);
	for (const workflow of workflows) {
		assert.equal(workflow.active, false);
		assert.deepEqual(workflow.pinData, {});
		const names = new Set(workflow.nodes.map((n) => n.name));
		for (const node of workflow.nodes) {
			assert.equal(node.credentials, undefined);
			assert.equal(node.retryOnFail, undefined);
			if (!node.type.startsWith('n8n-nodes-base.'))
				assert.match(
					node.type,
					/^n8n-nodes-sentinelone-platform\.sentinelOnePlatform(?:Trigger)?$/,
				);
		}
		for (const [source, connection] of Object.entries(workflow.connections)) {
			assert.ok(names.has(source));
			for (const edge of connection.main.flat()) assert.ok(names.has(edge.node));
		}
		assert.doesNotMatch(JSON.stringify(workflow), /https?:\/\/|@|\/Users\//i);
	}
});

test('every write requires an explicit ID and a fetched XDR Demo account', () => {
	for (const workflow of workflows.filter((w) =>
		w.nodes.some((n) => ['update', 'create'].includes(n.parameters.operation)),
	)) {
		const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));
		const config = run(byName['Configure test'], {}).json;
		assert.equal(config.alertId, '');
		assert.equal(config.expectedAccountName, 'XDR Demo');
		assert.throws(() => run(byName['Require explicit alert ID'], config), /explicit/);
		const input = { ...config, alertId: 'test-alert' };
		const linked = { 'Require explicit alert ID': input };
		const alert = {
			id: 'test-alert',
			realTime: { scope: { account: { name: 'XDR Demo' } } },
			status: 'NEW',
			ticketId: 'existing',
		};
		assert.equal(
			run(byName['Guard demo account'], alert, linked).json.original.ticketId,
			'existing',
		);
		assert.throws(
			() => run(byName['Guard demo account'], { ...alert, id: 'other' }, linked),
			/does not match/,
		);
		assert.throws(
			() => run(byName['Guard demo account'], { id: 'test-alert' }, linked),
			/Write blocked/,
		);
		assert.throws(
			() =>
				run(
					byName['Guard demo account'],
					{ ...alert, realTime: { scope: { account: { name: 'Other' } } } },
					linked,
				),
			/Write blocked/,
		);
		const writes = workflow.nodes.filter((n) =>
			['update', 'create'].includes(n.parameters.operation),
		);
		for (const write of writes) {
			const incoming = Object.entries(workflow.connections)
				.filter(([, c]) => c.main.flat().some((e) => e.node === write.name))
				.map(([name]) => name);
			assert.deepEqual(incoming, ['Guard demo account']);
			assert.equal(write.parameters.alertId, '={{ $json.alertId }}');
		}
	}
});

test('update captures original state and enables verification; reads add raw data only on opt-in', () => {
	const update = workflows.flatMap((w) => w.nodes).find((n) => n.parameters.operation === 'update');
	assert.equal(update.parameters.options.verifyUpdate, true);
	assert.equal(update.parameters.useAdvancedUpdatePayload, true);
	const read = workflows.find((w) => w.name.includes('Read and fields'));
	assert.deepEqual(read.nodes.find((n) => n.name === 'Get common fields').parameters.options, {});
	assert.deepEqual(
		read.nodes.find((n) => n.name === 'Get optional fields').parameters.options
			.additionalAlertFields,
		['rawData'],
	);
});

test('note listener migrates to note-only Alert Activity and snapshot listener stays unchanged', () => {
	const listeners = workflows
		.flatMap((w) => w.nodes)
		.filter((n) => n.type.endsWith('Trigger') && n.type.includes('sentinelOnePlatform'));
	const note = listeners.find((n) => n.id === '00000000-0000-4000-8000-000000000018');
	assert.equal(note.parameters.resource, 'alertActivity');
	assert.equal(note.parameters.operation, 'occurred');
	assert.deepEqual(note.parameters.activityTypes, ['16007']);
	assert.equal(note.name, 'Listen for demo notes');
	assert.deepEqual(note.parameters.accountIds, []);
	assert.deepEqual(note.parameters.siteIds, []);
	assert.deepEqual(note.parameters.groupIds, []);
	const snapshot = listeners.find((n) => n.parameters.resource === 'alert');
	assert.equal(snapshot.parameters.operation, 'newOrUpdated');
	assert.equal(snapshot.parameters.activityTypes, undefined);
});
