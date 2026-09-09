import type { IDataObject, IExecuteFunctions, INodeProperties } from 'n8n-workflow';
import { alertId, statusOptions, analystVerdictOptions } from '../../../shared/Descriptions';
import {
	apiError,
	localError,
	assertMutationRetryDisabled,
	idString,
	isRecord,
	requiredId,
} from '../common';
import { GRAPHQL_DOCUMENTS } from '../documents';
import { graphQlRequest } from '../../transport/graphql';
import { exactAlertFilter, orderActions, parseDiscoveredActions } from './update/discovery';
import { parseImmediateActions, sanitizeDetail } from './update/results';
import { parseUpdateObject, UPDATE_DEFINITIONS, validateUpdateValues } from './update/values';
import { unavailableVerification, verifyUpdate } from './update/verification';
import { responseStatus } from '../../../shared/transport/retry';
export const description: INodeProperties[] = [
	{
		...alertId,
		displayOptions: {
			show: {
				resource: ['alert'],
				operation: ['update'],
			},
		},
	},
	{
		displayName: 'Update Fields',
		name: 'updateFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: { resource: ['alert'], operation: ['update'] } },
		options: [
			{
				displayName: 'Analyst Verdict',
				name: 'analystVerdict',
				type: 'options',
				default: 'FALSE_POSITIVE_UNDEFINED',
				options: analystVerdictOptions,
				description: 'Analyst verdict to set',
			},
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				default: 'NEW',
				options: statusOptions,
				description: 'Alert status to set',
			},
			{
				displayName: 'Ticket ID',
				name: 'ticketId',
				type: 'string',
				default: '',
				description:
					'External ticket ID or metadata. Objects and arrays from expressions are serialized to JSON text automatically. Clearing is not supported.',
			},
		],
	},
	{
		displayName: 'Use Advanced Update Payload',
		name: 'useAdvancedUpdatePayload',
		type: 'boolean',
		default: false,
		displayOptions: { show: { resource: ['alert'], operation: ['update'] } },
		description:
			'Whether to add update fields as JSON. Supports the same fields as Update Fields; do not repeat fields selected above.',
	},
	{
		displayName: 'Advanced Update Payload',
		name: 'advancedUpdatePayload',
		type: 'json',
		default: '{}',
		typeOptions: { rows: 5 },
		displayOptions: {
			show: { resource: ['alert'], operation: ['update'], useAdvancedUpdatePayload: [true] },
		},
		description:
			'Optional payload using only status, analystVerdict, or ticketId. Alert selection and action IDs are not accepted here.',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { resource: ['alert'], operation: ['update'] } },
		options: [
			{
				displayName: 'Verify Update',
				name: 'verifyUpdate',
				type: 'boolean',
				default: true,
				description:
					'Whether to read back changed fields with bounded retries after submitting the update',
			},
		],
	},
];

