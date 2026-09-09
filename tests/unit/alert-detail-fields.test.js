const test = require('node:test');
const assert = require('node:assert/strict');
const {
	alertDetailSelection,
	alertDetailFieldOptions,
} = require('../../dist/nodes/shared/AlertFields.js');

test('detail selection always includes common fields and keeps raw data opt-in', () => {
	assert.match(alertDetailSelection([]), /^id\n/);
	assert.match(alertDetailSelection([]), /severity/);
	assert.match(alertDetailSelection([]), /assets \{/);
	assert.doesNotMatch(alertDetailSelection(), /rawData/);
	assert.match(alertDetailSelection(['rawData']), /rawData/);
	const selection = alertDetailSelection(['name'], 'process { username file { sha256 } }');
	assert.match(selection, /process \{ username file \{ sha256 \} \}/);
	assert.doesNotMatch(selection, /rawData/);
	assert.match(
		alertDetailSelection([], 'enrichments { ... on Example { value } }'),
		/\.\.\. on Example/,
	);
	assert.ok(alertDetailFieldOptions.some((field) => field.value === 'rawData'));
	assert.ok(!alertDetailFieldOptions.some((field) => field.value === 'severity'));
});

test('additional detail fields cannot escape the alert selection or override identity with an alias', () => {
	for (const value of [
		'name } } mutation { delete',
		'id: externalId',
		'name @skip(if:true)',
		'process {}',
		'process { file { name }',
		'{ name }',
		'... fragment',
	]) {
		assert.throws(() => alertDetailSelection([], value));
	}
	assert.throws(() => alertDetailSelection(['__proto__']));
});
