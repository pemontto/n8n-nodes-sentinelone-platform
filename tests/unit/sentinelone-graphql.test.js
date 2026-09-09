const assert = require('node:assert/strict');
const test = require('node:test');

const {
	createAlertNote,
} = require('../../dist/nodes/SentinelOnePlatform/actions/alertNote/create.operation.js');
const {
	getManyAlertNotes,
} = require('../../dist/nodes/SentinelOnePlatform/actions/alertNote/getMany.operation.js');
const {
	getManyUnifiedAlerts,
} = require('../../dist/nodes/SentinelOnePlatform/actions/alert/getMany.operation.js');
const {
	getUnifiedAlert,
} = require('../../dist/nodes/SentinelOnePlatform/actions/alert/get.operation.js');
const {
	updateUnifiedAlert,
} = require('../../dist/nodes/SentinelOnePlatform/actions/alert/update.operation.js');

const ALERT_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '90071992547409930001';

const node = {
	id: 'sentinel-one',
	name: 'SentinelOne',
	type: 'n8n-nodes-sentinelone-platform.sentinelOnePlatform',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

function alert(overrides = {}) {
	return {
		id: ALERT_ID,
		status: 'NEW',
		analystVerdict: 'UNDEFINED',
		ticketId: null,
		realTime: {
			scope: {
				account: { id: ACCOUNT_ID },
				site: { id: 'site-1' },
				group: { id: 'group-1' },
			},
		},
		...overrides,
	};
}

function note(id, text = 'note text', type = 'PLAIN_TEXT', createdBy = null) {
	return {
		id,
		alertId: ALERT_ID,
		text,
		type,
		createdAt: '2026-09-07T10:00:00.000Z',
		updatedAt: '2026-09-07T10:00:00.000Z',
		createdBy,
	};
}

function envelope(root, value, extra = {}) {
	return { data: { [root]: value }, ...extra };
}

function context(parameters, request) {
	return {
		getNode: () => ({ ...node, parameters }),
		getCredentials: async () => ({
			baseUrl: 'https://tenant.example/',
			apiToken: 'never-return-this',
		}),
		getNodeParameter: (name, _index, fallback) =>
			Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : fallback,
		helpers: {
			httpRequestWithAuthentication: async (credential, options) =>
				options.method === 'GET'
					? {
							data: (parameters.accountIds ?? []).map((id) => ({ id, name: 'Demo' })),
							pagination: { nextCursor: null },
						}
					: request(credential, options),
		},
	};
}

function baseParameters(extra = {}) {
	return {
		useAdvancedUpdatePayload: Object.prototype.hasOwnProperty.call(extra, 'advancedUpdatePayload'),
		scopeType: 'ACCOUNT',
		accountIds: [ACCOUNT_ID],
		alertId: ALERT_ID,
		...extra,
	};
}

function operationName(options) {
	return options.body.query.match(/(?:query|mutation)\s+(SentinelOne\w+)/)?.[1];
}

test('Get sends a fixed scoped document and returns the matching alert', async () => {
	let captured;
	const result = await getUnifiedAlert(
		context(baseParameters(), async (_credential, options) => {
			captured = options;
			return envelope('alert', alert());
		}),
		3,
	);

	assert.equal(captured.method, 'POST');
	assert.equal(captured.sendCredentialsOnCrossOriginRedirect, false);
	assert.equal(captured.url, 'https://tenant.example/web/api/v2.1/unifiedalerts/graphql');
	assert.match(captured.body.query, /alert\(id: \$id\)/);
	assert.deepEqual(captured.body.variables, {
		id: ALERT_ID,
	});
	assert.equal(result[0].id, ALERT_ID);
});

test('Get accepts an alert ID without scope and still rejects a different returned ID', async () => {
	const params = { alertId: ALERT_ID, scopeIds: [] };
	const result = await getUnifiedAlert(
		context(params, async (_credential, options) => {
			assert.equal(options.body.variables.scope, undefined);
			return envelope('alert', { id: ALERT_ID });
		}),
		0,
	);
	assert.equal(result[0].id, ALERT_ID);
	await assert.rejects(
		getUnifiedAlert(
			context(params, async () => envelope('alert', { id: 'wrong' })),
			0,
		),
		/did not return the requested alert/,
	);
});

test('Get requests raw data only through Additional Alert Fields', async () => {
	for (const additionalAlertFields of [[], ['rawData']]) {
		await getUnifiedAlert(
			context(
				{ alertId: ALERT_ID, options: { additionalAlertFields } },
				async (_credential, options) => {
					assert.equal(options.body.query.includes('rawData'), additionalAlertFields.length > 0);
					assert.match(options.body.query, /severity/);
					return envelope('alert', { id: ALERT_ID });
				},
			),
			0,
		);
	}
});

test('Get Many ignores empty guided filter selections', async () => {
	await getManyUnifiedAlerts(
		context(
			baseParameters({
				returnAll: false,
				limit: 1,
				filters: { severities: [], statuses: [], analystVerdicts: [] },
			}),
			async (_credential, options) => {
				assert.deepEqual(options.body.variables.filters, []);
				return envelope('alerts', { edges: [], pageInfo: { hasNextPage: false, endCursor: null } });
			},
		),
		0,
	);
});

test('Get ignores saved scope parameters when an alert ID is supplied', async () => {
	await getUnifiedAlert(
		context({ alertId: ALERT_ID, accountIds: [ACCOUNT_ID] }, async (_credential, options) => {
			assert.equal(options.body.variables.scope, undefined);
			return envelope('alert', alert());
		}),
		0,
	);
	await getUnifiedAlert(
		context(baseParameters({ scopeIds: [] }), async () => envelope('alert', alert())),
		0,
	);
});

test('HTTP 200 GraphQL errors fail even when partial data is present', async () => {
	const secretText = 'note text that must not leak';
	await assert.rejects(
		getUnifiedAlert(
			context(baseParameters(), async () => ({
				data: { alert: alert() },
				errors: [
					{
						message: 'Resolver failed',
						extensions: { code: 'BAD_USER_INPUT', unsafe: secretText },
					},
				],
			})),
			0,
		),
		(error) => {
			assert.match(error.message, /GraphQL operation failed/);
			assert.doesNotMatch(error.message, new RegExp(secretText));
			assert.equal(error.context.itemIndex, 0);
			return true;
		},
	);
});

test('GraphQL transport errors preserve safe HTTP status codes', async () => {
	await assert.rejects(
		getUnifiedAlert(
			context(baseParameters(), async () => {
				throw { statusCode: 403, message: 'response body must not be copied' };
			}),
			0,
		),
		(error) => {
			assert.equal(error.httpCode, '403');
			assert.doesNotMatch(error.message, /response body/);
			return true;
		},
	);
});

test('numeric alert and scope IDs are rejected instead of coerced', async (t) => {
	await t.test('numeric alert ID', async () => {
		await assert.rejects(
			getUnifiedAlert(
				context(baseParameters({ alertId: 123 }), async () => {
					throw new Error('request should not run');
				}),
				0,
			),
			/non-empty ID/i,
		);
	});
	await t.test('numeric scope ID', async () => {
		await assert.rejects(
			getManyUnifiedAlerts(
				context(baseParameters({ accountIds: [9007199254740992] }), async () => {
					throw new Error('request should not run');
				}),
				0,
			),
			/every selected.*non-empty string or safe integer ID/i,
		);
	});
});

test('Get rejects a different returned alert ID without exposing it', async () => {
	await assert.rejects(
		getUnifiedAlert(
			context(baseParameters(), async () => envelope('alert', alert({ id: 'other-alert' }))),
			0,
		),
		(error) => {
			assert.match(error.message, /did not return the requested alert/i);
			assert.doesNotMatch(error.message, /other-account/);
			return true;
		},
	);
});

test('Get Many maps guided filters, uses modern sorts, paginates, and respects Limit', async () => {
	const requests = [];
	const pages = [
		envelope('alerts', {
			edges: [
				{ cursor: 'edge-1', node: alert({ id: 'alert-1' }) },
				{ cursor: 'edge-2', node: alert({ id: 'alert-2' }) },
			],
			pageInfo: { hasNextPage: true, endCursor: 'page-1' },
			totalCount: 3,
		}),
		envelope('alerts', {
			edges: [{ cursor: 'edge-3', node: alert({ id: 'alert-3' }) }],
			pageInfo: { hasNextPage: false, endCursor: 'page-2' },
			totalCount: 3,
		}),
	];
	const result = await getManyUnifiedAlerts(
		context(
			baseParameters({
				returnAll: false,
				limit: 3,
				filters: {
					severities: ['HIGH'],
					statuses: ['NEW', 'IN_PROGRESS'],
					analystVerdicts: ['TRUE_POSITIVE_MALWARE'],
					createdAfter: '2026-09-01T00:00:00.000Z',
					externalId: 'external-1',
				},
			}),
			async (_credential, options) => {
				requests.push(options);
				return pages.shift();
			},
		),
		0,
	);

	assert.deepEqual(
		result.map((item) => item.id),
		['alert-1', 'alert-2', 'alert-3'],
	);
	assert.equal(requests.length, 2);
	assert.equal(requests[1].body.variables.after, 'page-1');
	assert.deepEqual(requests[0].body.variables.sorts, [{ by: 'createdAt', order: 'DESC' }]);
	assert.doesNotMatch(requests[0].body.query, /\bsort:/);
	assert.deepEqual(requests[0].body.variables.filters, [
		{ fieldId: 'severity', stringIn: { values: ['HIGH'] } },
		{ fieldId: 'status', stringIn: { values: ['NEW', 'IN_PROGRESS'] } },
		{ fieldId: 'analystVerdict', stringIn: { values: ['TRUE_POSITIVE_MALWARE'] } },
		{ fieldId: 'createdAt', dateTimeRange: { start: Date.parse('2026-09-01T00:00:00.000Z') } },
		{ fieldId: 'externalId', stringEqual: { value: 'external-1' } },
	]);
});

test('Get Many rejects a repeated Relay cursor and a malformed continuation', async (t) => {
	await t.test('repeated cursor', async () => {
		let calls = 0;
		await assert.rejects(
			getManyUnifiedAlerts(
				context(baseParameters({ returnAll: true, filters: {} }), async () => {
					calls++;
					return envelope('alerts', {
						edges: [{ cursor: `edge-${calls}`, node: alert({ id: `alert-${calls}` }) }],
						pageInfo: { hasNextPage: true, endCursor: 'same-cursor' },
						totalCount: 10,
					});
				}),
				0,
			),
			/repeated an alert pagination cursor/i,
		);
	});

	await t.test('empty continuation page', async () => {
		await assert.rejects(
			getManyUnifiedAlerts(
				context(baseParameters({ returnAll: true, filters: {} }), async () =>
					envelope('alerts', {
						edges: [],
						pageInfo: { hasNextPage: true, endCursor: 'next' },
						totalCount: 1,
					}),
				),
				0,
			),
			/empty alert page/i,
		);
	});
});

test('Get Many Return All fails at its safety cap without returning a truncated result', async () => {
	const tooMany = Array.from({ length: 10_001 }, (_, index) => ({
		cursor: `edge-${index}`,
		node: alert({ id: `alert-${index}` }),
	}));
	await assert.rejects(
		getManyUnifiedAlerts(
			context(baseParameters({ returnAll: true, filters: {} }), async () =>
				envelope('alerts', {
					edges: tooMany,
					pageInfo: { hasNextPage: false, endCursor: null },
					totalCount: tooMany.length,
				}),
			),
			0,
		),
		/limited to 10,000 alerts/i,
	);
});

test('Get Many rejects unknown filter keys and reversed dates', async (t) => {
	for (const [name, filters, expected] of [
		['unknown key', { name: 'anything' }, /Unknown alert filter/i],
		[
			'reversed date',
			{ createdAfter: '2026-09-02T00:00:00Z', createdBefore: '2026-09-01T00:00:00Z' },
			/cannot be later/i,
		],
	]) {
		await t.test(name, async () => {
			await assert.rejects(
				getManyUnifiedAlerts(
					context(baseParameters({ returnAll: false, limit: 10, filters }), async () => {
						throw new Error('request should not run');
					}),
					0,
				),
				expected,
			);
		});
	}
});

test('Update discovers actions, orders dependencies, sends an exact ID filter, and verifies readback', async () => {
	const requests = [];

	const result = await updateUnifiedAlert(
		context(
			baseParameters({
				updateFields: {
					status: 'RESOLVED',
					analystVerdict: 'TRUE_POSITIVE_MALWARE',
				},
				advancedUpdatePayload: '{}',
			}),
			async (_credential, options) => {
				requests.push(options);
				switch (operationName(options)) {
					case 'SentinelOneVerifyUpdate':
						return envelope(
							'alert',
							alert({ status: 'RESOLVED', analystVerdict: 'TRUE_POSITIVE_MALWARE' }),
						);
					case 'SentinelOneAvailableAlertActions':
						return envelope('alertAvailableActions', {
							data: [
								{
									id: 'S1/alert/statusUpdate',
									title: 'Disabled legacy hint',
									isDisabled: true,
									disabledReason: 'tenant-specific reason',
									types: ['STATUS_UPDATE'],
									triggeredAfter: [],
									triggersActions: [],
								},
								{
									id: 'runtime/status-action',
									title: 'Set status',
									isDisabled: false,
									types: ['STATUS_UPDATE'],
									triggeredAfter: ['runtime/verdict-action'],
									triggersActions: [],
								},
								{
									id: 'runtime/verdict-action',
									title: 'Set verdict',
									isDisabled: false,
									types: ['ANALYST_VERDICT_UPDATE'],
									triggeredAfter: [],
									triggersActions: [],
								},
							],
							errors: [],
						});
					case 'SentinelOneUpdateAlert':
						return envelope('alertTriggerActions', {
							__typename: 'ActionsTriggered',
							actions: [
								{
									actionId: 'runtime/status-action',
									success: [{ id: ALERT_ID }],
									skip: [],
									failure: [],
								},
								{
									actionId: 'runtime/verdict-action',
									success: [{ id: ALERT_ID }],
									skip: [],
									failure: [],
								},
							],
						});
					default:
						throw new Error(`unexpected operation ${operationName(options)}`);
				}
			},
		),
		2,
	);

	const discovery = requests.find(
		(request) => operationName(request) === 'SentinelOneAvailableAlertActions',
	);
	const mutation = requests.find((request) => operationName(request) === 'SentinelOneUpdateAlert');
	const exactFilter = {
		or: [{ and: [{ fieldId: 'id', stringIn: { values: [ALERT_ID] } }] }],
	};
	assert.deepEqual(discovery.body.variables.filter, exactFilter);
	assert.deepEqual(mutation.body.variables.filter, exactFilter);
	assert.deepEqual(mutation.body.variables.actions, [
		{
			id: 'runtime/verdict-action',
			payload: { analystVerdict: { value: 'TRUE_POSITIVE_MALWARE' } },
		},
		{ id: 'runtime/status-action', payload: { status: { value: 'RESOLVED' } } },
	]);
	assert.equal(result[0].outcome, 'complete');
	assert.equal(result[0].verification.status.verified, true);
	assert.equal(result[0].verification.analystVerdict.verified, true);
});

test('Update serializes ticket metadata objects and arrays, preserving existing strings', async () => {
	for (const input of [
		{ externalTicketId: '42', nested: { active: true } },
		[{ id: '42' }],
		' { "id": "42" } ',
	]) {
		const expected = typeof input === 'string' ? input : JSON.stringify(input);
		let sent;
		const result = await updateUnifiedAlert(
			context(
				{
					alertId: ALERT_ID,
					updateFields: { ticketId: input },
					useAdvancedUpdatePayload: false,
					advancedUpdatePayload: 'invalid hidden JSON',
				},
				async (_credential, options) => {
					if (operationName(options) === 'SentinelOneVerifyUpdate')
						return envelope('alert', alert({ ticketId: sent ?? null }));
					if (operationName(options) === 'SentinelOneAvailableAlertActions')
						return envelope('alertAvailableActions', {
							data: [
								{
									id: 'ticket',
									title: 'Ticket',
									isDisabled: false,
									types: ['SET_TICKET_ID'],
									triggeredAfter: [],
									triggersActions: [],
								},
							],
							errors: [],
						});
					assert.equal(operationName(options), 'SentinelOneUpdateAlert');
					assert.equal(options.body.variables.scope, undefined);
					sent = options.body.variables.actions[0].payload.ticketId.value;
					return envelope('alertTriggerActions', {
						__typename: 'ActionsTriggered',
						actions: [{ actionId: 'ticket', success: [{ id: ALERT_ID }], skip: [], failure: [] }],
					});
				},
			),
			0,
		);
		assert.equal(sent, expected);
		assert.equal(result[0].verification.ticketId.verified, true);
	}
});

test('Update rejects ambiguous enabled runtime actions with the same ActionType', async () => {
	let mutationCalls = 0;
	await assert.rejects(
		updateUnifiedAlert(
			context(
				baseParameters({ updateFields: { status: 'RESOLVED' }, advancedUpdatePayload: '{}' }),
				async (_credential, options) => {
					if (operationName(options) === 'SentinelOneVerifyUpdate')
						return envelope('alert', alert());
					if (operationName(options) === 'SentinelOneUpdateAlert') mutationCalls++;
					return envelope('alertAvailableActions', {
						data: ['one', 'two'].map((id) => ({
							id: `runtime/${id}`,
							title: id,
							isDisabled: false,
							types: ['STATUS_UPDATE'],
							triggeredAfter: [],
							triggersActions: [],
						})),
						errors: [],
					});
				},
			),
			0,
		),
		/more than one enabled status action/i,
	);
	assert.equal(mutationCalls, 0);
});

test('Update rejects unknown, duplicate, and clearing advanced fields before mutation', async (t) => {
	for (const [name, guided, advanced, expected] of [
		['unknown', {}, '{"assignee":"somebody"}', /Unknown alert update field/i],
		['duplicate key', {}, '{"status":"NEW","status":"RESOLVED"}', /duplicate key/i],
		['guided collision', { status: 'NEW' }, '{"status":"RESOLVED"}', /duplicated/i],
		['ticket clear', {}, '{"ticketId":""}', /cannot be empty or cleared/i],
	]) {
		await t.test(name, async () => {
			let mutationCalls = 0;
			await assert.rejects(
				updateUnifiedAlert(
					context(
						baseParameters({ updateFields: guided, advancedUpdatePayload: advanced }),
						async (_credential, options) => {
							if (operationName(options) === 'SentinelOneUpdateAlert') mutationCalls++;
							return envelope('alert', alert());
						},
					),
					0,
				),
				expected,
			);
			assert.equal(mutationCalls, 0);
		});
	}
});

test('Update never retries a mutation whose response is lost', async () => {
	let mutationCalls = 0;
	const result = await updateUnifiedAlert(
		context(
			baseParameters({ updateFields: { ticketId: 'CASE-7' }, advancedUpdatePayload: '{}' }),
			async (_credential, options) => {
				switch (operationName(options)) {
					case 'SentinelOneVerifyUpdate':
						return envelope('alert', alert({ ticketId: 'CASE-7' }));
					case 'SentinelOneAvailableAlertActions':
						return envelope('alertAvailableActions', {
							data: [
								{
									id: 'S1/alert/setTicketId',
									title: 'Set ticket ID',
									isDisabled: false,
									types: ['SET_TICKET_ID'],
									triggeredAfter: [],
									triggersActions: [],
								},
							],
							errors: [],
						});
					case 'SentinelOneUpdateAlert':
						mutationCalls++;
						throw Object.assign(new Error('socket reset with sensitive body'), {
							code: 'ECONNRESET',
						});
					default:
						throw new Error('unexpected request');
				}
			},
		),
		0,
	);
	assert.equal(result[0].mayHaveCommitted, true);
	assert.equal(result[0].outcome, 'unknown');
	assert.equal(result[0].verificationStatus, 'verified');
	assert.equal(mutationCalls, 1);
});

test('Alert Note Get Many accepts author unions, null authors, and explicit empty lists', async (t) => {
	await t.test('author unions and limit', async () => {
		const notes = [
			note('note-1', 'one', 'PLAIN_TEXT', {
				__typename: 'UserNoteAuthor',
				userId: '1234567890123456789',
				email: 'analyst@example.test',
				fullName: 'Analyst',
			}),
			note('note-2', 'two', 'MARKDOWN', {
				__typename: 'RuleNoteAuthor',
				id: 'rule-1',
				name: 'Automation',
				version: 2,
			}),
			note('note-3'),
		];
		const result = await getManyAlertNotes(
			context(baseParameters({ returnAll: false, limit: 2 }), async (_credential, options) => {
				if (operationName(options) === 'SentinelOneGetAlert') return envelope('alert', alert());
				return envelope('alertNotes', { data: notes });
			}),
			0,
		);
		assert.equal(result.length, 2);
		assert.equal(result[0].createdBy.userId, '1234567890123456789');
		assert.equal(result[1].createdBy.__typename, 'RuleNoteAuthor');
	});

	await t.test('explicit empty list', async () => {
		const result = await getManyAlertNotes(
			context(baseParameters({ returnAll: true }), async (_credential, options) => {
				if (operationName(options) === 'SentinelOneGetAlert') return envelope('alert', alert());
				return envelope('alertNotes', { data: [] });
			}),
			0,
		);
		assert.deepEqual(result, []);
	});

	await t.test('unknown author type', async () => {
		await assert.rejects(
			getManyAlertNotes(
				context(baseParameters({ returnAll: true }), async (_credential, options) => {
					if (operationName(options) === 'SentinelOneGetAlert') return envelope('alert', alert());
					return envelope('alertNotes', {
						data: [note('note-1', 'text', 'PLAIN_TEXT', { __typename: 'NewAuthorType' })],
					});
				}),
				0,
			),
			/unsupported note author type/i,
		);
	});
});

test('Create Note passes Markdown unchanged, omits plainText, and infers only one matching new ID', async () => {
	const markdown = 'Evidence: ![screen](https://example.test/image.png)';
	let mutationVariables;
	const before = note('note-before');
	const created = note('note-created', markdown, 'MARKDOWN');
	const result = await createAlertNote(
		context(
			baseParameters({ text: markdown, contentType: 'MARKDOWN' }),
			async (_credential, options) => {
				switch (operationName(options)) {
					case 'SentinelOneGetAlert':
						return envelope('alert', alert());
					case 'SentinelOneGetAlertNotes':
						return envelope('alertNotes', { data: [before] });
					case 'SentinelOneCreateAlertNote':
						mutationVariables = options.body.variables;
						return envelope('addAlertNote', { data: [before, created] });
					default:
						throw new Error('unexpected request');
				}
			},
		),
		0,
	);

	assert.deepEqual(mutationVariables, { alertId: ALERT_ID, text: markdown, type: 'MARKDOWN' });
	assert.equal(Object.hasOwn(mutationVariables, 'plainText'), false);
	assert.equal(result[0].mutationAcknowledged, true);
	assert.equal(result[0].identification.status, 'inferred');
	assert.equal(result[0].identification.note.id, 'note-created');
});

test('Create Note reports ambiguous acknowledgement for concurrent matching notes', async () => {
	const text = 'same text';
	const before = note('before');
	const result = await createAlertNote(
		context(baseParameters({ text, contentType: 'PLAIN_TEXT' }), async (_credential, options) => {
			if (operationName(options) === 'SentinelOneGetAlert') return envelope('alert', alert());
			if (operationName(options) === 'SentinelOneGetAlertNotes') {
				return envelope('alertNotes', { data: [before] });
			}
			return envelope('addAlertNote', {
				data: [before, note('candidate-1', text), note('candidate-2', text)],
			});
		}),
		0,
	);

	assert.equal(result[0].outcome, 'acknowledged');
	assert.equal(result[0].identification.status, 'ambiguous');
	assert.equal(result[0].identification.reason, 'multiple_new_candidates');
	assert.equal(result[0].identification.candidates.length, 2);
});

test('Create Note sends its mutation once when the response is lost', async () => {
	let creates = 0;
	await assert.rejects(
		createAlertNote(
			context(
				baseParameters({ text: 'write once', contentType: 'PLAIN_TEXT' }),
				async (_credential, options) => {
					if (operationName(options) === 'SentinelOneGetAlert') return envelope('alert', alert());
					if (operationName(options) === 'SentinelOneGetAlertNotes')
						return envelope('alertNotes', { data: [] });
					creates++;
					throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
				},
			),
			0,
		),
		(error) => {
			assert.equal(error.mayHaveCommitted, true);
			assert.equal(error.outcome, 'unknown');
			return true;
		},
	);
	assert.equal(creates, 1);
});

test('Create Note reports HTTP permission rejection without mutation uncertainty', async () => {
	for (const statusCode of [401, 403]) {
		let mutations = 0;
		await assert.rejects(
			createAlertNote(
				context(
					baseParameters({ text: 'Example note', contentType: 'PLAIN_TEXT' }),
					async (_credential, request) => {
						if (operationName(request) === 'SentinelOneGetAlertNotes')
							return envelope('alertNotes', { data: [] });
						mutations++;
						throw { statusCode };
					},
				),
				0,
			),
			(error) => {
				assert.equal(error.outcome, 'rejected');
				assert.equal(error.mayHaveCommitted, false);
				assert.doesNotMatch(error.description || '', /may have committed/i);
				return true;
			},
		);
		assert.equal(mutations, 1);
	}
});

test('Create Note marks every HTTP-200 GraphQL mutation error unknown without echoing values', async (t) => {
	const noteText = 'quoted "note" and ticket CASE-991';
	for (const includeData of [false, true]) {
		await t.test(includeData ? 'errors with data' : 'errors without data', async () => {
			let creates = 0;
			await assert.rejects(
				createAlertNote(
					context(
						baseParameters({ text: noteText, contentType: 'PLAIN_TEXT' }),
						async (_credential, options) => {
							if (operationName(options) === 'SentinelOneGetAlert')
								return envelope('alert', alert());
							if (operationName(options) === 'SentinelOneGetAlertNotes') {
								return envelope('alertNotes', { data: [] });
							}
							creates++;
							return {
								...(includeData ? { data: { addAlertNote: { data: [] } } } : {}),
								errors: [
									{
										message: `Rejected value ${JSON.stringify(noteText)}`,
										extensions: { code: 'BAD_USER_INPUT', unsafe: noteText },
									},
								],
							};
						},
					),
					0,
				),
				(error) => {
					assert.equal(error.mayHaveCommitted, true);
					assert.equal(error.outcome, 'unknown');
					assert.match(error.message, /GraphQL operation failed/);
					assert.doesNotMatch(error.message, /quoted|CASE-991|Rejected value/);
					return true;
				},
			);
			assert.equal(creates, 1);
		});
	}
});
