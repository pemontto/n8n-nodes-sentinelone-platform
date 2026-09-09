const test = require('node:test');
const assert = require('node:assert/strict');
const {
	parseActivitySelection,
	parseActivityConditions,
	matchesActivityConditions,
	mitigationActionTypes,
	mitigationActivityStatuses,
} = require('../../dist/nodes/SentinelOnePlatformTrigger/ActivityConditions.js');
const {
	statusOptions,
	severityOptions,
	analystVerdictOptions,
} = require('../../dist/nodes/shared/Descriptions.js');
const event = (changes = [], extra = {}) => ({ changes, ...extra });

test('all shared enum values are accepted by the builder and matched exactly', () => {
	for (const [field, suffix, options] of [
		['status', 'Status', statusOptions],
		['severity', 'Severity', severityOptions],
		['analystVerdict', 'Verdict', analystVerdictOptions],
	]) {
		for (const { value } of options) {
			const [condition] = parseActivityConditions({
				conditions: [{ field, [`from${suffix}`]: [value], [`to${suffix}`]: [value] }],
			});
			assert.deepEqual(condition.from, [value]);
			assert.deepEqual(condition.to, [value]);
			assert.equal(
				matchesActivityConditions(event([{ field, oldValue: null, newValue: value }]), [
					{ field, to: [value] },
				]),
				true,
			);
			assert.equal(
				matchesActivityConditions(event([{ field, oldValue: value, newValue: null }]), [
					{ field, from: [value] },
				]),
				true,
			);
		}
	}
});
test('transitions require distinct present endpoints, retaining null and UNDEFINED semantics', () => {
	for (const change of [
		{ field: 'status' },
		{ field: 'status', newValue: 'NEW' },
		{ field: 'status', oldValue: 'NEW' },
		{ field: 'status', oldValue: 'NEW', newValue: 'NEW' },
		{ field: 'status', oldValue: null, newValue: null },
	])
		assert.equal(matchesActivityConditions(event([change]), [{ field: 'status' }]), false);
	assert.equal(
		matchesActivityConditions(
			event([{ field: 'analystVerdict', oldValue: 'UNDEFINED', newValue: null }]),
			[{ field: 'analystVerdict', from: ['UNDEFINED'] }],
		),
		true,
	);
	assert.equal(
		matchesActivityConditions(
			event([{ field: 'analystVerdict', oldValue: null, newValue: 'UNDEFINED' }]),
			[{ field: 'analystVerdict', from: ['UNDEFINED'] }],
		),
		false,
	);
});
test('lists use OR, endpoints use AND on one change, conditions use any/all on one activity', () => {
	const changes = [
		{ field: 'status', oldValue: 'NEW', newValue: 'RESOLVED' },
		{ field: 'severity', oldValue: 'LOW', newValue: 'MEDIUM' },
	];
	const conditions = [
		{ field: 'status', from: ['NEW', 'IN_PROGRESS'], to: ['RESOLVED'] },
		{ field: 'severity', from: ['LOW'], to: ['HIGH'] },
	];
	assert.equal(matchesActivityConditions(event(changes), conditions, 'any'), true);
	assert.equal(matchesActivityConditions(event(changes), conditions, 'all'), false);
	assert.equal(
		matchesActivityConditions(event(changes), [
			{ field: 'status', from: ['RESOLVED'], to: ['RESOLVED'] },
		]),
		false,
	);
	assert.equal(
		matchesActivityConditions(
			event([
				{ field: 'status', oldValue: 'NEW', newValue: 'IN_PROGRESS' },
				{ field: 'status', oldValue: 'IN_PROGRESS', newValue: 'RESOLVED' },
			]),
			[{ field: 'status', from: ['NEW'], to: ['RESOLVED'] }],
		),
		false,
	);
	assert.equal(
		matchesActivityConditions(
			event(changes),
			[conditions[0], { field: 'severity', to: ['MEDIUM'] }],
			'all',
		),
		true,
	);
});
test('assignment matches supplied values without requiring a previous ID or email', () => {
	const partial = event([
		{ field: 'assigneeId', newValue: '90071992547409930000' },
		{ field: 'assigneeEmail', newValue: 'new@example.invalid' },
	]);
	assert.equal(
		matchesActivityConditions(partial, [
			{ field: 'assignment', destinationIds: ['90071992547409930000'] },
		]),
		true,
	);
	assert.equal(
		matchesActivityConditions(partial, [
			{ field: 'assignment', newEmail: ['new@example.invalid'] },
		]),
		true,
	);
	assert.equal(
		matchesActivityConditions(partial, [
			{ field: 'assignment', previousEmail: ['old@example.invalid'] },
		]),
		false,
	);
	partial.changes[1].oldValue = 'old@example.invalid';
	assert.equal(
		matchesActivityConditions(partial, [
			{
				field: 'assignment',
				previousEmail: ['old@example.invalid'],
				newEmail: ['new@example.invalid'],
			},
		]),
		true,
	);
});
test('mitigation filters accept every schema action and status as values', () => {
	for (const actionType of mitigationActionTypes)
		for (const activityStatus of mitigationActivityStatuses) {
			const conditions = parseActivityConditions({
				conditions: [
					{ field: 'mitigation', actionTypes: [actionType], activityStatuses: [activityStatus] },
				],
			});
			assert.equal(
				matchesActivityConditions(
					event([], { mitigation: { actionType, activityStatus } }),
					conditions,
				),
				true,
			);
		}
	assert.equal(
		matchesActivityConditions(
			event([], { mitigation: { actionType: 'WORKFLOW', activityStatus: 'RUNNING' } }),
			[{ field: 'mitigation', activityStatuses: ['SUCCESS'] }],
		),
		false,
	);
});
test('selection supports any, named types and custom-only numeric IDs', () => {
	assert.equal(parseActivitySelection(['any'], '16006'), undefined);
	assert.deepEqual(parseActivitySelection(['16007'], '16006, 16006'), ['16006', '16007']);
	assert.deepEqual(parseActivitySelection([], '16006'), ['16006']);
	for (const args of [
		[[], ''],
		[['16006'], ''],
		[['16007'], '1 or true'],
		[['16007'], ['16006']],
	])
		assert.throws(() => parseActivitySelection(...args));
});
test('invalid builder values and unknown condition types fail before matching', () => {
	for (const conditions of [
		[{ field: 'status', toStatus: ['CLOSED'] }],
		[{ field: 'previousAssigneeId' }],
		[{ field: 'mitigation', actionTypes: ['COMPLETE'] }],
	])
		assert.throws(() => parseActivityConditions({ conditions }));
});
