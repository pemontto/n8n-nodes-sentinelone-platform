import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { createAlertNote } from './actions/alertNote/create.operation';
import { getManyAlertNotes } from './actions/alertNote/getMany.operation';
import { getManyUnifiedAlerts } from './actions/alert/getMany.operation';
import { getUnifiedAlert } from './actions/alert/get.operation';
import { updateUnifiedAlert } from './actions/alert/update.operation';
import { executeSdlQuery } from './actions/sdlQuery/execute.operation';

type Handler = (context: IExecuteFunctions, itemIndex: number) => Promise<IDataObject[]>;

const handlers: Record<string, Record<string, Handler>> = {
	alertNote: {
		create: createAlertNote,
		getAll: getManyAlertNotes,
	},
	sdlQuery: {
		execute: executeSdlQuery,
	},
	alert: {
		get: getUnifiedAlert,
		getAll: getManyUnifiedAlerts,
		update: updateUnifiedAlert,
	},
};

export async function routeSentinelOneOperation(
	context: IExecuteFunctions,
	itemIndex: number,
): Promise<IDataObject[]> {
	const resource = context.getNodeParameter('resource', itemIndex) as string;
	const operation = context.getNodeParameter('operation', itemIndex) as string;
	const resourceHandlers = Object.prototype.hasOwnProperty.call(handlers, resource)
		? handlers[resource]
		: undefined;
	const handler =
		resourceHandlers && Object.prototype.hasOwnProperty.call(resourceHandlers, operation)
			? resourceHandlers[operation]
			: undefined;
	if (!handler) {
		throw new NodeOperationError(
			context.getNode(),
			`Unsupported SentinelOne operation: ${resource}.${operation}`,
			{ itemIndex },
		);
	}
	return await handler(context, itemIndex);
}
