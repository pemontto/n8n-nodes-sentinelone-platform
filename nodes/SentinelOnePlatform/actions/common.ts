import type { IDataObject, IExecuteFunctions, JsonObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
export type ScopeType = 'ACCOUNT' | 'SITE' | 'GROUP';

export interface ScopeSelector extends IDataObject {
	scopeType: ScopeType;
	scopeIds: string[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function localError(
	context: IExecuteFunctions,
	itemIndex: number,
	message: string,
): NodeOperationError {
	return new NodeOperationError(context.getNode(), message, { itemIndex });
}

export function apiError(
	context: IExecuteFunctions,
	itemIndex: number,
	message: string,
	description?: string,
	httpCode = '400',
	mutationUnknown = false,
): NodeApiError {
	const safeResponse: JsonObject = { message, name: 'SentinelOneGraphQLError' };
	const error = new NodeApiError(context.getNode(), safeResponse, {
		itemIndex,
		message,
		description,
		httpCode,
	});
	if (mutationUnknown) Object.assign(error, { mayHaveCommitted: true, outcome: 'unknown' });
	return error;
}

export function idString(value: unknown): string | null {
	if (typeof value === 'string') return value.trim() || null;
	return null;
}

export function requiredId(
	context: IExecuteFunctions,
	itemIndex: number,
	parameterName: string,
	label: string,
): string {
	const value = idString(context.getNodeParameter(parameterName, itemIndex));
	if (!value) throw localError(context, itemIndex, `${label} must be a non-empty ID.`);
	return value;
}

export function scopeObject(alert: Record<string, unknown>): Record<string, unknown> | null {
	const realTime = isRecord(alert.realTime) ? alert.realTime : null;
	return realTime && isRecord(realTime.scope) ? realTime.scope : null;
}

export function assertAlert(
	context: IExecuteFunctions,
	itemIndex: number,
	alert: unknown,
	alertId: string | null,
	scope: ScopeSelector | null,
): asserts alert is Record<string, unknown> {
	if (!isRecord(alert)) {
		throw apiError(context, itemIndex, 'SentinelOne did not return the requested alert.');
	}
	const returnedId = idString(alert.id);
	if (!returnedId || (alertId !== null && returnedId !== alertId)) {
		throw apiError(context, itemIndex, 'SentinelOne did not return the requested alert.');
	}
	alert.id = returnedId;
	if (!scope) return;
	const returnedScope = scopeObject(alert);
	const level = scope.scopeType.toLowerCase();
	const levelObject = returnedScope && isRecord(returnedScope[level]) ? returnedScope[level] : null;
	const returnedScopeId = levelObject ? idString(levelObject.id) : null;
	if (!returnedScopeId || !scope.scopeIds.includes(returnedScopeId)) {
		throw apiError(context, itemIndex, 'The requested alert was not found in the selected scope.');
	}
	if (levelObject) levelObject.id = returnedScopeId;
}
export function assertMutationRetryDisabled(context: IExecuteFunctions, itemIndex: number): void {
	if (context.getNode().retryOnFail)
		throw localError(
			context,
			itemIndex,
			'Turn off Retry On Fail for writes. Use Verify Update to retry readback without repeating the mutation.',
		);
}
