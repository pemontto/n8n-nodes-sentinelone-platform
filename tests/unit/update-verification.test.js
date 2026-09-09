const test = require('node:test');
const {
	updateUnifiedAlert,
} = require('../../dist/nodes/SentinelOnePlatform/actions/alert/update.operation');

function updateContext(handler, options = {}, retryOnFail = false) {
	const parameters = { alertId: 'alert-demo', updateFields: { status: 'RESOLVED' }, options };
	return {
		getNode: () => ({
			name: 'Demo',
			type: 'sentinelOnePlatform',
			typeVersion: 1,
			parameters,
			retryOnFail,
		}),
		getCredentials: async () => ({ baseUrl: 'https://tenant.example', apiToken: 'secret' }),
		getNodeParameter: (name, index, fallback) => parameters[name] ?? fallback,
		helpers: {
			httpRequestWithAuthentication: async (_credential, request) => handler(request.body),
		},
	};
}
test('Malformed verification options fail before any discovery or mutation', async () => {
	let calls = 0;
	await assert.rejects(
		updateUnifiedAlert(
			updateContext(
				() => {
					calls++;
				},
				{ verifyUpdate: 'false' },
			),
			0,
		),
		/Verify Update must/,
	);
	assert.equal(calls, 0);
});
test('Disabled and rejected messages redact reflected ticket metadata', async () => {
	const secret = 'private-ticket-metadata';
	for (const disabled of [true, false]) {
		const context = updateContext((body) => {
			if (body.query.includes('SentinelOneAvailableAlertActions')) {
				const response = discovery(disabled);
				Object.assign(response.data.alertAvailableActions.data[0], {
					id: 'ticket',
					types: ['SET_TICKET_ID'],
					disabledReason: `Cannot set ${secret}`,
				});
				return response;
			}
			return {
				data: {
					alertTriggerActions: {
						__typename: 'TriggerActionsError',
						errors: [{ errorMessage: `Cannot set ${secret}` }],
					},
				},
			};
		});
		context.getNode().parameters.updateFields = { ticketId: secret };
		if (disabled)
			await assert.rejects(updateUnifiedAlert(context, 0), (error) => {
				assert.doesNotMatch(error.message, /private-ticket-metadata/);
				assert.match(error.message, /disabled/);
				return true;
			});
		else {
			const [result] = await updateUnifiedAlert(context, 0);
			assert.equal(result.outcome, 'rejected');
			assert.doesNotMatch(JSON.stringify(result.errors), /private-ticket-metadata/);
		}
	}
});
function discovery(disabled = false) {
	return {
		data: {
			alertAvailableActions: {
				data: [
					{
						id: 'status',
						isDisabled: disabled,
						disabledReason: 'Current role does not have permissions for this action',
						types: ['STATUS_UPDATE'],
						triggeredAfter: [],
						triggersActions: [],
					},
				],
				errors: [],
			},
		},
	};
}
function accepted() {
	return {
		data: {
			alertTriggerActions: {
				__typename: 'ActionsTriggered',
				actions: [{ actionId: 'status', success: [{ id: 'alert-demo' }], skip: [], failure: [] }],
			},
		},
	};
}
test('Accepted mutation survives a forbidden verification read', async () => {
	const calls = [];
	const [result] = await updateUnifiedAlert(
		updateContext((body) => {
			calls.push(body.query);
			if (body.query.includes('SentinelOneAvailableAlertActions')) return discovery();
			if (body.query.includes('SentinelOneUpdateAlert')) return accepted();
			throw { statusCode: 403 };
		}),
		0,
	);
	assert.equal(calls.length, 3);
	assert.equal(result.outcome, 'complete');
	assert.equal(result.mutationAcknowledged, true);
	assert.equal(result.verificationStatus, 'unavailable');
	assert.equal(result.verification.status.verified, null);
});
test('Disabling verification performs discovery and mutation only', async () => {
	let calls = 0;
	const [result] = await updateUnifiedAlert(
		updateContext(
			(body) => {
				calls++;
				return body.query.includes('SentinelOneAvailableAlertActions') ? discovery() : accepted();
			},
			{ verifyUpdate: false },
		),
		0,
	);
	assert.equal(calls, 2);
	assert.equal(result.verificationStatus, 'skipped');
});
test('Explicit rejection skips readback and reports rejection', async () => {
	let calls = 0;
	const [result] = await updateUnifiedAlert(
		updateContext((body) => {
			calls++;
			return body.query.includes('SentinelOneAvailableAlertActions')
				? discovery()
				: {
						data: {
							alertTriggerActions: {
								__typename: 'TriggerActionsError',
								errors: [{ errorMessage: 'Action rejected' }],
							},
						},
					};
		}),
		0,
	);
	assert.equal(calls, 2);
	assert.equal(result.outcome, 'rejected');
	assert.equal(result.verificationStatus, 'skipped');
});
test('Disabled actions expose the supplied permission explanation', async () => {
	await assert.rejects(
		updateUnifiedAlert(
			updateContext(() => discovery(true)),
			0,
		),
		/Current role does not have permissions/,
	);
});
test('Whole-node write retries are rejected before requests', async () => {
	let calls = 0;
	await assert.rejects(
		updateUnifiedAlert(
			updateContext(
				() => {
					calls++;
				},
				{},
				true,
			),
			0,
		),
		/Turn off Retry On Fail/,
	);
	assert.equal(calls, 0);
});
const assert = require('node:assert/strict');
const {
	verifyUpdate,
	valuesEqual,
} = require('../../dist/nodes/SentinelOnePlatform/actions/alert/update/verification');

