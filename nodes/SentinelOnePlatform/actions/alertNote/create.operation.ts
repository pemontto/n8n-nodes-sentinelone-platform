import type { INodeProperties, IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { alertId } from '../../../shared/Descriptions';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { requiredId, localError, apiError, isRecord, assertMutationRetryDisabled } from '../common';
import { graphQlRequest } from '../../transport/graphql';
import { GRAPHQL_DOCUMENTS } from '../documents';
import { readAlertNotes, readContentType, parseNote } from './notes';
function rethrowUnknownMutation(
	context: IExecuteFunctions,
	itemIndex: number,
	error: unknown,
): never {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) {
		Object.assign(error, { mayHaveCommitted: true, outcome: 'unknown' });
		throw error;
	}
	throw apiError(
		context,
		itemIndex,
		'SentinelOne returned an unusable mutation response.',
		'The mutation was sent once and was not retried. SentinelOne may have committed it; verify the resource before trying again.',
		'500',
		true,
	);
}

export async function createAlertNote(
	context: IExecuteFunctions,
	itemIndex: number,
): Promise<IDataObject[]> {
	assertMutationRetryDisabled(context, itemIndex);
	const alertId = requiredId(context, itemIndex, 'alertId', 'Alert ID');
	const text = context.getNodeParameter('text', itemIndex);
	if (typeof text !== 'string' || text.length === 0 || text.length > 20_000) {
		throw localError(context, itemIndex, 'Note text must contain between 1 and 20,000 characters.');
	}
	const type = readContentType(context, itemIndex);
	const before = await readAlertNotes(context, itemIndex, alertId);
	const root = await graphQlRequest(
		context,
		itemIndex,
		GRAPHQL_DOCUMENTS.createAlertNote,
		{ alertId, text, type },
		'addAlertNote',
		true,
	);
	try {
		if (!isRecord(root) || !Array.isArray(root.data)) {
			throw apiError(context, itemIndex, 'SentinelOne returned malformed created-note data.');
		}
		const after = root.data.map((note) => parseNote(context, itemIndex, note, alertId));
		const beforeIds = new Set(before.map((note) => String(note.id)));
		const afterIds = new Set(after.map((note) => String(note.id)));
		const completeSnapshot = [...beforeIds].every((id) => afterIds.has(id));
		const candidates = after.filter(
			(note) =>
				!beforeIds.has(String(note.id)) &&
				note.alertId === alertId &&
				note.text === text &&
				note.type === type,
		);
		let identification: IDataObject;
		if (completeSnapshot && candidates.length === 1) {
			identification = {
				status: 'inferred',
				evidence: 'single_new_id_matching_alert_text_and_type',
				note: candidates[0],
			};
		} else {
			identification = {
				status: 'ambiguous',
				reason: !completeSnapshot
					? 'after_snapshot_incomplete'
					: candidates.length === 0
						? 'no_new_candidate'
						: 'multiple_new_candidates',
				candidates,
			};
		}
		return [
			{
				outcome: 'acknowledged',
				mutationAcknowledged: true,
				alertId,
				contentType: type,
				identification,
				notes: after,
			},
		];
	} catch (error) {
		rethrowUnknownMutation(context, itemIndex, error);
	}
}

export const description: INodeProperties[] = [
	{
		...alertId,
		displayOptions: { show: { resource: ['alertNote'], operation: ['create'] } },
	},
	{
		displayName: 'Text',
		name: 'text',
		type: 'string',
		typeOptions: { rows: 5 },
		default: '',
		required: true,
		displayOptions: { show: { resource: ['alertNote'], operation: ['create'] } },
		description: 'Note text; Markdown is passed through unchanged when selected below',
	},
	{
		displayName: 'Content Format',
		name: 'contentType',
		type: 'options',
		default: 'PLAIN_TEXT',
		required: true,
		displayOptions: { show: { resource: ['alertNote'], operation: ['create'] } },
		options: [
			{ name: 'Markdown', value: 'MARKDOWN' },
			{ name: 'Plain Text', value: 'PLAIN_TEXT' },
		],
		description: 'Format of the submitted note text',
	},
];
