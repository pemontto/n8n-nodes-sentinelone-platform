import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { isRecord, localError, apiError, idString } from '../common';
import { graphQlRequest } from '../../transport/graphql';
import { GRAPHQL_DOCUMENTS } from '../documents';
export function parseNote(
	context: IExecuteFunctions,
	itemIndex: number,
	value: unknown,
	alertId: string,
): IDataObject {
	if (!isRecord(value))
		throw apiError(context, itemIndex, 'SentinelOne returned a malformed alert note.');
	const id = idString(value.id);
	const returnedAlertId = idString(value.alertId);
	if (!id || returnedAlertId !== alertId || typeof value.text !== 'string') {
		throw apiError(context, itemIndex, 'SentinelOne returned a malformed alert note.');
	}
	if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
		throw apiError(context, itemIndex, 'SentinelOne returned malformed alert note timestamps.');
	}
	if (
		value.type !== null &&
		value.type !== 'PLAIN_TEXT' &&
		value.type !== 'MARKDOWN' &&
		value.type !== 'HTML'
	) {
		throw apiError(context, itemIndex, 'SentinelOne returned an unknown alert note content type.');
	}
	let createdBy: IDataObject | null = null;
	if (value.createdBy !== null && value.createdBy !== undefined) {
		if (!isRecord(value.createdBy) || typeof value.createdBy.__typename !== 'string') {
			throw apiError(context, itemIndex, 'SentinelOne returned a malformed alert note author.');
		}
		if (value.createdBy.__typename === 'UserNoteAuthor') {
			const userId = idString(value.createdBy.userId);
			if (
				!userId ||
				typeof value.createdBy.email !== 'string' ||
				typeof value.createdBy.fullName !== 'string'
			) {
				throw apiError(context, itemIndex, 'SentinelOne returned a malformed user note author.');
			}
			createdBy = {
				__typename: 'UserNoteAuthor',
				userId,
				email: value.createdBy.email,
				fullName: value.createdBy.fullName,
			};
		} else if (value.createdBy.__typename === 'RuleNoteAuthor') {
			const ruleId = idString(value.createdBy.id);
			const version = value.createdBy.version;
			if (
				!ruleId ||
				typeof value.createdBy.name !== 'string' ||
				typeof version !== 'number' ||
				!Number.isInteger(version)
			) {
				throw apiError(context, itemIndex, 'SentinelOne returned a malformed rule note author.');
			}
			createdBy = { __typename: 'RuleNoteAuthor', id: ruleId, name: value.createdBy.name, version };
		} else {
			throw apiError(
				context,
				itemIndex,
				`SentinelOne returned an unsupported note author type: ${value.createdBy.__typename}.`,
			);
		}
	}
	return { ...value, id, alertId: returnedAlertId, createdBy } as IDataObject;
}

export async function readAlertNotes(
	context: IExecuteFunctions,
	itemIndex: number,
	alertId: string,
): Promise<IDataObject[]> {
	const root = await graphQlRequest(
		context,
		itemIndex,
		GRAPHQL_DOCUMENTS.getAlertNotes,
		{ alertId },
		'alertNotes',
	);
	if (!isRecord(root) || !Array.isArray(root.data)) {
		throw apiError(context, itemIndex, 'SentinelOne returned malformed alert note data.');
	}
	return root.data.map((note) => parseNote(context, itemIndex, note, alertId));
}

export function readContentType(
	context: IExecuteFunctions,
	itemIndex: number,
): 'PLAIN_TEXT' | 'MARKDOWN' {
	const value = String(context.getNodeParameter('contentType', itemIndex) ?? '').toUpperCase();
	if (value === 'PLAIN_TEXT' || value === 'PLAINTEXT' || value === 'PLAIN TEXT')
		return 'PLAIN_TEXT';
	if (value === 'MARKDOWN') return 'MARKDOWN';
	throw localError(context, itemIndex, 'Content Type must be Plain Text or Markdown.');
}
