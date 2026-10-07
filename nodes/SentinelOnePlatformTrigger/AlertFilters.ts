import type { IDataObject, INodeProperties } from 'n8n-workflow';
import type { AuthenticatedRequest } from './SentinelOneTriggerHelpers';

const textComparators = ['contains', 'startsWith', 'endsWith', 'exactMatch', 'stringIn'];

export const alertFilterProperties: INodeProperties[] = [
	{
		displayName: 'Alert Filters',
		name: 'alertFilters',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		default: {},
		placeholder: 'Add Filter',
		displayOptions: { show: { resource: ['alert'] } },
		options: [
			{
				name: 'filter',
				displayName: 'Filter',
				// Field, comparator and value follow the order used to build a filter.
				// eslint-disable-next-line n8n-nodes-base/node-param-fixed-collection-type-unsorted-items
				values: [
					{
						displayName: 'Field Name or ID',
						name: 'fieldId',
						type: 'options',
						default: '',
						typeOptions: { loadOptionsMethod: 'getAlertFilterFields' },
						description:
							'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
					},
					{
						displayName: 'Comparator',
						name: 'comparator',
						type: 'options',
						default: 'contains',
						// Present text, boolean and date comparisons together.
						// eslint-disable-next-line n8n-nodes-base/node-param-options-type-unsorted-items
						options: [
							{ name: 'Contains', value: 'contains' },
							{ name: 'Starts With', value: 'startsWith' },
							{ name: 'Ends With', value: 'endsWith' },
							{ name: 'Exact Match', value: 'exactMatch' },
							{ name: 'Is Any Of', value: 'stringIn' },
							{ name: 'Is True', value: 'isTrue' },
							{ name: 'Is False', value: 'isFalse' },
							{ name: 'After', value: 'after' },
							{ name: 'Before', value: 'before' },
						],
					},
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
						typeOptions: { rows: 2 },
						displayOptions: { show: { comparator: textComparators } },
						description:
							'One value per line. Any non-empty line can match. Text matching ignores case; Is Any Of uses exact, case-sensitive values.',
					},
					{
						displayName: 'Date',
						name: 'date',
						type: 'dateTime',
						default: '',
						displayOptions: { show: { comparator: ['after', 'before'] } },
					},
					{
						displayName: 'Exclude',
						name: 'exclude',
						type: 'boolean',
						default: false,
						description: 'Whether to exclude alerts matching this filter',
					},
				],
			},
		],
	},
	{
		displayName: 'Match Filters',
		name: 'alertFilterMatch',
		type: 'options',
		default: 'all',
		displayOptions: { show: { resource: ['alert'] } },
		options: [
			{ name: 'Match All', value: 'all' },
			{ name: 'Match Any', value: 'any' },
		],
		description:
			'How to combine Alert Filters. Severity, Status, Alert Name and Advanced Filters must also match.',
	},
];

export interface AlertFilterMetadata {
	fieldId: string;
	filterTypes: string[] | null;
	enableNegation: boolean;
}

export async function loadAlertFilterMetadata(
	request: AuthenticatedRequest,
	baseUrl: string,
): Promise<AlertFilterMetadata[]> {
	// SAFETY: the selected query returns this metadata envelope; its shape is checked before use.
	const response = (await request({
		method: 'POST',
		url: `${baseUrl}/web/api/v2.1/unifiedalerts/graphql`,
		timeout: 30_000,
		json: true,
		body: { query: 'query { alertColumnMetadata { fieldId filterTypes enableNegation } }' },
	})) as { data?: { alertColumnMetadata?: AlertFilterMetadata[] }; errors?: unknown[] };

	const fields = response?.data?.alertColumnMetadata;

	if (
		response?.errors?.length ||
		!Array.isArray(fields) ||
		fields.some(
			(field) =>
				!field ||
				typeof field.fieldId !== 'string' ||
				(field.filterTypes != null &&
					(!Array.isArray(field.filterTypes) ||
						field.filterTypes.some((type) => typeof type !== 'string'))),
		)
	) {
		throw new Error('SentinelOne returned no usable alert filter metadata.');
	}

	return fields
		.filter((field) => (field.filterTypes?.length ?? 0) > 0)
		.sort((a, b) => a.fieldId.localeCompare(b.fieldId));
}

export function parseAlertFilters(input: unknown): IDataObject[] {
	if (input === undefined || input === null) return [];

	if (typeof input !== 'object' || Array.isArray(input))
		throw new Error('Alert Filters must contain filter rows.');
	// SAFETY: the object check above excludes arrays and null.
	const rows = (input as IDataObject).filter;

	if (rows === undefined) return [];

	if (!Array.isArray(rows)) throw new Error('Alert Filters must contain filter rows.');

	return rows.map((row) => {
		if (!row || typeof row !== 'object' || Array.isArray(row))
			throw new Error('Alert Filters: each row must be a filter.');
		const fieldId = String(row.fieldId ?? '').trim();
		const comparator = String(row.comparator ?? 'contains');

		if (!fieldId) throw new Error('Alert Filters: select a field for every row.');
		let comparison: IDataObject;

		if (textComparators.includes(comparator)) {
			const values = String(row.value ?? '')
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean);

			if (!values.length) throw new Error(`Alert Filters: ${fieldId} needs at least one value.`);
			comparison =
				comparator === 'stringIn'
					? { stringIn: { values } }
					: { match: { operator: comparator, values } };
		} else if (comparator === 'isTrue' || comparator === 'isFalse') {
			comparison = { booleanEqual: { value: comparator === 'isTrue' } };
		} else if (comparator === 'after' || comparator === 'before') {
			const date = Date.parse(String(row.date ?? ''));

			if (!Number.isFinite(date)) throw new Error(`Alert Filters: ${fieldId} needs a valid date.`);
			comparison = { dateTimeRange: { [comparator === 'after' ? 'start' : 'end']: date } };
		} else throw new Error(`Alert Filters: ${fieldId} does not support ${comparator}`);

		return { fieldId, ...comparison, ...(row.exclude === true ? { isNegated: true } : {}) };
	});
}

const comparatorFilterTypes: Record<string, string> = {
	match: 'FULLTEXT',
	stringIn: 'STRING_IN',
	booleanEqual: 'BOOLEAN_EQUAL',
	dateTimeRange: 'DATE_RANGE',
};

export function validateAlertFilters(
	filters: IDataObject[],
	metadata: AlertFilterMetadata[],
): void {
	for (const filter of filters) {
		const fieldId = String(filter.fieldId);
		const field = metadata.find((entry) => entry.fieldId === fieldId);

		if (!field?.filterTypes?.length)
			throw new Error(
				`Alert Filters: ${fieldId} is not a filterable field${fieldId === 'name' ? '. Use alertName instead' : ''}`,
			);
		const comparator = Object.keys(filter).find((key) => key !== 'fieldId' && key !== 'isNegated')!;

		if (!field.filterTypes.includes(comparatorFilterTypes[comparator]))
			throw new Error(`Alert Filters: ${fieldId} does not support ${comparator}`);

		if (filter.isNegated && !field.enableNegation)
			throw new Error(`Alert Filters: ${fieldId} does not support Exclude`);
	}
}
