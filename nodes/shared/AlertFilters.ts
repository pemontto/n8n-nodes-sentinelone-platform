import type {
	IDataObject,
	INodeProperties,
	INodePropertyOptions,
	IHttpRequestOptions,
} from 'n8n-workflow';

type AuthenticatedRequest = (options: IHttpRequestOptions) => Promise<unknown>;
import { tryToParseDateTime } from 'n8n-workflow';

export class TriggerFilterError extends Error {
	constructor(
		message: string,
		readonly description: string,
	) {
		super(message);
	}
}

// This table drives editor options, validation and API encoding.
const comparatorDefinitions = [
	{ name: 'Contains', value: 'contains', types: ['FULLTEXT'], api: 'match' },
	{ name: 'Starts With', value: 'startsWith', types: ['STRING_STARTS_WITH'], api: 'match' },
	{ name: 'Ends With', value: 'endsWith', types: ['STRING_ENDS_WITH'], api: 'match' },
	{ name: 'Exact Match', value: 'exactMatch', types: ['FULLTEXT'], api: 'match' },
	{ name: 'Is Any Of', value: 'stringIn', types: ['STRING_IN'], api: 'stringIn' },
	{ name: 'Is Any Of', value: 'longIn', types: ['LONG_IN'], api: 'longIn' },
	{ name: 'Is True', value: 'isTrue', types: ['BOOLEAN_EQUAL'], api: 'booleanEqual' },
	{
		name: 'Is False',
		value: 'isFalse',
		types: ['BOOLEAN_EQUAL'],
		api: 'booleanEqual',
	},
	{ name: 'After', value: 'after', types: ['DATE_RANGE'], api: 'dateTimeRange' },
	{ name: 'Before', value: 'before', types: ['DATE_RANGE'], api: 'dateTimeRange' },
];

const textComparators = comparatorDefinitions.flatMap(({ api, value }) =>
	['match', 'stringIn', 'longIn'].includes(api) ? [value] : [],
);

export const alertFilterComparators: INodePropertyOptions[] = comparatorDefinitions.map(
	({ name, value }) => ({ name, value }),
);

export function comparatorsForField(field: AlertFilterMetadata): INodePropertyOptions[] {
	return comparatorDefinitions.flatMap(({ name, value, types }) =>
		types.some((type) => field.filterTypes?.includes(type)) ? [{ name, value }] : [],
	);
}

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
						// Comparators are operators rather than entity IDs.
						// eslint-disable-next-line n8n-nodes-base/node-param-display-name-wrong-for-dynamic-options
						displayName: 'Comparator',
						name: 'comparator',
						// The operator labels describe the supported comparisons.
						// eslint-disable-next-line n8n-nodes-base/node-param-description-missing-from-dynamic-options
						type: 'options',
						default: 'contains',
						typeOptions: {
							loadOptionsMethod: 'getAlertFilterComparators',
							loadOptionsDependsOn: ['&fieldId'],
						},
					},
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
						typeOptions: { rows: 2 },
						displayOptions: { show: { comparator: textComparators } },
						description:
							'One value per line, or an array from an expression such as {{ ["A", "B"] }}. Any value can match. Contains, Starts With, Ends With and Exact Match ignore case; Is Any Of needs the whole value, exactly, including case.',
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
			'How to combine Alert Filters. With Match Any, Exclude is one alternative; use Match All for exclusions that must always hold. Severity, Status, Alert Name and Advanced Filters must also match.',
	},
];

export interface AlertFilterMetadata {
	fieldId: string;
	filterTypes: string[] | null;
	enableNegation: boolean;
}

const metadataCache = new Map<string, { expires: number; fields: AlertFilterMetadata[] }>();

const metadataCacheMs = 3 * 60_000;

