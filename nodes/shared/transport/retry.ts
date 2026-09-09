import { sleep } from 'n8n-workflow';
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export { sleep };

export function responseStatus(error: unknown): number | null {
	if (!isRecord(error)) return null;
	const response = isRecord(error.response) ? error.response : undefined;
	const value =
		error.statusCode ?? error.httpCode ?? error.status ?? response?.statusCode ?? response?.status;
	const status = Number(value);
	return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

export function isRetryableReadError(error: unknown): boolean {
	if (isRecord(error) && typeof error.retryable === 'boolean') return error.retryable;
	const status = responseStatus(error);
	if (status !== null) return [429, 500, 502, 503, 504].includes(status);
	if (
		isRecord(error) &&
		typeof error.code === 'string' &&
		/^(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNABORTED)$/.test(error.code)
	)
		return true;
	return (
		error instanceof Error &&
		/ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(error.message)
	);
}

export function retryAfterMs(error: unknown, now = Date.now()): number {
	if (!isRecord(error)) return 0;
	if (typeof error.retryAfterMs === 'number') return Math.max(0, error.retryAfterMs);
	const response = isRecord(error.response) ? error.response : {};
	const headers = isRecord(error.headers)
		? error.headers
		: isRecord(response.headers)
			? response.headers
			: {};
	const value = headers['retry-after'] ?? headers['Retry-After'];
	if (typeof value !== 'string' && typeof value !== 'number') return 0;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(String(value));
	return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}
