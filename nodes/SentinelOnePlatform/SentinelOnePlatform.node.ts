import { alertFilterLoadOptions } from '../shared/AlertFilterOptions';
import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { loadListScopeOptions } from '../shared/Scopes';
import { routeSentinelOneOperation } from './router';
import { isRecord } from './actions/common';
import { sentinelOneProperties } from './SentinelOneDescription';

function normalizeExecutionError(
	context: IExecuteFunctions,
	error: unknown,
	itemIndex: number,
): NodeApiError | NodeOperationError {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) return error;

	return new NodeOperationError(
		context.getNode(),
		error instanceof Error ? error : new Error(String(error)),
		{ itemIndex },
	);
}

function safeFailureOutput(error: NodeApiError | NodeOperationError): IDataObject {
	const output: IDataObject = { error: error.message };
	const value: Record<string, unknown> = isRecord(error) ? error : {};

	if (value.mayHaveCommitted === true) output.mayHaveCommitted = true;

	if (
		typeof value.outcome === 'string' &&
		['unknown', 'partial', 'rejected', 'scheduled'].includes(value.outcome)
	)
		output.outcome = value.outcome;

	if (
		typeof value.cleanupStatus === 'string' &&
		['request_accepted', 'failed', 'timed_out', 'not_required'].includes(value.cleanupStatus)
	)
		output.cleanupStatus = value.cleanupStatus;

	if (typeof value.queryId === 'string' && value.queryId) output.queryId = value.queryId;

	if (typeof value.httpCode === 'string') output.httpCode = value.httpCode;

	if (typeof value.errorCode === 'string') output.errorCode = value.errorCode;

	for (const key of ['alertId', 'requested', 'errors', 'mutationAcknowledged'] as const) {
		const detail = value[key] ?? (isRecord(value.context) ? value.context[key] : undefined);

		if (detail !== undefined) {
			// SAFETY: These fields are JSON output details attached by the alert update operations.
			output[key] = detail as IDataObject[string];
		}
	}

	return output;
}

// Tool exposure is deferred until the alert update mutation has been reviewed for agent use; the type has no false value, so the property is omitted.
// eslint-disable-next-line @n8n/community-nodes/node-usable-as-tool
export class SentinelOnePlatform implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'SentinelOne Platform',
		name: 'sentinelOnePlatform',
		icon: {
			light: 'file:../../icons/sentinelone.svg',
			dark: 'file:../../icons/sentinelone.dark.svg',
		},
		group: ['output'],
		version: 1,
		subtitle:
			'={{ ({get: "Get", getAll: "Get Many", update: "Update", create: "Create", execute: "Execute"})[$parameter.operation] + ": " + ({alert: "Alert", alertNote: "Alert Note", sdlQuery: "SDL Query"})[$parameter.resource] }}',
		description: 'Read and update alerts, create alert notes, and run SDL queries',
		defaults: {
			name: 'SentinelOne Platform',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'sentinelOnePlatformApi',
				required: true,
			},
		],
		properties: sentinelOneProperties,
	};

	methods = {
		loadOptions: {
			...alertFilterLoadOptions,
			async getAccounts(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadListScopeOptions(this, 'ACCOUNT');
			},
			async getGroups(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadListScopeOptions(this, 'GROUP');
			},
			async getSites(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadListScopeOptions(this, 'SITE');
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const inputItems = this.getInputData();
		const output: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < inputItems.length; itemIndex++) {
			try {
				const values = await routeSentinelOneOperation(this, itemIndex);
				output.push(
					...values.map((json) => ({
						json,
						pairedItem: { item: itemIndex },
					})),
				);
			} catch (error) {
				const normalized = normalizeExecutionError(this, error, itemIndex);

				if (!this.continueOnFail()) throw normalized;
				output.push({
					json: safeFailureOutput(normalized),
					error: normalized,
					pairedItem: { item: itemIndex },
				});
			}
		}

		return [output];
	}
}
