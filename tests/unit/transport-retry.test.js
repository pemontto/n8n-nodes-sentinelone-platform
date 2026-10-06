const assert = require('node:assert/strict');
const test = require('node:test');
const { NodeApiError } = require('n8n-workflow');
const {
	isRetryableReadError,
	responseStatus,
	retryAfterMs,
} = require('../../dist/nodes/shared/transport/retry.js');
const { requestWithRetry } = require('../../dist/nodes/shared/transport/request.js');

const node = { name: 'Demo', type: 'sentinelOnePlatform', typeVersion: 1, position: [0, 0] };

function axiosError(message, extra) {
	return Object.assign(new Error(message), { isAxiosError: true }, extra);
}

test('A wrapped rate limit exposes its status and Retry-After through the cause chain', () => {
	const error = new NodeApiError(
		node,
		axiosError('Request failed with status code 429', {
			code: 'ERR_BAD_REQUEST',
			response: { status: 429, headers: { 'retry-after': '30' }, data: {} },
		}),
	);
	assert.equal(responseStatus(error), 429);
	assert.equal(retryAfterMs(error), 30000);
	assert.equal(isRetryableReadError(error), true);
});

test('A wrapped ECONNRESET stays retryable after the message is rewritten', () => {
	const error = new NodeApiError(node, axiosError('socket hang up', { code: 'ECONNRESET' }));
	assert.equal(responseStatus(error), null);
	assert.equal(retryAfterMs(error), 0);
	assert.equal(isRetryableReadError(error), true);
});

test('A wrapped permission failure is not retried', () => {
	const error = new NodeApiError(
		node,
		axiosError('Request failed with status code 403', {
			code: 'ERR_BAD_REQUEST',
			response: { status: 403, headers: {}, data: {} },
		}),
	);
	assert.equal(responseStatus(error), 403);
	assert.equal(isRetryableReadError(error), false);
});

test('A timed-out attempt leaves budget for a retry', async () => {
	const timeouts = [];
	const result = await requestWithRetry(
		async (timeoutMs, attempt) => {
			timeouts.push(timeoutMs);
			if (attempt < 2) throw { retryable: true, retryAfterMs: 1 };
			return 'ok';
		},
		{ timeoutMs: 30_000 },
	);
	assert.deepEqual(result, { ok: true, value: 'ok' });
	assert.equal(timeouts.length, 2);
	assert.equal(timeouts[0], 15_000, 'the per-attempt share is floored at 15 seconds');
	assert.ok(timeouts[0] < 30_000, 'first attempt must not consume the whole deadline');
	assert.ok(timeouts[0] + timeouts[1] <= 30_000);
});

test('A non-Error payload on errorResponse stays reachable through the chain', () => {
	const error = new NodeApiError(node, {
		message: 'Request failed',
		response: { status: 503, headers: { 'retry-after': '5' }, data: {} },
	});
	assert.equal(responseStatus(error), 503);
	assert.equal(retryAfterMs(error), 5000);
	assert.equal(isRetryableReadError(error), true);
});

test('A blank Retry-After does not hide an inner frame value', () => {
	const error = {
		headers: { 'retry-after': '  ' },
		cause: { headers: { 'retry-after': '7' } },
	};
	assert.equal(retryAfterMs(error), 7000);
});

const { PollBudgetError } = require('../../dist/nodes/shared/transport/request.js');

async function clocked(run) {
	const realNow = Date.now;
	let now = 10_000;
	Date.now = () => now;
	try {
		return await run((elapsed) => {
			now += elapsed;
		});
	} finally {
		Date.now = realNow;
	}
}

test('HTTP failures preserve identity when Retry-After does not fit the deadline', async () => {
	await clocked(async () => {
		for (const statusCode of [401, 403, 404, 429, 500, 503]) {
			const error = { statusCode, headers: { 'retry-after': '10' } };
			const result = await requestWithRetry(
				async () => {
					throw error;
				},
				{ deadline: Date.now() + 100, attempts: 3 },
			);
			assert.equal(result.error, error);
			assert.equal(responseStatus(result.error), statusCode);
			assert.equal(retryAfterMs(result.error), 10_000);
		}
	});
});

test('only a request timeout caused by the caller deadline becomes a poll stop', async () => {
	await clocked(async (advance) => {
		const result = await requestWithRetry(
			async (timeoutMs) => {
				advance(timeoutMs);
				throw Object.assign(new Error(`timeout of ${timeoutMs}ms exceeded`), {
					code: 'ECONNABORTED',
				});
			},
			{ deadline: Date.now() + 100, timeoutMs: 30_000 },
		);
		assert.ok(result.error instanceof PollBudgetError);
	});
	await clocked(async (advance) => {
		const failure = Object.assign(new Error('timeout of 50ms exceeded'), { code: 'ETIMEDOUT' });
		const result = await requestWithRetry(
			async () => {
				advance(50);
				throw failure;
			},
			{ deadline: Date.now() + 100, timeoutMs: 50 },
		);
		assert.equal(result.error, failure);
	});
});
