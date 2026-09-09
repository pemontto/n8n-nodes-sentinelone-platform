import { isRetryableReadError, retryAfterMs, sleep } from './retry';

export interface RequestPolicy {
	mutation?: boolean;
	attempts?: number;
	timeoutMs?: number;
	onFailure?: (error: unknown, attempt: number, durationMs: number) => void;
}

export type RequestResult = { ok: true; value: unknown } | { ok: false; error: unknown };

export async function requestWithRetry(
	send: (timeoutMs: number, attempt: number) => Promise<unknown>,
	policy: RequestPolicy = {},
): Promise<RequestResult> {
	const attempts = policy.mutation ? 1 : Math.min(3, Math.max(1, policy.attempts ?? 3));
	const deadline = Date.now() + Math.max(1, Math.min(30_000, policy.timeoutMs ?? 30_000));
	for (let attempt = 1; ; attempt++) {
		const startedAt = Date.now();
		try {
			return { ok: true, value: await send(Math.max(1, deadline - Date.now()), attempt) };
		} catch (error) {
			try {
				policy.onFailure?.(error, attempt, Date.now() - startedAt);
			} catch {
				/* Diagnostics never change transport outcomes. */
			}
			const delay = Math.max(retryAfterMs(error), attempt * 1000 + Math.floor(Math.random() * 100));
			if (attempt >= attempts || !isRetryableReadError(error) || Date.now() + delay >= deadline) {
				return { ok: false, error };
			}
			await sleep(delay);
			if (Date.now() >= deadline) {
				return { ok: false, error };
			}
		}
	}
}