export async function loadAlertFilterMetadata(
	request: AuthenticatedRequest,
	baseUrl: string,
	cacheKey?: string,
): Promise<AlertFilterMetadata[]> {
	const key = cacheKey ? `${baseUrl}:${cacheKey}` : undefined;
	const now = Date.now();

	for (const [entryKey, entry] of metadataCache) {
		if (entry.expires <= now) metadataCache.delete(entryKey);
	}

	const cached = key ? metadataCache.get(key) : undefined;

	if (cached) return cached.fields;
	// SAFETY: the selected query returns this metadata envelope; its shape is checked before use.

	const response = (await request({
		method: 'POST',
		url: `${baseUrl}/web/api/v2.1/unifiedalerts/graphql`,
		timeout: 10_000,
		json: true,
		body: { query: 'query { alertColumnMetadata { fieldId filterTypes enableNegation } }' },
	})) as { data?: { alertColumnMetadata?: AlertFilterMetadata[] }; errors?: unknown[] };

	if (response?.errors?.length) {
		const messages = response.errors.map((error) => {
			if (error && typeof error === 'object' && 'message' in error) return String(error.message);

			return String(error);
		});

		throw new TriggerFilterError(
			'Unable to load SentinelOne alert filter metadata.',
			messages.join('; '),
		);
	}

	const fields = response?.data?.alertColumnMetadata;

	if (
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

	const supported = fields
		.filter((field) => comparatorsForField(field).length > 0)
		.sort((a, b) => a.fieldId.localeCompare(b.fieldId));

	if (key) metadataCache.set(key, { expires: now + metadataCacheMs, fields: supported });

	return supported;
}

export function parseAlertFilters(input: unknown, timezone?: string): IDataObject[] {
	if (input === undefined || input === null) return [];

	if (typeof input !== 'object' || Array.isArray(input))
		throw new Error('Alert Filters must contain filter rows.');
	// SAFETY: the object check above excludes arrays and null.
	const rows = (input as IDataObject).filter;

	if (rows === undefined) return [];

	if (!Array.isArray(rows)) throw new Error('Alert Filters must contain filter rows.');

	return rows.map((row, index) => {
		if (!row || typeof row !== 'object' || Array.isArray(row))
			throw new TriggerFilterError(
				`Alert Filters row ${index + 1}: each row must be a filter.`,
				`Row: ${JSON.stringify(row)}.`,
			);
		const fieldId = String(row.fieldId ?? '').trim();
		const comparator = String(row.comparator ?? 'contains');

		if (!fieldId)
			throw new TriggerFilterError(
				`Alert Filters row ${index + 1}: select a field.`,
				`Row: ${JSON.stringify(row)}.`,
			);
		const definition = comparatorDefinitions.find(({ value }) => value === comparator);

		if (!definition)
			throw new TriggerFilterError(
				`Alert Filters row ${index + 1}: select an available comparator.`,
				`Field: ${fieldId}. Comparator: ${comparator}. Value: ${JSON.stringify(row.value ?? row.date)}.`,
			);

		const invalid = (message: string) =>
			new TriggerFilterError(
				`Alert Filters row ${index + 1}: ${message}`,
				`Field: ${fieldId}. Comparator: ${comparator}. Value: ${JSON.stringify(row.value ?? row.date)}.`,
			);

		let comparison: IDataObject;

		if (textComparators.includes(comparator)) {
			// One value per line, or an array from an expression such as {{ ["A", "B"] }}.
			if (
				Array.isArray(row.value) &&
				row.value.some((entry: unknown) => typeof entry !== 'string' && typeof entry !== 'number')
			)
				throw invalid('values must be strings or numbers.');

			const entries: string[] = Array.isArray(row.value)
				? row.value.map(String)
				: String(row.value ?? '').split(/\r?\n/);

			const values = entries.flatMap((line) => (line.trim() ? [line.trim()] : []));

			if (!values.length) throw invalid('needs at least one value.');

			if (definition.api === 'longIn') {
				const numbers = values.map(Number);

				if (numbers.some((value) => !Number.isSafeInteger(value)))
					throw invalid('needs numeric values that are safe whole numbers.');

				comparison = { longIn: { values: numbers } };
			} else {
				comparison =
					definition.api === 'match'
						? { match: { operator: comparator, values } }
						: { [definition.api]: { values } };
			}
		} else if (comparator === 'isTrue' || comparator === 'isFalse') {
			comparison = { [definition.api]: { value: comparator === 'isTrue' } };
		} else if (comparator === 'after' || comparator === 'before') {
			const input: unknown = row.date;

			const isLuxonDate =
				input !== null &&
				typeof input === 'object' &&
				'isLuxonDateTime' in input &&
				input.isLuxonDateTime === true;

			if (!['string', 'number'].includes(typeof input) && !(input instanceof Date) && !isLuxonDate)
				throw invalid('needs a valid date.');
			let date: number;

			try {
				// n8n's public parser uses Luxon and retains a supplied object's timezone.
				const value =
					typeof input === 'number'
						? new Date(input)
						: typeof input === 'string'
							? input.trim()
							: input;

				const isoDay =
					typeof value === 'string' ? /^(\d{4}-\d{2}-\d{2})(?=[T\s]|$)/i.exec(value) : null;

				// Reject calendar rollover in the parser's legacy fallback, while allowing ISO midnight (24:00).
				date =
					isoDay && tryToParseDateTime(isoDay[1], timezone).toISODate() !== isoDay[1]
						? NaN
						: tryToParseDateTime(value, timezone).toMillis();
			} catch {
				date = NaN;
			}

			if (!Number.isFinite(date)) throw invalid('needs a valid date.');

			comparison = { [definition.api]: { [comparator === 'after' ? 'start' : 'end']: date } };
		} else throw invalid(`${definition.name} is not available for this field`);

		return {
			fieldId,
			...comparison,
			...(row.exclude === true || row.exclude === 'true' ? { isNegated: true } : {}),
		};
	});
}

export function validateAlertFilters(
	filters: IDataObject[],
	metadata: AlertFilterMetadata[],
): void {
	for (const [index, filter] of filters.entries()) {
		const fieldId = String(filter.fieldId);
		const field = metadata.find((entry) => entry.fieldId === fieldId);

		if (!field?.filterTypes?.length)
			throw new TriggerFilterError(
				`Alert Filters row ${index + 1}: select a filterable field.`,
				`${fieldId} is not a filterable field${fieldId === 'name' ? '. Use alertName instead' : ''}`,
			);
		const comparator = Object.keys(filter).find((key) => key !== 'fieldId' && key !== 'isNegated')!;

		// Match operators need their own metadata capability.
		const definition = comparatorDefinitions.find(
			(entry) =>
				entry.api === comparator &&
				(comparator !== 'match' || entry.value === (filter.match as IDataObject).operator),
		);

		if (!definition?.types.some((type) => field.filterTypes?.includes(type)))
			throw new TriggerFilterError(
				`Alert Filters row ${index + 1}: ${definition?.name ?? 'The selected comparator'} is not available for this field`,
				`${fieldId} does not support ${comparator}. Values: ${JSON.stringify(filter[comparator])}. Supported comparators: ${comparatorsForField(
					field,
				)
					.map(({ value }) => value)
					.join(', ')}.`,
			);

		if (filter.isNegated && !field.enableNegation)
			throw new TriggerFilterError(
				`Alert Filters row ${index + 1}: Exclude is not available for this field`,
				`${fieldId} does not support Exclude.`,
			);
	}
}
