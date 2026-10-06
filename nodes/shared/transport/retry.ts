import { sleep } from 'n8n-workflow';

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export { sleep };

const MAX_CAUSE_DEPTH = 5;

const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];

const NETWORK_CODES = /^(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNABORTED)$/;

/** NodeApiError keeps the transport error under `cause`, or under `errorResponse` when the payload is not an Error, and rewrites message and httpCode, so status, headers and network codes are only reachable through the chain. */
function causeChain(error: unknown): Record<string, unknown>[] {
	const frames: Record<string, unknown>[] = [];
	const seen = new Set<unknown>();
	let current = error;

	for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
		if (!isRecord(current) || seen.has(current)) break;
		seen.add(current);
		frames.push(current);
		current = current.cause ?? current.errorResponse;
	}

	return frames;
}

function frameStatus(frame: Record<string, unknown>): number | null {
	const response = isRecord(frame.response) ? frame.response : undefined;

	const value =
		frame.statusCode ?? frame.httpCode ?? frame.status ?? response?.statusCode ?? response?.status;

	const status = Number(value);

	return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

export function responseStatus(error: unknown): number | null {
	for (const frame of causeChain(error)) {
		const status = frameStatus(frame);

		if (status !== null) return status;
	}

	return null;
}

export function isRetryableReadError(error: unknown): boolean {
	const frames = causeChain(error);

	for (const frame of frames) {
		if (typeof frame.retryable === 'boolean') return frame.retryable;
	}

	const status = responseStatus(error);

	if (status !== null) return RETRYABLE_STATUSES.includes(status);

	for (const frame of frames) {
		if (typeof frame.code === 'string' && NETWORK_CODES.test(frame.code)) return true;

		if (
			frame instanceof Error &&
			/ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(frame.message)
		)
			return true;
	}

	return false;
}

export function retryAfterMs(error: unknown, now = Date.now()): number {
	for (const frame of causeChain(error)) {
		if (typeof frame.retryAfterMs === 'number') return Math.max(0, frame.retryAfterMs);
		const response = isRecord(frame.response) ? frame.response : {};

		const headers = isRecord(frame.headers)
			? frame.headers
			: isRecord(response.headers)
				? response.headers
				: {};

		const value = headers['retry-after'] ?? headers['Retry-After'];

		if (typeof value !== 'string' && typeof value !== 'number') continue;

		// A blank header carries no delay; keep walking so an inner frame's value is still reached.
		if (String(value).trim() === '') continue;
		const seconds = Number(value);

		if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
		const date = Date.parse(String(value));

		if (Number.isFinite(date)) return Math.max(0, date - now);
	}

	return 0;
}
