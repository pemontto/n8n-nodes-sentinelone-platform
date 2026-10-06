import { isRetryableReadError, responseStatus, retryAfterMs, sleep } from './retry';

export interface RequestPolicy {
	mutation?: boolean;
	attempts?: number;
	timeoutMs?: number;
	/** Absolute epoch time the caller must finish by, such as the n8n poll budget. No attempt starts, no attempt outlives it, and no backoff wait runs past it. */
	deadline?: number;
	onFailure?: (error: unknown, attempt: number, durationMs: number) => void;
}

export type RequestResult = { ok: true; value: unknown } | { ok: false; error: unknown };

/** The caller deadline stopped a request that would otherwise have run or been retried. Permission and other permanent failures are never reported this way. */
export class PollBudgetError extends Error {
	readonly retryable = false;
	/** HTTP status of the transient failure whose retry no longer fitted, when there was one. Named so status sniffing on error chains does not mistake this error for that failure. */
	readonly blockedStatus: number | null;

	constructor(cause?: unknown) {
		const status = responseStatus(cause);
		super(
			`The n8n poll time budget ran out${status ? ` (HTTP ${status} could not be retried in time)` : ''}.`,
		);
		this.blockedStatus = status;
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

	// A transient failure that the caller deadline keeps from being retried is a budget stop; everything else is the failure itself.
	const stop = (error: unknown, at: number): RequestResult =>
		policy.deadline !== undefined && at >= policy.deadline && isRetryableReadError(error)
			? { ok: false, error: new PollBudgetError(error) }
			: { ok: false, error };

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

			const delay = Math.max(retryAfterMs(error), attempt * 1000 + Math.floor(Math.random() * 100));

			if (attempt >= attempts || !isRetryableReadError(error)) {
				// A caller that owns further retries must not sleep out a Retry-After that ends past the deadline.
				return stop(error, Date.now() + retryAfterMs(error));
			}

			if (Date.now() + delay >= deadline) {
				return stop(error, Date.now() + delay);
			}

			await sleep(delay);

			if (Date.now() >= deadline) {
				return stop(error, Date.now());
			}
		}
	}
}
