import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { isRecord, localError, apiError } from '../actions/common';
import { logGraphqlRequest, logGraphqlResult } from '../../shared/Debug';
import { responseStatus, isRetryableReadError, retryAfterMs } from '../../shared/transport/retry';
import { requestWithRetry } from '../../shared/transport/request';

const GRAPHQL_PATH = '/web/api/v2.1/unifiedalerts/graphql';

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
	options: { attempts?: number; timeoutMs?: number; alertId?: string } = {},
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

		// Without an HTTP response, preserve the transport error so callers can
		// distinguish timeouts and network failures from service responses.
		if (status === null) {
			const transportMessage = error instanceof Error ? error.message : String(error);
			const errorCode = isRecord(error) ? error.code : undefined;

			const transportError = new NodeOperationError(
				context.getNode(),
				error instanceof Error ? error : new Error(transportMessage),
				{
					itemIndex,
					message: transportMessage,
				},
			);

			// NodeOperationError expands common socket codes; keep the transport message intact.
			transportError.message = transportMessage;
			Object.assign(transportError, {
				...(typeof errorCode === 'string' && /^[A-Z0-9_.-]{1,64}$/.test(errorCode)
					? { errorCode }
					: {}),
				retryable,
				retryAfterMs: retryAfterMs(error),
				...(mutation ? { statusCode: null, mayHaveCommitted: true, outcome: 'unknown' } : {}),
			});
			throw transportError;
		}

		const suffix = ` (HTTP ${status})`;
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
			String(status),
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

	const errors = response.errors ?? [];

	const alertId = options.alertId ?? (rootName === 'alert' ? variables.id : undefined);

	if (
		!mutation &&
		typeof alertId === 'string' &&
		(errors.some(
			(entry) =>
				isRecord(entry) &&
				Array.isArray(entry.path) &&
				entry.path.length === 1 &&
				entry.path[0] === 'alert' &&
				typeof entry.message === 'string' &&
				entry.message.includes('Required value was null'),
		) ||
			(errors.length === 0 && isRecord(response.data) && response.data.alert === null))
	) {
		const failure = apiError(
			context,
			itemIndex,
			`Alert ${alertId} not found.`,
			'Check the alert ID and that the credential can see it.',
			'404',
		);

		Object.assign(failure, { alertId });
		throw failure;
	}

	if (errors.length > 0) {
		const codes = errors
			.map((entry) => {
				if (!isRecord(entry) || !isRecord(entry.extensions)) return '';
				const code = entry.extensions.code;
				const value = String(code ?? '');

				return /^[A-Z0-9_.-]{1,64}$/.test(value) ? value : '';
			})
			.filter(Boolean);

		// Return SentinelOne's own error text: it is what tells a user what went wrong.
		// Mutation values (such as note text) are masked if SentinelOne echoes them back.
		const submitted = mutation
			? (JSON.stringify(variables)
					.match(/"(?:[^"\\]|\\.)*"/g)
					?.map((value) => JSON.parse(value) as string)
					.filter((value) => value.length >= 4)
					.flatMap((value) => [JSON.stringify(value).slice(1, -1), value]) ?? [])
			: [];

		const mask = (text: string) =>
			submitted.reduce((masked, value) => masked.split(value).join('[submitted value]'), text);

		const messages = [
			...new Set(
				errors.flatMap((entry) => {
					const text =
						isRecord(entry) && typeof entry.message === 'string' ? mask(entry.message.trim()) : '';

					return text ? [text.length > 500 ? `${text.slice(0, 500)}…` : text] : [];
				}),
			),
		].slice(0, 5);

		const description =
			[
				messages.length > 0 ? messages.join(' | ') : '',
				codes.length > 0 ? `SentinelOne error codes: ${[...new Set(codes)].join(', ')}.` : '',
			]
				.filter(Boolean)
				.join(' ') || undefined;

		const failure = envelopeFailure(
			messages.length > 0
				? `SentinelOne GraphQL error: ${messages[0].length > 200 ? `${messages[0].slice(0, 200)}…` : messages[0]}`
				: 'SentinelOne GraphQL operation failed.',
			description,
		);

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