function clock() {
	let time = 0;
	const delays = [];
	return {
		now: () => time,
		random: () => 0,
		sleep: async (ms) => {
			delays.push(ms);
			time += ms;
		},
		delays,
	};
}
test('Ticket comparison ignores object order but preserves types, arrays and text', () => {
	assert.equal(valuesEqual('ticketId', '{"a":1,"b":[2]}', '{"b":[2],"a":1}'), true);
	assert.equal(valuesEqual('ticketId', '{"a":1}', '{"a":"1"}'), false);
	assert.equal(valuesEqual('ticketId', '[1,2]', '[2,1]'), false);
	assert.equal(valuesEqual('ticketId', 'CASE-1', 'CASE-1'), true);
	assert.equal(valuesEqual('ticketId', 'CASE-1', ' CASE-1'), false);
});
test('Stale values and transport errors share three reads with backoff', async () => {
	const time = clock();
	let calls = 0;
	const result = await verifyUpdate(
		{ status: 'RESOLVED' },
		async (timeout) => {
			assert.ok(timeout <= 30000);
			calls++;
			if (calls === 1) throw { retryable: true, retryAfterMs: 1500 };
			return { status: calls === 2 ? 'NEW' : 'RESOLVED' };
		},
		time,
	);
	assert.equal(calls, 3);
	assert.deepEqual(time.delays, [1500, 2000]);
	assert.equal(result.verificationStatus, 'verified');
});
test('Retry-After beyond the deadline stops without sleeping or retrying', async () => {
	const time = clock();
	let calls = 0;
	const result = await verifyUpdate(
		{ status: 'NEW' },
		async () => {
			calls++;
			throw { retryable: true, retryAfterMs: 31000 };
		},
		time,
	);
	assert.equal(calls, 1);
	assert.deepEqual(time.delays, []);
	assert.equal(result.verificationStatus, 'unavailable');
	assert.equal(result.verification.status.verified, null);
});
test('Non-retryable read failures remain unavailable and are not retried', async () => {
	let calls = 0;
	const result = await verifyUpdate(
		{ ticketId: 'CASE-1' },
		async () => {
			calls++;
			throw { retryable: false };
		},
		clock(),
	);
	assert.equal(calls, 1);
	assert.equal(result.verificationStatus, 'unavailable');
});
test('Three successful stale reads report mismatch', async () => {
	const result = await verifyUpdate(
		{ status: 'RESOLVED' },
		async () => ({ status: 'NEW' }),
		clock(),
	);
	assert.equal(result.verificationAttempts, 3);
	assert.equal(result.verificationStatus, 'mismatch');
	assert.equal(result.verification.status.observed, 'NEW');
});

test('Missing changed fields are unavailable rather than mismatched', async () => {
	let reads = 0;
	const result = await verifyUpdate(
		{ status: 'RESOLVED' },
		async () => {
			reads++;
			return { id: 'alert-demo' };
		},
		clock(),
	);
	assert.equal(reads, 1);
	assert.equal(result.verificationStatus, 'unavailable');
	assert.equal(result.verification.status.verified, null);
});

test('An explicitly null ticket value is a known mismatch', async () => {
	const result = await verifyUpdate(
		{ ticketId: 'expected' },
		async () => ({ id: 'alert-demo', ticketId: null }),
		clock(),
	);
	assert.equal(result.verificationStatus, 'mismatch');
	assert.equal(result.verification.ticketId.verified, false);
});

test('Authentication and GraphQL validation rejections skip verification', async () => {
	for (const rejection of [401, 403, 'GRAPHQL_VALIDATION_FAILED']) {
		let calls = 0;
		const result = await updateUnifiedAlert(
			updateContext((body) => {
				calls++;
				if (body.query.includes('SentinelOneAvailableAlertActions')) return discovery();
				if (typeof rejection === 'number') throw { statusCode: rejection };
				return { errors: [{ message: 'Not echoed', extensions: { code: rejection } }] };
			}),
			0,
		);
		assert.equal(calls, 2);
		assert.equal(result[0].outcome, 'rejected');
		assert.equal(result[0].verificationStatus, 'skipped');
	}
});

test('Invalid update values and keys are never echoed into errors', async () => {
	const secret = 'SYNTHETIC_PRIVATE_PAYLOAD';
	for (const fields of [{ status: secret }, { analystVerdict: secret }, { [secret]: 'value' }]) {
		const ctx = updateContext(() => {
			throw new Error('No request expected');
		});
		ctx.getNode().parameters.updateFields = fields;
		await assert.rejects(updateUnifiedAlert(ctx, 0), (error) => {
			assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE_PAYLOAD/);
			return true;
		});
	}
});

test('Service explanations redact scalar members of JSON metadata', () => {
	const { sanitizeReason } = require('../../dist/nodes/shared/Errors.js');
	const result = sanitizeReason('Ticket reference SECRET_MEMBER is not allowed', [
		JSON.stringify({ externalTicketId: 'SECRET_MEMBER' }),
	]);
	assert.doesNotMatch(result, /SECRET_MEMBER/);
	assert.doesNotMatch(
		sanitizeReason('Rejected 9007199254740993', ['{"externalTicketId":9007199254740993}']),
		/9007199254740993/,
	);
});

test('Ticket verification preserves numeric precision and number/string distinctions', () => {
	assert.equal(
		valuesEqual('ticketId', '{"id":9007199254740992}', '{"id":9007199254740993}'),
		false,
	);
	assert.equal(
		valuesEqual('ticketId', '{"id":9007199254740993}', '{"id":"9007199254740993"}'),
		false,
	);
	assert.equal(valuesEqual('ticketId', '{"x":1.0000000000000001}', '{"x":1}'), false);
	assert.equal(valuesEqual('ticketId', '{"x":1e3,"y":-0}', '{"y":0,"x":1000.0}'), true);
});
