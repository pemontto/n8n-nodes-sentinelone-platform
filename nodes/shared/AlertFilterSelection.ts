import type { IDataObject } from 'n8n-workflow';
import { TriggerFilterError } from './AlertFilters';

function asRecord(value: unknown): IDataObject | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as IDataObject)
		: undefined;
}

const FILTER_COMPARATORS = [
	'booleanEqual',
	'booleanIn',
	'dateTimeRange',
	'intEqual',
	'intIn',
	'intRange',
	'longEqual',
	'longIn',
	'longRange',
	'match',
	'stringEqual',
	'stringIn',
] as const;

function validateRawFilter(value: unknown): IDataObject {
	const filter = asRecord(value);

	if (!filter) throw new Error('Each advanced filter must be an object.');
	const allowedKeys = new Set(['fieldId', 'isNegated', ...FILTER_COMPARATORS]);
	const unknownKeys = Object.keys(filter).filter((key) => !allowedKeys.has(key));

	if (unknownKeys.length > 0)
		throw new TriggerFilterError(
			'Advanced Filters contains an unknown key.',
			`Unknown keys: ${unknownKeys.join(', ')}.`,
		);
	const fieldId = typeof filter.fieldId === 'string' ? filter.fieldId.trim() : '';

	if (!fieldId) throw new Error('Each advanced filter needs a non-empty fieldId.');

	if (filter.isNegated !== undefined && typeof filter.isNegated !== 'boolean')
		throw new Error('Advanced filter isNegated must be true or false.');
	const comparators = FILTER_COMPARATORS.filter((key) => filter[key] !== undefined);

	if (comparators.length !== 1)
		throw new TriggerFilterError(
			'Advanced Filters: must use exactly one comparator.',
			`Field: ${fieldId}.`,
		);
	const comparator = asRecord(filter[comparators[0]]);

	if (!comparator)
		throw new TriggerFilterError(
			'Advanced Filters: comparator must be an object.',
			`Field: ${fieldId}.`,
		);

	return {
		fieldId,
		...(filter.isNegated === undefined ? {} : { isNegated: filter.isNegated }),
		[comparators[0]]: comparator,
	};
}

type FilterSelection = {
	filters: IDataObject[] | null;
	orFilter: IDataObject | null;
};

function advancedSelection(baseFilters: IDataObject[], input: unknown): FilterSelection {
	if (input === undefined || input === null || input === '')
		return { filters: baseFilters, orFilter: null };
	let value: unknown = input;

	if (typeof value === 'string') {
		let parsed: unknown;

		try {
			parsed = JSON.parse(value) as unknown;
		} catch {
			parsed = undefined;
		}

		if (parsed === undefined) throw new Error('Advanced Filters must contain valid JSON.');
		value = parsed;
	}

	if (Array.isArray(value)) {
		return { filters: [...baseFilters, ...value.map(validateRawFilter)], orFilter: null };
	}

	const selection = asRecord(value);

	if (!selection || Object.keys(selection).length !== 1 || !Array.isArray(selection.or))
		throw new Error('Advanced Filters must be a FilterInput array or an object containing or.');

	if (selection.or.length === 0)
		throw new Error('Advanced Filters or must contain at least one group.');

	const groups = selection.or.map((value) => {
		const group = asRecord(value);

		if (!group || Object.keys(group).length !== 1 || !Array.isArray(group.and))
			throw new Error('Each Advanced Filters or group must contain an and array.');

		return { and: [...baseFilters, ...group.and.map(validateRawFilter)] };
	});

	return { filters: null, orFilter: { or: groups } };
}

export function advancedFilterSelection(
	baseFilters: IDataObject[],
	input: unknown,
	rows: IDataObject[] = [],
	match: 'all' | 'any' = 'all',
): FilterSelection {
	let selection: FilterSelection;

	if (match === 'all' || rows.length === 0) {
		selection = advancedSelection([...baseFilters, ...rows], input);
	} else {
		const advanced = advancedSelection([], input);
		// SAFETY: advancedSelection constructs only groups with an and array.

		const groups = advanced.orFilter
			? (advanced.orFilter.or as Array<{ and: IDataObject[] }>)
			: [{ and: advanced.filters ?? [] }];

		selection = {
			filters: null,
			orFilter: {
				or: rows.flatMap((row) =>
					groups.map((group) => ({ and: [...baseFilters, row, ...group.and] })),
				),
			},
		};
	}
	// SAFETY: both selection paths construct flat and groups.

	const groups = selection.orFilter
		? (selection.orFilter.or as Array<{ and: IDataObject[] }>)
		: [{ and: selection.filters ?? [] }];

	const filterCount = Math.max(...groups.map((group) => group.and.length));

	if (groups.length > 20 || filterCount > 100)
		throw new Error(
			`Combined alert filters contain ${groups.length} groups and up to ${filterCount} filters per group; limits are 20 groups and 100 filters per group.`,
		);

	return selection;
}
