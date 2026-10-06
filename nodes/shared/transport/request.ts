import { isRetryableReadError, responseStatus, retryAfterMs, sleep } from './retry';

export interface RequestPolicy {
	mutation?: boolean;
	attempts?: number;
	timeoutMs?: number;
	/** Absolute epoch time the caller must finish by, such as the n8n poll budget. No attempt starts, no attempt outlives it, and no backoff wait runs past it. */
	deadline?: number;
	onFailure?: (error: unknown, attempt: number, durationMs: number) => void;
}

export type RequestResult =
	| { ok: true; value: unknown }
	| { ok: false; error: unknown; retryDelayMs?: number };

/** Only the caller's deadline, rather than a service failure, stopped the request. */
export class PollBudgetError extends Error {
	readonly retryable = false;

	constructor() {
		super('The n8n poll time budget ran out.');
	}
}

export async function requestWithRetry(
	send: (timeoutMs: number, attempt: number) => Promise<unknown>,
	policy: RequestPolicy = {},
): Promise<RequestResult> {
	const attempts = policy.mutation ? 1 : Math.min(3, Math.max(1, policy.attempts ?? 3));

	const deadline = Math.min(
		Date.now() + Math.max(1, Math.min(30_000, policy.timeoutMs ?? 30_000)),
		policy.deadline ?? Infinity,
	);

	if (policy.deadline !== undefined && Date.now() >= policy.deadline)
		return { ok: false, error: new PollBudgetError() };

	for (let attempt = 1; ; attempt++) {
		const startedAt = Date.now();
		// Share the remaining deadline across the attempts still allowed, with a floor so a slow read is not cut short, and a timed-out attempt still leaves room to retry.
		const remainingMs = Math.max(1, deadline - Date.now());

		const attemptTimeoutMs = Math.min(
			remainingMs,
			Math.max(15_000, Math.floor(remainingMs / Math.max(1, attempts - attempt + 1))),
		);

		try {
			return { ok: true, value: await send(attemptTimeoutMs, attempt) };
		} catch (error) {
			try {
				policy.onFailure?.(error, attempt, Date.now() - startedAt);
			} catch {
				/* Diagnostics never change transport outcomes. */
			}

			// A status-free failure at an attempt capped to the caller deadline is our stop, even when n8n has rewritten the transport message.
			if (
				policy.deadline !== undefined &&
				deadline === policy.deadline &&
				startedAt + attemptTimeoutMs >= policy.deadline &&
				Date.now() >= policy.deadline &&
				responseStatus(error) === null
			)
				return { ok: false, error: new PollBudgetError() };

			const delay = Math.max(retryAfterMs(error), attempt * 1000 + Math.floor(Math.random() * 100));

			if (attempt >= attempts || !isRetryableReadError(error)) {
				return { ok: false, error };
			}

			if (Date.now() + delay >= deadline) {
				return { ok: false, error, retryDelayMs: delay };
			}

			await sleep(delay);

			if (Date.now() >= deadline) {
				return { ok: false, error };
			}
		}
	}
}
