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
	const value = error as unknown as Record<string, unknown>;
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
	return output;
}

export class SentinelOnePlatform implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'SentinelOne Platform',
		name: 'sentinelOnePlatform',
		icon: {
			light: 'file:../SentinelOnePlatformTrigger/sentinelone.svg',
			dark: 'file:../SentinelOnePlatformTrigger/sentinelone.dark.svg',
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
		usableAsTool: true,
	};

	methods = {
		loadOptions: {
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
