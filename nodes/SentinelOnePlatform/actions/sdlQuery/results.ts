import type { IDataObject } from 'n8n-workflow';
import { asRecord, safeError, jsonBytes, validateNoQueryErrors } from './common';

type PartialReason =
	| 'server_time_limit'
	| 'omitted_events'
	| 'discarded_array_items'
	| 'external_result_unfetched'
	| 'row_limit'
	| 'output_size_limit';

interface TableResult {
	columns: IDataObject[];
	values: unknown[][];
	metadata: IDataObject;
}

interface ResultQuality {
	warnings: string[];
	omittedEvents: number;
	discardedArrayItems: number;
	partialDueToTimeLimit: boolean;
	externalResult: boolean;
}

function nonNegativeInteger(value: unknown, label: string): number {
	if (value === undefined || value === null) return 0;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
		throw safeError(`received an invalid ${label}`);
	return value;
}

function stringWarnings(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.some((warning) => typeof warning !== 'string'))
		throw safeError('received invalid query warnings');
	return [...value];
}

function resolveIntegerField(
	payload: IDataObject,
	data: IDataObject,
	field: string,
	label: string,
): number {
	const values = [payload[field], data[field]]
		.filter((value) => value !== undefined && value !== null)
		.map((value) => nonNegativeInteger(value, label));
	if (values.length > 1 && values[0] !== values[1])
		throw safeError(`received conflicting ${label} values`);
	return values[0] ?? 0;
}

function resolvePartialFlag(payload: IDataObject, data: IDataObject): boolean {
	const values = [payload.partialResultsDueToTimeLimit, data.partialResultsDueToTimeLimit].filter(
		(value) => value !== undefined && value !== null,
	);
	if (values.some((value) => typeof value !== 'boolean'))
		throw safeError('received an invalid partial-result flag');
	if (values.length > 1 && values[0] !== values[1])
		throw safeError('received conflicting partial-result flags');
	return values[0] === true;
}

function resolveExternalResult(payload: IDataObject, data: IDataObject): boolean {
	const values = [payload.fullResultUrl, data.fullResultUrl].filter(
		(value) => value !== undefined && value !== null && value !== '',
	);
	if (values.some((value) => typeof value !== 'string'))
		throw safeError('received an invalid external result URL');
	if (values.length > 1 && values[0] !== values[1])
		throw safeError('received conflicting external result URLs');
	return values.length > 0;
}

function collectQuality(payload: IDataObject, data: IDataObject): ResultQuality {
	validateNoQueryErrors(payload);
	const warnings = [...stringWarnings(payload.warnings), ...stringWarnings(data.warnings)].filter(
		(warning, index, all) => all.indexOf(warning) === index,
	);
	return {
		warnings,
		omittedEvents: resolveIntegerField(payload, data, 'omittedEvents', 'omitted event count'),
		discardedArrayItems: resolveIntegerField(
			payload,
			data,
			'discardedArrayItems',
			'discarded array item count',
		),
		partialDueToTimeLimit: resolvePartialFlag(payload, data),
		externalResult: resolveExternalResult(payload, data),
	};
}

export function collectTable(payload: IDataObject, queryId: string): TableResult {
	const data = asRecord(payload.data);
	if (!data) throw safeError('completed without result data');
	const quality = collectQuality(payload, data);
	const columnsValue = data.columns;
	const valuesValue = data.values;
	if (quality.externalResult && columnsValue === undefined && valuesValue === undefined) {
		return {
			columns: [],
			values: [],
			metadata: buildMetadata(payload, data, quality, queryId, ['external_result_unfetched'], 0),
		};
	}
	if (!Array.isArray(columnsValue) || !Array.isArray(valuesValue))
		throw safeError('returned an invalid result table');
	const columns = columnsValue.map((column) => {
		const descriptor = asRecord(column);
		if (!descriptor || typeof descriptor.name !== 'string')
			throw safeError('returned an invalid result column');
		return descriptor;
	});
	const values = valuesValue.map((row) => {
		if (!Array.isArray(row) || row.length !== columns.length)
			throw safeError('returned a result row with the wrong number of columns');
		return row;
	});
	const reasons: PartialReason[] = [];
	if (quality.partialDueToTimeLimit) reasons.push('server_time_limit');
	if (quality.omittedEvents > 0) reasons.push('omitted_events');
	if (quality.discardedArrayItems > 0) reasons.push('discarded_array_items');
	if (quality.externalResult) reasons.push('external_result_unfetched');
	return {
		columns,
		values,
		metadata: buildMetadata(payload, data, quality, queryId, reasons, values.length),
	};
}

