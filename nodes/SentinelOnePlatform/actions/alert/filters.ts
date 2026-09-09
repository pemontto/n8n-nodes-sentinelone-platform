import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { isRecord, localError } from '../common';
function parseStringValues(
	context: IExecuteFunctions,
	itemIndex: number,
	value: unknown,
	label: string,
): string[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw localError(context, itemIndex, `${label} must contain at least one value.`);
	}
	const values = value.map((entry) => (typeof entry === 'string' ? entry.trim() : ''));
	if (values.some((entry) => !entry)) {
		throw localError(context, itemIndex, `${label} cannot contain empty values.`);
	}
	return [...new Set(values)];
}

function dateMillis(
	context: IExecuteFunctions,
	itemIndex: number,
	value: unknown,
	label: string,
): number {
	const parsed = typeof value === 'number' ? value : Date.parse(String(value));
	if (!Number.isFinite(parsed))
		throw localError(context, itemIndex, `${label} must be a valid date.`);
	return parsed;
}

function validateAdvancedFilter(
	context: IExecuteFunctions,
	itemIndex: number,
	value: unknown,
): IDataObject {
	if (!isRecord(value))
		throw localError(context, itemIndex, 'Each alert filter must be an object.');
	const keys = Object.keys(value);
	if (keys.some((key) => ['__proto__', 'prototype', 'constructor'].includes(key))) {
		throw localError(context, itemIndex, 'Alert filters cannot contain prototype keys.');
	}
	const allowedKeys = new Set(['fieldId', 'isNegated', 'stringIn', 'stringEqual', 'dateTimeRange']);
	const unknown = keys.filter((key) => !allowedKeys.has(key));
	if (unknown.length > 0) {
		throw localError(context, itemIndex, `Unknown alert filter key: ${unknown.join(', ')}.`);
	}
	const fieldId = typeof value.fieldId === 'string' ? value.fieldId.trim() : '';
	const fieldComparators: Record<string, string> = {
		severity: 'stringIn',
		status: 'stringIn',
		analystVerdict: 'stringIn',
		createdAt: 'dateTimeRange',
		externalId: 'stringEqual',
		ticketId: 'stringEqual',
	};
	const expectedComparator = fieldComparators[fieldId];
	if (!expectedComparator)
		throw localError(
			context,
			itemIndex,
			`Unsupported alert filter field: ${fieldId || '(empty)'}.`,
		);
	const comparators = ['stringIn', 'stringEqual', 'dateTimeRange'].filter(
		(key) => value[key] !== undefined,
	);
	if (comparators.length !== 1 || comparators[0] !== expectedComparator) {
		throw localError(
			context,
			itemIndex,
			`Filter ${fieldId} must use exactly one ${expectedComparator} comparator.`,
		);
	}
	if (value.isNegated !== undefined && typeof value.isNegated !== 'boolean') {
		throw localError(context, itemIndex, 'Alert filter isNegated must be true or false.');
	}
	let comparator: IDataObject;
	if (expectedComparator === 'stringIn') {
		if (!isRecord(value.stringIn) || Object.keys(value.stringIn).some((key) => key !== 'values')) {
			throw localError(
				context,
				itemIndex,
				`Filter ${fieldId} has a malformed stringIn comparator.`,
			);
		}
		comparator = {
			values: parseStringValues(context, itemIndex, value.stringIn.values, `${fieldId} filter`),
		};
	} else if (expectedComparator === 'stringEqual') {
		if (
			!isRecord(value.stringEqual) ||
			Object.keys(value.stringEqual).some((key) => key !== 'value')
		) {
			throw localError(
				context,
				itemIndex,
				`Filter ${fieldId} has a malformed stringEqual comparator.`,
			);
		}
		const equalValue =
			typeof value.stringEqual.value === 'string' ? value.stringEqual.value.trim() : '';
		if (!equalValue)
			throw localError(context, itemIndex, `Filter ${fieldId} needs a non-empty value.`);
		comparator = { value: equalValue };
	} else {
		if (!isRecord(value.dateTimeRange)) {
			throw localError(
				context,
				itemIndex,
				'The createdAt filter has a malformed dateTimeRange comparator.',
			);
		}
		const rangeKeys = Object.keys(value.dateTimeRange);
		if (rangeKeys.some((key) => key !== 'start' && key !== 'end')) {
			throw localError(context, itemIndex, 'The createdAt filter contains an unknown range key.');
		}
		if (value.dateTimeRange.start === undefined && value.dateTimeRange.end === undefined) {
			throw localError(context, itemIndex, 'The createdAt filter needs a start or end date.');
		}
		const start =
			value.dateTimeRange.start === undefined
				? undefined
				: dateMillis(context, itemIndex, value.dateTimeRange.start, 'Created After');
		const end =
			value.dateTimeRange.end === undefined
				? undefined
				: dateMillis(context, itemIndex, value.dateTimeRange.end, 'Created Before');
		if (start !== undefined && end !== undefined && start > end) {
			throw localError(context, itemIndex, 'Created After cannot be later than Created Before.');
		}
		comparator = {
			...(start === undefined ? {} : { start }),
			...(end === undefined ? {} : { end }),
		};
	}
	return {
		fieldId,
		...(value.isNegated === undefined ? {} : { isNegated: value.isNegated }),
		[expectedComparator]: comparator,
	};
}

