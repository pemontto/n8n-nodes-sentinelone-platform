import type { INodeProperties, IDataObject, IExecuteFunctions } from 'n8n-workflow';
import {
	additionalAlertFields,
	managementScopeFields,
	severityOptions,
	statusOptions,
	analystVerdictOptions,
} from '../../../shared/Descriptions';
import { isRecord, localError, apiError, assertAlert } from '../common';
import { graphQlRequest } from '../../transport/graphql';
import { getManyAlertsDocument } from '../documents';
import { readListScope } from '../../../shared/Scopes';
import { buildFilters } from './filters';
import { alertListSelection } from '../../../shared/AlertFields';
const MAX_PAGE_SIZE = 100;

const MAX_RETURN_ALL_ALERTS = 10_000;

function assertConnection(
	context: IExecuteFunctions,
	itemIndex: number,
	root: unknown,
): { edges: unknown[]; hasNextPage: boolean; endCursor: unknown } {
	if (!isRecord(root) || !Array.isArray(root.edges) || !isRecord(root.pageInfo)) {
		throw apiError(context, itemIndex, 'SentinelOne returned a malformed alerts connection.');
	}
	if (typeof root.pageInfo.hasNextPage !== 'boolean') {
		throw apiError(context, itemIndex, 'SentinelOne returned malformed alert pagination data.');
	}
	return {
		edges: root.edges,
		hasNextPage: root.pageInfo.hasNextPage,
		endCursor: root.pageInfo.endCursor,
	};
}

export async function getManyUnifiedAlerts(
	context: IExecuteFunctions,
	itemIndex: number,
): Promise<IDataObject[]> {
	let selection: string;
	try {
		const options = context.getNodeParameter('options', itemIndex, {});
		if (!isRecord(options)) throw new Error('Options must be an object.');
		selection = alertListSelection(options.additionalAlertFields);
	} catch (error) {
		throw localError(
			context,
			itemIndex,
			error instanceof Error ? error.message : 'Invalid alert field selection.',
		);
	}
	const document = getManyAlertsDocument(selection);
	const scope = await readListScope(context, itemIndex);
	const returnAll = Boolean(context.getNodeParameter('returnAll', itemIndex));
	const rawLimit = returnAll
		? Number.POSITIVE_INFINITY
		: Number(context.getNodeParameter('limit', itemIndex));
	if (!returnAll && (!Number.isSafeInteger(rawLimit) || rawLimit < 1)) {
		throw localError(context, itemIndex, 'Limit must be a positive integer.');
	}
	const filters = buildFilters(
		context,
		itemIndex,
		context.getNodeParameter('filters', itemIndex, {}),
	);
	const alerts: IDataObject[] = [];
	const seenCursors = new Set<string>();
	let after: string | undefined;
	while (alerts.length < rawLimit) {
		const first = returnAll ? MAX_PAGE_SIZE : Math.min(MAX_PAGE_SIZE, rawLimit - alerts.length);
		const root = await graphQlRequest(
			context,
			itemIndex,
			document,
			{
				first,
				...(after === undefined ? {} : { after }),
				scope,
				viewType: 'ALL',
				filters,
				sorts: [{ by: 'createdAt', order: 'DESC' }],
			},
			'alerts',
		);
		const page = assertConnection(context, itemIndex, root);
		if (
			returnAll &&
			(alerts.length + page.edges.length > MAX_RETURN_ALL_ALERTS ||
				(alerts.length + page.edges.length === MAX_RETURN_ALL_ALERTS && page.hasNextPage))
		) {
			throw localError(
				context,
				itemIndex,
				`Return All is limited to ${MAX_RETURN_ALL_ALERTS.toLocaleString('en-US')} alerts. Add filters or use a bounded Limit.`,
			);
		}
		if (page.edges.length === 0 && page.hasNextPage) {
			throw apiError(
				context,
				itemIndex,
				'SentinelOne returned an empty alert page that claims another page exists.',
			);
		}
		for (const edge of page.edges) {
			if (!isRecord(edge) || typeof edge.cursor !== 'string' || !edge.cursor.trim()) {
				throw apiError(context, itemIndex, 'SentinelOne returned a malformed alert edge.');
			}
			assertAlert(context, itemIndex, edge.node, null, scope);
			alerts.push(edge.node as IDataObject);
			if (alerts.length >= rawLimit) break;
		}
		if (!page.hasNextPage || alerts.length >= rawLimit) break;
		const next = typeof page.endCursor === 'string' ? page.endCursor.trim() : '';
		if (!next)
			throw apiError(context, itemIndex, 'SentinelOne omitted the cursor for the next alert page.');
		if (seenCursors.has(next))
			throw apiError(context, itemIndex, 'SentinelOne repeated an alert pagination cursor.');
		seenCursors.add(next);
		after = next;
	}
	return alerts;
}

export const description: INodeProperties[] = [
	...managementScopeFields({ show: { resource: ['alert'], operation: ['getAll'] } }),
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		displayOptions: { show: { resource: ['alert'], operation: ['getAll'] } },
		description: 'Whether to return all results or only up to a given limit',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		default: 50,
		typeOptions: { minValue: 1 },
		displayOptions: {
			show: { resource: ['alert'], operation: ['getAll'], returnAll: [false] },
		},
		description: 'Max number of results to return',
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { resource: ['alert'], operation: ['getAll'] } },
		options: [
			{
				displayName: 'Analyst Verdict',
				name: 'analystVerdicts',
				type: 'multiOptions',
				default: [],
				options: analystVerdictOptions,
				description: 'Limit alerts to the selected analyst verdicts',
			},
			{
				displayName: 'Created After',
				name: 'createdAfter',
				type: 'dateTime',
				default: '',
				description: 'Return alerts created at or after this time',
			},
			{
				displayName: 'Created Before',
				name: 'createdBefore',
				type: 'dateTime',
				default: '',
				description: 'Return alerts created before this time',
			},
			{
				displayName: 'External ID',
				name: 'externalId',
				type: 'string',
				default: '',
				description: 'Return alerts whose external ID equals this value',
			},
			{
				displayName: 'Severity',
				name: 'severities',
				type: 'multiOptions',
				default: [],
				options: severityOptions,
				description: 'Limit alerts to the selected severities',
			},
			{
				displayName: 'Status',
				name: 'statuses',
				type: 'multiOptions',
				default: [],
				options: statusOptions,
				description: 'Limit alerts to the selected statuses',
			},
			{
				displayName: 'Ticket ID',
				name: 'ticketId',
				type: 'string',
				default: '',
				description: 'Return alerts whose ticket ID equals this value',
			},
		],
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { resource: ['alert'], operation: ['getAll'] } },
		options: [additionalAlertFields('list')],
	},
];