export async function updateUnifiedAlert(
	context: IExecuteFunctions,
	itemIndex: number,
): Promise<IDataObject[]> {
	assertMutationRetryDisabled(context, itemIndex);
	const options = context.getNodeParameter('options', itemIndex, {});
	if (
		!isRecord(options) ||
		(options.verifyUpdate !== undefined && typeof options.verifyUpdate !== 'boolean')
	) {
		throw localError(context, itemIndex, 'Verify Update must be true or false in Options.');
	}
	const alertId = requiredId(context, itemIndex, 'alertId', 'Alert ID');
	const guided = parseUpdateObject(
		context,
		itemIndex,
		context.getNodeParameter('updateFields', itemIndex, {}),
		'Update Fields',
	);
	const advanced = parseUpdateObject(
		context,
		itemIndex,
		context.getNodeParameter('useAdvancedUpdatePayload', itemIndex, false)
			? context.getNodeParameter('advancedUpdatePayload', itemIndex, {})
			: {},
		'Advanced Update Payload',
	);
	const requested = validateUpdateValues(context, itemIndex, guided, advanced);
	const filter = exactAlertFilter(alertId);
	const discovery = await graphQlRequest(
		context,
		itemIndex,
		GRAPHQL_DOCUMENTS.availableActions,
		{ filter, viewType: 'ALL' },
		'alertAvailableActions',
	);
	const selected = orderActions(
		context,
		itemIndex,
		parseDiscoveredActions(context, itemIndex, discovery, requested),
	);
	const actions = selected.map((action) => ({
		id: action.id,
		payload: {
			[UPDATE_DEFINITIONS[action.field].payloadBranch]: { value: requested[action.field] },
		},
	}));
	let acknowledgement: IDataObject;
	try {
		const root = await graphQlRequest(
			context,
			itemIndex,
			GRAPHQL_DOCUMENTS.updateAlert,
			{ filter, actions, viewType: 'ALL' },
			'alertTriggerActions',
			true,
		);
		if (!isRecord(root))
			throw apiError(context, itemIndex, 'SentinelOne returned a malformed update result.');
		if (root.__typename === 'TriggerActionsError') {
			if (!Array.isArray(root.errors) || !root.errors.length)
				throw apiError(context, itemIndex, 'SentinelOne returned a malformed update rejection.');
			return [
				{
					outcome: 'rejected',
					mutationAcknowledged: false,
					alertId,
					requested,
					errors: root.errors.map((value) => sanitizeDetail(value, [requested.ticketId ?? ''])),
					verification: unavailableVerification(requested),
					verificationStatus: 'skipped',
				},
			];
		}
		if (root.__typename === 'TriggerActionsScheduled') {
			const executionId = idString(root.executionId);
			const bulkActionTriggerId = idString(root.bulkActionTriggerId);
			if (!executionId && !bulkActionTriggerId)
				throw apiError(
					context,
					itemIndex,
					'SentinelOne scheduled the update without an execution ID.',
				);
			acknowledgement = {
				outcome: 'scheduled',
				mutationAcknowledged: true,
				executionId: executionId ?? null,
				bulkActionTriggerId: bulkActionTriggerId ?? null,
			};
		} else if (root.__typename === 'ActionsTriggered') {
			const results = parseImmediateActions(context, itemIndex, root, selected, alertId, [
				requested.ticketId ?? '',
			]);
			const accepted = results.every(
				(result) =>
					result.status === 'success' ||
					(result.status === 'skipped' &&
						isRecord(result.detail) &&
						result.detail.skipType === 'NO_CHANGE'),
			);
			acknowledgement = {
				outcome: accepted ? 'complete' : 'partial',
				mutationAcknowledged: true,
				results,
			};
		} else
			throw apiError(context, itemIndex, 'SentinelOne returned an unknown update result type.');
	} catch (error) {
		const status = responseStatus(error);
		if (status === 401 || status === 403 || (isRecord(error) && error.rejected === true))
			return [
				{
					outcome: 'rejected',
					mutationAcknowledged: false,
					alertId,
					requested,
					errors: [
						{
							message:
								status === 401
									? 'SentinelOne rejected authentication. Check the credential.'
									: status === 403
										? 'SentinelOne denied this update. Check the credential permissions.'
										: 'SentinelOne rejected the GraphQL update before execution.',
						},
					],
					verification: unavailableVerification(requested),
					verificationStatus: 'skipped',
				},
			];
		acknowledgement = {
			outcome: 'unknown',
			mutationAcknowledged: false,
			mayHaveCommitted: true,
			warning:
				'The mutation was sent once. Its result is unavailable; do not repeat it without checking the alert.',
		};
	}
	if (options.verifyUpdate === false)
		return [
			{
				...acknowledgement,
				alertId,
				requested,
				verification: unavailableVerification(requested),
				verificationStatus: 'skipped',
			},
		];
	const query = `query SentinelOneVerifyUpdate($id: ID!) { alert(id: $id) { id ${Object.keys(requested).join(' ')} } }`;
	const verified = await verifyUpdate(requested, async (timeoutMs) => {
		const alert = await graphQlRequest(context, itemIndex, query, { id: alertId }, 'alert', false, {
			attempts: 1,
			timeoutMs,
		});
		if (!isRecord(alert) || idString(alert.id) !== alertId)
			throw apiError(context, itemIndex, 'SentinelOne returned an unexpected verification alert.');
		return alert as IDataObject;
	});
	return [
		{
			...acknowledgement,
			alertId,
			requested,
			...verified,
			verificationStatus:
				acknowledgement.outcome === 'scheduled' && verified.verificationStatus === 'mismatch'
					? 'pending'
					: verified.verificationStatus,
		},
	];
}
