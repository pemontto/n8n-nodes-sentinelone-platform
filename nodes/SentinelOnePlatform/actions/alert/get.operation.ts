import { additionalAlertFields, alertId } from '../../../shared/Descriptions';
import type { INodeProperties, IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { alertDetailSelection } from '../../../shared/AlertFields';
import { isRecord, localError, requiredId, assertAlert } from '../common';
import { graphQlRequest } from '../../transport/graphql';
export async function getUnifiedAlert(
	context: IExecuteFunctions,
	itemIndex: number,
): Promise<IDataObject[]> {
	const alertId = requiredId(context, itemIndex, 'alertId', 'Alert ID');
	let document: string;
	try {
		const options = context.getNodeParameter('options', itemIndex, {});
		if (!isRecord(options)) throw new Error('Options must be an object.');
		const selection = alertDetailSelection(
			options.additionalAlertFields,
			options.additionalGraphqlFields,
		);
		document = `query SentinelOneGetAlert($id: ID!) { alert(id: $id) { ${selection} } }`;
	} catch (error) {
		throw localError(
			context,
			itemIndex,
			error instanceof Error ? error.message : 'Invalid alert field selection.',
		);
	}
	const alert = await graphQlRequest(context, itemIndex, document, { id: alertId }, 'alert');
	assertAlert(context, itemIndex, alert, alertId, null);
	return [alert as IDataObject];
}

export const description: INodeProperties[] = [
	{
		...alertId,
		displayOptions: {
			show: {
				resource: ['alert'],
				operation: ['get'],
			},
		},
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { resource: ['alert'], operation: ['get'] } },
		options: [
			additionalAlertFields('detail'),
			{
				displayName: 'Additional GraphQL Fields',
				name: 'additionalGraphqlFields',
				type: 'string',
				default: '',
				typeOptions: { rows: 4 },
				placeholder: 'process { username file { sha256 } }',
				description:
					'Optional nested field selection, without a query wrapper. Supports field names, braces, and inline fragments. SentinelOne validates field names. Arguments, aliases, and directives are not supported.',
			},
		],
	},
];
