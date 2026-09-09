import type { INodeProperties, IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { alertId } from '../../../shared/Descriptions';
import { requiredId, localError } from '../common';
import { readAlertNotes } from './notes';
export async function getManyAlertNotes(
	context: IExecuteFunctions,
	itemIndex: number,
): Promise<IDataObject[]> {
	const alertId = requiredId(context, itemIndex, 'alertId', 'Alert ID');
	const notes = await readAlertNotes(context, itemIndex, alertId);
	const returnAll = Boolean(context.getNodeParameter('returnAll', itemIndex, false));
	if (returnAll) return notes;
	const limit = Number(context.getNodeParameter('limit', itemIndex, 50));
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw localError(context, itemIndex, 'Limit must be a positive integer.');
	}
	return notes.slice(0, limit);
}

export const description: INodeProperties[] = [
	{
		...alertId,
		displayOptions: { show: { resource: ['alertNote'], operation: ['getAll'] } },
	},
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		displayOptions: { show: { resource: ['alertNote'], operation: ['getAll'] } },
		description: 'Whether to return all results or only up to a given limit',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		default: 50,
		typeOptions: { minValue: 1 },
		displayOptions: {
			show: { resource: ['alertNote'], operation: ['getAll'], returnAll: [false] },
		},
		description: 'Max number of results to return',
	},
];
