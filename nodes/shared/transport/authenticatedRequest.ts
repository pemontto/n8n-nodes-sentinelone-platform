import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { logGraphqlRequest, logGraphqlResult } from '../Debug';
import { PollBudgetError, requestWithRetry } from './request';
import { responseStatus, responseHeader, isRetryableReadError, retryAfterMs } from './retry';

export const ACTIVITY_FEED_ROUTING_HEADER = 'x-dataset-query-forward-tag';

type AuthenticatedRequest = (options: IHttpRequestOptions, deadlineMs?: number) => Promise<unknown>;

export function authenticatedRequest(
	context: IPollFunctions | ILoadOptionsFunctions | IExecuteFunctions,
	debug = false,
	deadline?: number,
): AuthenticatedRequest {
	return async (options, readerDeadline) =>
		requestWithRetry(
			async (timeoutMs, attempt) => {
				// SAFETY: request bodies passed to this helper are n8n JSON objects.
				const body = options.body as IDataObject | undefined;

				const document =
					options.url.includes('/unifiedalerts/graphql') && typeof body?.query === 'string'
						? body.query
						: undefined;

				if (document)
					logGraphqlRequest(context.logger, debug, document, body?.variables, { attempt });
				const startedAt = Date.now();
				let received = false;

				try {
					const response = await context.helpers.httpRequestWithAuthentication.call(
						context,
						'sentinelOnePlatformApi',
						{ ...options, timeout: timeoutMs, sendCredentialsOnCrossOriginRedirect: false },
					);

					received = true;

					if (document)
						logGraphqlResult(context.logger, debug, {
							attempt,
							durationMs: Date.now() - startedAt,
							outcome: 'received',
							graphqlErrorCount: Array.isArray(response?.errors) ? response.errors.length : 0,
						});

					return response;
				} finally {
					if (document && !received)
						logGraphqlResult(context.logger, debug, {
							attempt,
							durationMs: Date.now() - startedAt,
							outcome: 'transportError',
						});
				}
			},
			{
				// Scope loading and SDL polling own their bounded retry loops.
				attempts: options.url.includes('/unifiedalerts/graphql') ? 3 : 1,
				timeoutMs: options.timeout,
				deadline:
					readerDeadline === undefined ? deadline : Math.min(deadline ?? Infinity, readerDeadline),
			},
		).then((result) => {
			if (result.ok) return result.value;

			// Poll helpers recognise this class to keep a completed prefix; poll() wraps it with node context.
			if (result.error instanceof PollBudgetError) throw result.error;
			const error = result.error;
			const status = responseStatus(error);

			const message =
				status === 401
					? 'SentinelOne authentication failed. Check the credential.'
					: status === 403
						? 'SentinelOne denied access. Check the credential permissions.'
						: status === 429
							? 'SentinelOne rate limit reached. Try again after the service delay.'
							: `SentinelOne request failed${status ? ` (HTTP ${status})` : ''}. Check service availability.`;

			const apiError = new NodeApiError(
				context.getNode(),
				{ message },
				{
					message,
					description: status ? `SentinelOne returned HTTP ${status}.` : undefined,
					httpCode: status ? String(status) : undefined,
				},
			);

			const routingTag = responseHeader(error, ACTIVITY_FEED_ROUTING_HEADER);

			throw Object.assign(apiError, {
				...(routingTag !== undefined
					? { headers: { [ACTIVITY_FEED_ROUTING_HEADER]: routingTag } }
					: {}),
				statusCode: status,
				retryable: isRetryableReadError(error),
				retryAfterMs: Math.max(retryAfterMs(error), result.retryDelayMs ?? 0),
			});
		});
}
