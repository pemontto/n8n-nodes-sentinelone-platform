import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { apiError, idString, isRecord } from '../../common';
import type { DiscoveredAction } from './discovery';
import { sanitizeReason } from '../../../../shared/Errors';
export { sanitizeReason };
export function sanitizeDetail(value: unknown, sensitiveValues: string[] = []): IDataObject {
	if (!isRecord(value)) return {};
	const output: IDataObject = {};
	for (const key of ['id', 'errorType', 'skipType', 'errorMessage', 'skipMessage']) {
		if (typeof value[key] === 'string')
			output[key] = key.endsWith('Message')
				? sanitizeReason(value[key], sensitiveValues)
				: value[key].slice(0, 200);
	}
	return output;
}
function validateActionResultId(
	context: IExecuteFunctions,
	itemIndex: number,
	value: unknown,
	alertId: string,
): void {
	if (!isRecord(value) || idString(value.id) !== alertId) {
		throw apiError(
			context,
			itemIndex,
			'SentinelOne returned an action result for an unexpected alert.',
		);
	}
	value.id = alertId;
}

export function parseImmediateActions(
	context: IExecuteFunctions,
	itemIndex: number,
	root: Record<string, unknown>,
	selected: DiscoveredAction[],
	alertId: string,
	sensitiveValues: string[] = [],
): IDataObject[] {
	if (!Array.isArray(root.actions))
		throw apiError(context, itemIndex, 'SentinelOne omitted immediate action results.');
	const byId = new Map<string, Record<string, unknown>>();
	for (const value of root.actions) {
		if (!isRecord(value))
			throw apiError(context, itemIndex, 'SentinelOne returned a malformed action result.');
		const actionId = idString(value.actionId);
		if (!actionId || byId.has(actionId))
			throw apiError(
				context,
				itemIndex,
				'SentinelOne returned duplicate or malformed action results.',
			);
		byId.set(actionId, value);
	}
	const expectedIds = new Set(selected.map((action) => action.id));
	if ([...byId.keys()].some((id) => !expectedIds.has(id))) {
		throw apiError(
			context,
			itemIndex,
			'SentinelOne returned a result for an action that was not requested.',
		);
	}
	return selected.map((action) => {
		const value = byId.get(action.id);
		if (!value)
			throw apiError(context, itemIndex, `SentinelOne omitted the result for action ${action.id}.`);
		for (const key of ['success', 'skip', 'failure']) {
			if (!Array.isArray(value[key]))
				throw apiError(context, itemIndex, `SentinelOne returned malformed ${key} results.`);
			for (const detail of value[key] as unknown[])
				validateActionResultId(context, itemIndex, detail, alertId);
		}
		const success = value.success as unknown[];
		const skip = value.skip as unknown[];
		const failure = value.failure as unknown[];
		if (success.length + skip.length + failure.length !== 1) {
			throw apiError(
				context,
				itemIndex,
				`SentinelOne returned conflicting or missing results for action ${action.id}.`,
			);
		}
		return {
			actionId: action.id,
			...(success.length === 1
				? { status: 'success', detail: sanitizeDetail(success[0], sensitiveValues) }
				: {}),
			...(skip.length === 1
				? { status: 'skipped', detail: sanitizeDetail(skip[0], sensitiveValues) }
				: {}),
			...(failure.length === 1
				? { status: 'failed', detail: sanitizeDetail(failure[0], sensitiveValues) }
				: {}),
		};
	});
}
