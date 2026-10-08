import { responseStatus } from '../../../shared/transport/retry';
import { authenticatedRequest } from '../../../shared/transport/authenticatedRequest';
import {
	alertFilterProperties,
	parseAlertFilters,
	validateAlertFilters,
	loadAlertFilterMetadata,
	TriggerFilterError,
} from '../../../shared/AlertFilters';
import { advancedFilterSelection } from '../../../shared/AlertFilterSelection';
import { advancedAlertFilters } from '../../../shared/AlertFilterAdvanced';
import type { INodeProperties, IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import {
	additionalAlertFields,
	managementScopeOption,
	severityOptions,
	statusOptions,
	analystVerdictOptions,
} from '../../../shared/Descriptions';
import { isRecord, localError, apiError, assertAlert } from '../common';
import { graphQlRequest } from '../../transport/graphql';
import { getManyAlertsDocument } from '../documents';
import { readListScope, normalizeBaseUrl } from '../../../shared/Scopes';
import { buildFilters } from './filters';
import { alertListSelection, alertOutput } from '../../../shared/AlertFields';

const MAX_PAGE_SIZE = 100;

const MAX_RETURN_ALL_ALERTS = 10_000;
const MAX_STALLED_ALERT_PAGES = 3;

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

	const legacyFilters = buildFilters(
		context,
		itemIndex,
		context.getNodeParameter('filters', itemIndex, {}),
	);
	let selectionFilters;
	try {
		const rows = parseAlertFilters(
			context.getNodeParameter('alertFilters', itemIndex, {}),
			context.getTimezone?.(),
		);
		const match = context.getNodeParameter('alertFilterMatch', itemIndex, 'all');
		if (match !== 'all' && match !== 'any') throw new Error('Match Filters must be All or Any.');
		const options = context.getNodeParameter('options', itemIndex, {});
		selectionFilters = advancedFilterSelection(
			legacyFilters,
			isRecord(options) ? options.advancedFilters : undefined,
			rows,
			match,
		);
		if (rows.length) {
			let metadata;
			try {
				const credentials = await context.getCredentials('sentinelOnePlatformApi');
				metadata = await loadAlertFilterMetadata(
					authenticatedRequest(
						context,
						context.getNodeParameter('nodeDebug', itemIndex, false) === true,
						undefined,
						itemIndex,
					),
					normalizeBaseUrl(credentials.baseUrl),
					String(context.getNode().credentials?.sentinelOnePlatformApi?.id ?? ''),
				);
			} catch (error) {
				// Metadata is advisory outside manual execution; authentication failures remain fatal.
				if (
					(context.getMode?.() ?? 'manual') === 'manual' ||
					[401, 403].includes(responseStatus(error) ?? 0)
				) {
					// The outer boundary adds item context while preserving typed transport errors.
					// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
					throw error;
				}
				context.logger.warn(
					`[SentinelOne Platform] Unable to validate Alert Filters against field metadata. ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (metadata) validateAlertFilters(rows, metadata);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// Metadata transport errors already carry the HTTP status and retry details.
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
		if (error instanceof NodeOperationError || error instanceof NodeApiError) throw error;
		throw new NodeOperationError(context.getNode(), message, {
			itemIndex,
			description: error instanceof TriggerFilterError ? error.description : undefined,
		});
	}

	const alerts: IDataObject[] = [];
	const seenCursors = new Set<string>();
	const seenAlertIds = new Set<string>();
	let after: string | undefined;
	let stalledAlertPages = 0;

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
				filters: selectionFilters.filters,
				...(selectionFilters.orFilter ? { orFilter: selectionFilters.orFilter } : {}),
				sorts: [{ by: 'createdAt', order: 'DESC' }],
			},
			'alerts',
		);

		const page = assertConnection(context, itemIndex, root);

		if (page.edges.length === 0 && page.hasNextPage) {
			throw apiError(
				context,
				itemIndex,
				'SentinelOne returned an empty alert page that claims another page exists.',
			);
		}

		const previousAlertCount = alerts.length;
		for (const edge of page.edges) {
			if (!isRecord(edge) || typeof edge.cursor !== 'string' || !edge.cursor.trim()) {
				throw apiError(context, itemIndex, 'SentinelOne returned a malformed alert edge.');
			}

			assertAlert(context, itemIndex, edge.node, null, scope);
			const id = String(edge.node.id);
			if (seenAlertIds.has(id)) continue;
			if (returnAll && alerts.length >= MAX_RETURN_ALL_ALERTS) {
				throw localError(
					context,
					itemIndex,
					`Return All is limited to ${MAX_RETURN_ALL_ALERTS.toLocaleString('en-US')} alerts. Add filters or use a bounded Limit.`,
				);
			}
			seenAlertIds.add(id);
			alerts.push(alertOutput(edge.node as IDataObject));

			if (alerts.length >= rawLimit) break;
		}

		if (!page.hasNextPage || alerts.length >= rawLimit) break;
		stalledAlertPages = alerts.length === previousAlertCount ? stalledAlertPages + 1 : 0;
		if (stalledAlertPages >= MAX_STALLED_ALERT_PAGES)
			throw apiError(context, itemIndex, 'SentinelOne returned an alert page with no new alerts.');
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
	...alertFilterProperties.map((property) => ({
		...property,
		displayOptions: { show: { resource: ['alert'], operation: ['getAll'] } },
		...(property.name === 'alertFilterMatch'
			? {
					description:
						'How to combine Alert Filters. With Match Any, Exclude is one alternative; use Match All for exclusions that must always hold. Filters and Advanced Filters must also match.',
				}
			: {}),
	})),
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { resource: ['alert'], operation: ['getAll'] } },
		options: [
			additionalAlertFields('list'),
			{
				...advancedAlertFilters,
				description: advancedAlertFilters.description
					?.replace('Severity, Status, Alert Name', 'Filters')
					.replace('docs/trigger.md#advanced-filters', 'docs/actions.md#get-many-filters')
					.replace('Comparators, all fields and examples', 'Get Many filter rules'),
			},
			managementScopeOption(),
		],
	},
];
