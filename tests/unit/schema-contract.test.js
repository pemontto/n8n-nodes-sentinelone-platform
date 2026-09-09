const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { buildSchema, parse, validate } = require('graphql');
const {
	GRAPHQL_DOCUMENTS,
	getManyAlertsDocument,
} = require('../../dist/nodes/SentinelOnePlatform/actions/documents.js');
const {
	alertDetailSelection,
	alertDetailFieldOptions,
	alertListSelection,
	additionalAlertFieldOptions,
} = require('../../dist/nodes/shared/AlertFields.js');
const { OCSF_QUERY } = require('../../dist/nodes/SentinelOnePlatformTrigger/Ocsf.js');
const { ALERT_QUERY } = require('../../dist/nodes/SentinelOnePlatformTrigger/ActivityNotePoll.js');
const {
	pollSentinelOne,
} = require('../../dist/nodes/SentinelOnePlatformTrigger/SentinelOneTriggerHelpers.js');

for (const fixture of ['console-a.graphql', 'console-b.graphql']) {
	const schema = buildSchema(readFileSync(join(__dirname, '../fixtures/schema', fixture), 'utf8'));
	function valid(document) {
		assert.deepEqual(
			validate(schema, parse(document)).map((error) => error.message),
			[],
		);
	}
	test(`${fixture}: action documents match the API contract`, () => {
		for (const document of Object.values(GRAPHQL_DOCUMENTS)) valid(document);
	});
	test(`${fixture}: common fields and every optional projection are valid`, () => {
		for (const fields of [[], alertDetailFieldOptions.map((field) => field.value)]) {
			valid(`query Detail($id:ID!){alert(id:$id){${alertDetailSelection(fields)}}}`);
		}
		for (const fields of [[], additionalAlertFieldOptions.map((field) => field.value)])
			valid(getManyAlertsDocument(alertListSelection(fields)));
		valid('query Readback($id:ID!){alert(id:$id){id status analystVerdict ticketId}}');
	});
	test(`${fixture}: note-parent and OCSF documents are valid`, () => {
		valid(ALERT_QUERY);
		valid(OCSF_QUERY);
	});
	test(`${fixture}: the actual trigger sends a valid expanded polling document`, async () => {
		let requests = 0;
		await pollSentinelOne(
			async (request) => {
				valid(request.body.query);
				requests++;
				return {
					data: { alerts: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
				};
			},
			{
				baseUrl: 'https://tenant.example',
				credentialIdentity: { id: 'example' },
				scopeType: 'ACCOUNT',
				scopeIds: ['account-example'],
				allVisibleAccounts: false,
				events: ['alert.new'],
				severities: [],
				statuses: [],
				alertName: '',
				simplifyOutput: false,
				debug: false,
				overlapSeconds: 300,
				concurrentRequests: 5,
				requestTimeoutMs: 30000,
				alertPageSize: 200,
				maxAlertPages: 25,
				additionalAlertFields: additionalAlertFieldOptions.map((field) => field.value),
			},
			{},
			'manual',
			Date.UTC(2026, 0, 1),
		);
		assert.equal(requests, 1);
	});
}
