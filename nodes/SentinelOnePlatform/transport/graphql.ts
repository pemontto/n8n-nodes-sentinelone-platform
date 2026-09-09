import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { isRecord, localError, apiError } from '../actions/common';
import { logGraphqlRequest, logGraphqlResult } from '../../shared/Debug';
import { responseStatus, isRetryableReadError, retryAfterMs } from '../../shared/transport/retry';
import { requestWithRetry } from '../../shared/transport/request';
const GRAPHQL_PATH = '/web/api/v2.1/unifiedalerts/graphql';

interface GraphQlErrorShape {
	message?: unknown;
	path?: unknown;
	locations?: unknown;
	extensions?: unknown;
}

function normalizeBaseUrl(value: unknown): string {
	return String(value ?? '')
		.trim()
		.replace(/\/+$/, '');
}

export async function graphQlRequest(
	context: IExecuteFunctions,
	itemIndex: number,
	document: string,
	variables: IDataObject,
	rootName: string,
	mutation = false,
	options: { attempts?: number; timeoutMs?: number } = {},
): Promise<unknown> {
	const credentials = await context.getCredentials('sentinelOnePlatformApi');
	const baseUrl = normalizeBaseUrl(credentials.baseUrl);
	if (!baseUrl)
		throw localError(context, itemIndex, 'The SentinelOne Management Console URL is empty.');

	const debug = context.getNodeParameter('nodeDebug', itemIndex, false) === true;
	const envelopeFailure = (message: string, description?: string): NodeApiError =>
		apiError(context, itemIndex, message, description, '400', mutation);
	const result = await requestWithRetry(
		async (timeoutMs, attempt) => {
			const startedAt = Date.now();
			const metadata = { operation: rootName, attempt, itemIndex };
			logGraphqlRequest(context.logger, debug, document, variables, metadata);
			const received = await context.helpers.httpRequestWithAuthentication.call(
				context,
				'sentinelOnePlatformApi',
				{
					method: 'POST',
					url: `${baseUrl}${GRAPHQL_PATH}`,
					body: { query: document, variables },
					json: true,
					timeout: timeoutMs,
					sendCredentialsOnCrossOriginRedirect: false,
				},
			);
			logGraphqlResult(context.logger, debug, {
				...metadata,
				durationMs: Date.now() - startedAt,
				outcome: 'received',
				graphqlErrorCount:
					isRecord(received) && Array.isArray(received.errors) ? received.errors.length : 0,
			});
			return received;
		},
		{
			...options,
			mutation,
			onFailure: (error, attempt, durationMs) =>
				logGraphqlResult(context.logger, debug, {
					operation: rootName,
					attempt,
					itemIndex,
					durationMs,
					outcome: 'transportError',
					statusCode: responseStatus(error),
				}),
		},
	);
	if (!result.ok) {
		const error = result.error;
		const retryable = isRetryableReadError(error);
		const status = responseStatus(error);
		const suffix = status === null ? '' : ` (HTTP ${status})`;
		const rejected = mutation && (status === 401 || status === 403);
		const description = rejected
			? 'SentinelOne rejected authentication or permission before the write could execute.'
			: mutation
				? 'The mutation was sent once and was not retried. SentinelOne may have committed it; verify the alert before trying again.'
				: 'SentinelOne did not return a usable GraphQL response.';
		const failure = apiError(
			context,
			itemIndex,
			status === 401 || status === 403
				? `SentinelOne denied access${suffix}. Check the credential permissions.`
				: status === 429
					? 'SentinelOne rate limit reached. Retry after the service delay.'
					: `SentinelOne GraphQL request failed${suffix}.`,
			description,
			status === null ? '500' : String(status),
			mutation && !rejected,
		);
		Object.assign(failure, { retryable, retryAfterMs: retryAfterMs(error), statusCode: status });
		if (rejected)
			Object.assign(failure, { rejected: true, outcome: 'rejected', mayHaveCommitted: false });
		throw failure;
	}
	const response = result.value;

	if (!isRecord(response)) {
		throw envelopeFailure('SentinelOne returned a malformed GraphQL envelope.');
	}
	if (
		response.errors !== undefined &&
		response.errors !== null &&
		!Array.isArray(response.errors)
	) {
		throw envelopeFailure('SentinelOne returned a malformed GraphQL errors field.');
	}
	const errors = (response.errors ?? []) as GraphQlErrorShape[];
	if (errors.length > 0) {
		const codes = errors
			.map((entry) => {
				if (!isRecord(entry) || !isRecord(entry.extensions)) return '';
				const code = entry.extensions.code;
				const value = String(code ?? '');
				return /^[A-Z0-9_.-]{1,64}$/.test(value) ? value : '';
			})
			.filter(Boolean);
		const description =
			codes.length > 0 ? `SentinelOne error codes: ${[...new Set(codes)].join(', ')}.` : undefined;
		const failure = envelopeFailure('SentinelOne GraphQL operation failed.', description);
		const rejectionCodes = new Set([
			'GRAPHQL_VALIDATION_FAILED',
			'GRAPHQL_PARSE_FAILED',
			'FORBIDDEN',
			'UNAUTHENTICATED',
			'UNAUTHORIZED',
		]);
		if (
			mutation &&
			!response.data &&
			codes.length === errors.length &&
			codes.every((code) => rejectionCodes.has(code))
		)
			Object.assign(failure, { rejected: true, outcome: 'rejected', mayHaveCommitted: false });
		throw failure;
	}
	if (!isRecord(response.data)) {
		throw envelopeFailure('SentinelOne returned a GraphQL response without data.');
	}
	if (
		!(rootName in response.data) ||
		response.data[rootName] === null ||
		response.data[rootName] === undefined
	) {
		throw envelopeFailure(`SentinelOne returned a GraphQL response without ${rootName}.`);
	}
	return response.data[rootName];
}
