import {
	sleep as workflowSleep,
	type IDataObject,
	type IExecuteFunctions,
	type IHttpRequestOptions,
} from 'n8n-workflow';
import { asRecord, safeError, requireString, jsonBytes } from '../actions/sdlQuery/common';

const CREDENTIAL_TYPE = 'sentinelOnePlatformApi';
export const FORWARD_HEADER = 'x-dataset-query-forward-tag';
const MAX_FORWARD_HEADER_LENGTH = 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 1_000;

export type CleanupStatus = 'request_accepted' | 'failed' | 'timed_out';

export interface FullResponse {
	body: unknown;
	headers: IDataObject;
	statusCode: number;
}

interface LifecycleAbort {
	signal: AbortSignal;
	deadlineExpired: () => boolean;
}

export class ResponseProtocolError extends Error {
	constructor(readonly safeReason: string) {
		super(`SentinelOne SDL query ${safeReason}`);
	}
}

function responseProtocolError(message: string): ResponseProtocolError {
	return new ResponseProtocolError(message);
}

function quoteUnsafeIntegers(json: string): string {
	let output = '';
	let index = 0;
	let inString = false;
	let escaped = false;
	while (index < json.length) {
		const character = json[index];
		if (inString) {
			output += character;
			if (escaped) escaped = false;
			else if (character === '\\') escaped = true;
			else if (character === '"') inString = false;
			index++;
			continue;
		}
		if (character === '"') {
			inString = true;
			output += character;
			index++;
			continue;
		}
		if (character === '-' || (character >= '0' && character <= '9')) {
			const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(json.slice(index));
			if (match) {
				const token = match[0];
				const numericValue = Number(token);
				if (!Number.isFinite(numericValue) || Math.abs(numericValue) > Number.MAX_SAFE_INTEGER) {
					output += JSON.stringify(token);
					index += token.length;
					continue;
				}
				output += token;
				index += token.length;
				continue;
			}
		}
		output += character;
		index++;
	}
	return output;
}

function validateAlreadyParsedNumbers(value: unknown): void {
	if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value))
		throw responseProtocolError(
			'received already-parsed unsafe integers; a text response is required',
		);
	if (Array.isArray(value)) {
		for (const item of value) validateAlreadyParsedNumbers(item);
	} else {
		const record = asRecord(value);
		if (record) for (const item of Object.values(record)) validateAlreadyParsedNumbers(item);
	}
}

function boundResponseBody(value: unknown, maximumBytes: number): unknown {
	if (value === undefined || value === null || value === '') return null;
	if (typeof value === 'string' || Buffer.isBuffer(value)) {
		const text = typeof value === 'string' ? value : value.toString('utf8');
		if (Buffer.byteLength(text, 'utf8') > maximumBytes)
			throw responseProtocolError('response exceeded the configured response-size limit');
		return value;
	}
	if (jsonBytes(value) > maximumBytes)
		throw responseProtocolError('response exceeded the configured response-size limit');
	return value;
}

export function decodeResponseBody(value: unknown): unknown {
	if (value === undefined || value === null || value === '') return null;
	if (typeof value === 'string' || Buffer.isBuffer(value)) {
		const text = typeof value === 'string' ? value : value.toString('utf8');
		try {
			return JSON.parse(quoteUnsafeIntegers(text));
		} catch {
			throw responseProtocolError('received an invalid JSON response');
		}
	}
	validateAlreadyParsedNumbers(value);
	return value;
}

function fullResponse(value: unknown, maximumBytes: number): FullResponse {
	const wrapper = asRecord(value);
	if (!wrapper) throw safeError('received an invalid HTTP response');
	const statusCode = wrapper.statusCode === undefined ? 200 : Number(wrapper.statusCode);
	if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599)
		throw safeError('received an invalid HTTP status');
	return {
		body: boundResponseBody(
			Object.prototype.hasOwnProperty.call(wrapper, 'body') ? wrapper.body : wrapper,
			maximumBytes,
		),
		headers: asRecord(wrapper.headers) ?? {},
		statusCode,
	};
}

export function readForwardTag(headers: IDataObject): string | undefined {
	const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === FORWARD_HEADER);
	if (!entry) return undefined;
	const value = entry[1];
	if (
		typeof value !== 'string' ||
		!value ||
		value.length > MAX_FORWARD_HEADER_LENGTH ||
		!/^[\x20-\x7e]+$/.test(value)
	)
		throw safeError('received an invalid query routing header');
	return value;
}

function createLifecycleAbort(parent: AbortSignal | undefined, timeoutMs: number): LifecycleAbort {
	const deadlineSignal = AbortSignal.timeout(timeoutMs);
	return {
		signal: parent ? AbortSignal.any([parent, deadlineSignal]) : deadlineSignal,
		deadlineExpired: () => deadlineSignal.aborted,
	};
}

export function remainingMilliseconds(deadline: number): number {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw safeError('exceeded its execution deadline');
	return Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remaining));
}

export async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) throw safeError('was cancelled');
	let onAbort: (() => void) | undefined;
	try {
		await Promise.race([
			workflowSleep(milliseconds),
			new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(safeError('was cancelled'));
				signal.addEventListener('abort', onAbort, { once: true });
			}),
		]);
	} finally {
		if (onAbort) signal.removeEventListener('abort', onAbort);
	}
}

async function cleanupQuery(
	context: IExecuteFunctions,
	url: string,
	headers: IDataObject,
): Promise<CleanupStatus> {
	const cleanupSignal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
	try {
		const response = fullResponse(
			await context.helpers.httpRequestWithAuthentication.call(context, CREDENTIAL_TYPE, {
				url,
				method: 'DELETE',
				headers,
				json: false,
				encoding: 'text',
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				sendCredentialsOnCrossOriginRedirect: false,
				timeout: CLEANUP_TIMEOUT_MS,
				abortSignal: cleanupSignal,
			}),
			1024 * 1024,
		);
		return response.statusCode >= 200 && response.statusCode < 300 ? 'request_accepted' : 'failed';
	} catch {
		return cleanupSignal.aborted ? 'timed_out' : 'failed';
	}
}

export async function createSdlTransport(
	context: IExecuteFunctions,
	itemIndex: number,
	timeoutSeconds: number,
	maxResponseBytes: number,
) {
	const credentials = await context.getCredentials<{ baseUrl?: unknown; apiToken?: unknown }>(
		CREDENTIAL_TYPE,
		itemIndex,
	);
	const baseUrl = requireString(credentials.baseUrl, 'a configured console URL').replace(
		/\/+$/,
		'',
	);
	const endpoint = `${baseUrl}/sdl/v2/api/queries`;
	const commonHeaders: IDataObject = {
		'Content-Type': 'application/json',
	};
	const parentSignal = context.getExecutionCancelSignal();
	const lifecycle = createLifecycleAbort(parentSignal, timeoutSeconds * 1000);
	const deadline = Date.now() + timeoutSeconds * 1000;
	const request = async (requestOptions: IHttpRequestOptions): Promise<FullResponse> =>
		fullResponse(
			await context.helpers.httpRequestWithAuthentication.call(context, CREDENTIAL_TYPE, {
				...requestOptions,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				json: false,
				encoding: 'text',
				sendCredentialsOnCrossOriginRedirect: false,
				abortSignal: lifecycle.signal,
			}),
			maxResponseBytes,
		);
	return {
		endpoint,
		commonHeaders,
		parentSignal,
		lifecycle,
		deadline,
		request,
		cleanup: (url: string, headers: IDataObject) => cleanupQuery(context, url, headers),
	};
}