function buildMetadata(
	payload: IDataObject,
	data: IDataObject,
	quality: ResultQuality,
	queryId: string,
	reasons: PartialReason[],
	resultRows: number,
): IDataObject {
	return {
		queryId,
		partial: reasons.length > 0,
		partialReasons: reasons,
		warnings: quality.warnings,
		matchingEvents: data.matchCount ?? payload.matchCount ?? null,
		omittedEvents: quality.omittedEvents,
		discardedArrayItems: quality.discardedArrayItems,
		cpuUsage: payload.cpuUsage ?? null,
		resultRows,
		returnedRows: resultRows,
		truncatedRows: 0,
	};
}

function addPartialReason(metadata: IDataObject, reason: PartialReason): void {
	const reasons = metadata.partialReasons as PartialReason[];
	if (!reasons.includes(reason)) reasons.push(reason);
	metadata.partial = true;
}

function safeColumnKeys(columns: IDataObject[]): string[] {
	const used = new Set<string>(['_query']);
	return columns.map((column, index) => {
		const base = (column.name as string) || `column_${index + 1}`;
		let candidate = base;
		let suffix = 2;
		while (used.has(candidate)) candidate = `${base}__${suffix++}`;
		used.add(candidate);
		return candidate;
	});
}

function rowObject(keys: string[], row: unknown[], metadata: IDataObject): IDataObject {
	const output = Object.create(null) as IDataObject;
	for (let index = 0; index < keys.length; index++) output[keys[index]] = row[index] as never;
	output._query = metadata;
	return output;
}

function outputForRows(
	columns: IDataObject[],
	values: unknown[][],
	metadata: IDataObject,
	count: number,
): IDataObject[] {
	metadata.returnedRows = count;
	metadata.truncatedRows = values.length - count;
	const keys = safeColumnKeys(columns);
	if (count === 0) return [{ _query: metadata }];
	return values.slice(0, count).map((row) => rowObject(keys, row, metadata));
}

function outputForTable(
	columns: IDataObject[],
	values: unknown[][],
	metadata: IDataObject,
	count: number,
): IDataObject[] {
	metadata.returnedRows = count;
	metadata.truncatedRows = values.length - count;
	return [{ queryId: metadata.queryId, columns, values: values.slice(0, count), metadata }];
}

export function boundOutput(
	mode: 'rows' | 'table',
	table: TableResult,
	maxRows: number,
	maxBytes: number,
	itemIndex: number,
): IDataObject[] {
	let count = Math.min(table.values.length, maxRows);
	if (count < table.values.length) addPartialReason(table.metadata, 'row_limit');
	const create = (rowCount: number) =>
		mode === 'rows'
			? outputForRows(table.columns, table.values, table.metadata, rowCount)
			: outputForTable(table.columns, table.values, table.metadata, rowCount);
	const wrappedBytes = (output: IDataObject[]) =>
		jsonBytes(output.map((json) => ({ json, pairedItem: { item: itemIndex } })));
	let output = create(count);
	if (wrappedBytes(output) <= maxBytes) return output;
	addPartialReason(table.metadata, 'output_size_limit');
	let low = 0;
	let high = count;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (wrappedBytes(create(middle)) <= maxBytes) low = middle;
		else high = middle - 1;
	}
	count = low;
	output = create(count);
	if (wrappedBytes(output) > maxBytes)
		throw safeError('metadata exceeds the configured output-size limit');
	return output;
}