export function buildFilters(
	context: IExecuteFunctions,
	itemIndex: number,
	input: unknown,
): IDataObject[] {
	if (input === undefined || input === null || input === '') return [];
	let value: unknown = input;
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value) as unknown;
		} catch {
			throw localError(context, itemIndex, 'Filters must contain valid JSON.');
		}
	}
	if (Array.isArray(value))
		return value.map((filter) => validateAdvancedFilter(context, itemIndex, filter));
	if (!isRecord(value))
		throw localError(context, itemIndex, 'Filters must be a collection or an array.');
	const knownKeys = new Set([
		'severities',
		'statuses',
		'analystVerdicts',
		'createdAfter',
		'createdBefore',
		'externalId',
		'ticketId',
	]);
	const unknown = Object.keys(value).filter((key) => !knownKeys.has(key));
	if (unknown.length > 0)
		throw localError(context, itemIndex, `Unknown alert filter: ${unknown.join(', ')}.`);
	const result: IDataObject[] = [];
	for (const [parameterKey, fieldId] of [
		['severities', 'severity'],
		['statuses', 'status'],
		['analystVerdicts', 'analystVerdict'],
	] as const) {
		if (Array.isArray(value[parameterKey]) && value[parameterKey].length === 0) continue;
		if (value[parameterKey] !== undefined) {
			result.push({
				fieldId,
				stringIn: {
					values: parseStringValues(context, itemIndex, value[parameterKey], parameterKey),
				},
			});
		}
	}
	if (value.createdAfter !== undefined || value.createdBefore !== undefined) {
		const start =
			value.createdAfter === undefined
				? undefined
				: dateMillis(context, itemIndex, value.createdAfter, 'Created After');
		const end =
			value.createdBefore === undefined
				? undefined
				: dateMillis(context, itemIndex, value.createdBefore, 'Created Before');
		if (start !== undefined && end !== undefined && start > end) {
			throw localError(context, itemIndex, 'Created After cannot be later than Created Before.');
		}
		result.push({
			fieldId: 'createdAt',
			dateTimeRange: {
				...(start === undefined ? {} : { start }),
				...(end === undefined ? {} : { end }),
			},
		});
	}
	for (const key of ['externalId', 'ticketId'] as const) {
		if (value[key] !== undefined) {
			const equalValue = typeof value[key] === 'string' ? value[key].trim() : '';
			if (!equalValue)
				throw localError(context, itemIndex, `${key} filter needs a non-empty value.`);
			result.push({ fieldId: key, stringEqual: { value: equalValue } });
		}
	}
	return result;
}
