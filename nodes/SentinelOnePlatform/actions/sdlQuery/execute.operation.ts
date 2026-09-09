import type { IDataObject, IExecuteFunctions, INodeProperties } from 'n8n-workflow';
import { asRecord, safeError, requireString, validateNoQueryErrors } from './common';
import { collectTable, boundOutput } from './results';
import {
	createSdlTransport,
	type CleanupStatus,
	type FullResponse,
	ResponseProtocolError,
	FORWARD_HEADER,
	decodeResponseBody,
	readForwardTag,
	remainingMilliseconds,
	delay,
} from '../../transport/sdl';

const MAX_RETRY_DELAY_MS = 10_000;

function requireQueryId(value: unknown): string {
	const queryId = requireString(value, 'a query ID in the launch response');
	if (queryId.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(queryId))
		throw safeError('launch returned an invalid query ID');
	return queryId;
}

function requireInteger(
	value: unknown,
	defaultValue: number,
	minimum: number,
	maximum: number,
	label: string,
): number {
	const resolved =
		value === undefined || value === null || value === '' ? defaultValue : Number(value);
	if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum)
		throw safeError(`${label} must be an integer from ${minimum} to ${maximum}`);
	return resolved;
}

function parseDate(value: unknown, label: string): Date {
	const input = requireString(value, label);
	const date = new Date(input);
	if (!Number.isFinite(date.getTime())) throw safeError(`requires a valid ${label}`);
	return date;
}

function isComplete(payload: IDataObject): boolean {
	return (
		typeof payload.stepsTotal === 'number' &&
		Number.isFinite(payload.stepsTotal) &&
		payload.stepsTotal > 0 &&
		typeof payload.stepsCompleted === 'number' &&
		Number.isFinite(payload.stepsCompleted) &&
		payload.stepsCompleted >= payload.stepsTotal &&
		asRecord(payload.data) !== undefined
	);
}

function updateLastStepSeen(payload: IDataObject, current: number): number {
	const value = payload.stepsCompleted;
	if (value === undefined || value === null) return current;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
		throw safeError('received invalid query progress');
	return Math.max(current, value);
}

function validateQueryId(payload: IDataObject, queryId: string): void {
	if (payload.id !== undefined && payload.id !== queryId)
		throw safeError('received a mismatched query ID');
}

function retryableStatus(status: number): boolean {
	return status === 404 || status === 429 || status >= 500;
}

function statusFailure(stage: 'launch' | 'poll', status: number): Error {
	return safeError(`${stage} failed with HTTP ${status}`);
}

function cleanupWarning(status: CleanupStatus): string | undefined {
	if (status === 'failed') return 'SentinelOne did not confirm query cleanup.';
	if (status === 'timed_out') return 'SentinelOne query cleanup timed out before confirmation.';
	return undefined;
}
export async function executeSdlQuery(
	context: IExecuteFunctions,
	itemIndex: number,
): Promise<IDataObject[]> {
	const query = requireString(context.getNodeParameter('query', itemIndex), 'a query');
	const start = parseDate(context.getNodeParameter('startTime', itemIndex), 'start time');
	const end = parseDate(context.getNodeParameter('endTime', itemIndex), 'end time');
	if (end.getTime() <= start.getTime())
		throw safeError('requires an end time after its start time');
	const queryScope = context.getNodeParameter('queryScope', itemIndex) as string;
	if (queryScope !== 'tenant' && queryScope !== 'accounts')
		throw safeError('requires a valid query scope');
	const accountIdsValue =
		queryScope === 'accounts'
			? (context.getNodeParameter('accountIds', itemIndex, []) as unknown)
			: [];
	const accountIds = Array.isArray(accountIdsValue)
		? accountIdsValue.map((value) => requireString(value, 'valid account IDs'))
		: [];
	if (queryScope === 'accounts' && accountIds.length === 0)
		throw safeError('requires at least one account ID for account scope');
	const outputMode = context.getNodeParameter('outputMode', itemIndex, 'rows') as string;
	if (outputMode !== 'rows' && outputMode !== 'table')
		throw safeError('requires a valid output mode');
	const options = asRecord(context.getNodeParameter('options', itemIndex, {})) ?? {};
	const timeoutSeconds = requireInteger(options.timeoutSeconds, 100, 10, 300, 'timeoutSeconds');
	const pollIntervalMs = requireInteger(
		options.pollIntervalMs,
		1500,
		1000,
		10_000,
		'pollIntervalMs',
	);
	const maxRows = requireInteger(options.maxRows, 5000, 1, 100_000, 'maxRows');
	const maxResponseSizeMiB = requireInteger(
		options.maxResponseSizeMiB,
		10,
		1,
		50,
		'maxResponseSizeMiB',
	);
	const maxResponseBytes = maxResponseSizeMiB * 1024 * 1024;
	const { endpoint, commonHeaders, parentSignal, lifecycle, deadline, request, cleanup } =
		await createSdlTransport(context, itemIndex, timeoutSeconds, maxResponseBytes);
	let queryId: string | undefined;
	let forwardTag: string | undefined;
	let completedPayload: IDataObject | undefined;
	let primaryFailure: unknown;
	let cleanupStatus: CleanupStatus | undefined;
	const routedHeaders = () => ({
		...commonHeaders,
		...(forwardTag ? { [FORWARD_HEADER]: forwardTag } : {}),
	});
	try {
		let response: FullResponse;
		try {
			response = await request({
				url: endpoint,
				method: 'POST',
				headers: commonHeaders,
				timeout: remainingMilliseconds(deadline),
				body: {
					queryType: 'PQ',
					startTime: start.toISOString(),
					endTime: end.toISOString(),
					pq: { query, resultType: 'TABLE' },
					...(queryScope === 'tenant' ? { tenant: true } : { tenant: false, accountIds }),
				},
			});
		} catch {
			if (parentSignal?.aborted) throw safeError('was cancelled during launch');
			if (lifecycle.deadlineExpired())
				throw safeError('exceeded its execution deadline during launch');
			throw safeError('launch request failed');
		}
		if (response.statusCode < 200 || response.statusCode >= 300)
			throw statusFailure('launch', response.statusCode);
		const launchPayload = asRecord(decodeResponseBody(response.body));
		if (!launchPayload) throw safeError('launch returned an invalid response body');
		queryId = requireQueryId(launchPayload.id);
		forwardTag = readForwardTag(response.headers);
		if (!forwardTag) throw safeError('launch response omitted its query routing header');
		validateQueryId(launchPayload, queryId);
		validateNoQueryErrors(launchPayload);
		let payload = launchPayload;
		let lastStepSeen = updateLastStepSeen(payload, 0);
		let retryCount = 0;
		let nextDelayMs = pollIntervalMs;
		while (!isComplete(payload)) {
			if (parentSignal?.aborted) throw safeError('was cancelled');
			if (lifecycle.deadlineExpired() || Date.now() >= deadline)
				throw safeError('exceeded its execution deadline');
			await delay(Math.min(nextDelayMs, remainingMilliseconds(deadline)), lifecycle.signal).catch(
				() => {
					if (parentSignal?.aborted) throw safeError('was cancelled');
					throw safeError('exceeded its execution deadline');
				},
			);
			let pollResponse: FullResponse;
			try {
				pollResponse = await request({
					url: `${endpoint}/${encodeURIComponent(queryId)}`,
					method: 'GET',
					headers: routedHeaders(),
					qs: { lastStepSeen },
					timeout: remainingMilliseconds(deadline),
				});
			} catch (error) {
				if (error instanceof ResponseProtocolError) throw safeError(error.safeReason);
				if (parentSignal?.aborted) throw safeError('was cancelled during polling');
				if (lifecycle.deadlineExpired() || Date.now() >= deadline)
					throw safeError('exceeded its execution deadline during polling');
				retryCount++;
				nextDelayMs = Math.min(
					MAX_RETRY_DELAY_MS,
					pollIntervalMs * 2 ** Math.min(retryCount - 1, 10),
				);
				continue;
			}
			const replacementTag = readForwardTag(pollResponse.headers);
			if (replacementTag) forwardTag = replacementTag;
			if (pollResponse.statusCode < 200 || pollResponse.statusCode >= 300) {
				if (!retryableStatus(pollResponse.statusCode))
					throw statusFailure('poll', pollResponse.statusCode);
				retryCount++;
				nextDelayMs = Math.min(
					MAX_RETRY_DELAY_MS,
					pollIntervalMs * 2 ** Math.min(retryCount - 1, 10),
				);
				continue;
			}
			retryCount = 0;
			nextDelayMs = pollIntervalMs;
			const pollPayload = asRecord(decodeResponseBody(pollResponse.body));
			if (!pollPayload) throw safeError('poll returned an invalid response body');
			validateQueryId(pollPayload, queryId);
			validateNoQueryErrors(pollPayload);
			lastStepSeen = updateLastStepSeen(pollPayload, lastStepSeen);
			payload = pollPayload;
		}
		completedPayload = payload;
	} catch (error) {
		primaryFailure = error;
	} finally {
		if (queryId) {
			cleanupStatus = await cleanup(`${endpoint}/${encodeURIComponent(queryId)}`, routedHeaders());
		}
	}
	if (primaryFailure !== undefined) {
		if (queryId && cleanupStatus) {
			const message =
				primaryFailure instanceof Error &&
				primaryFailure.message.startsWith('SentinelOne SDL query ')
					? primaryFailure.message
					: 'SentinelOne SDL query failed';
			throw new Error(`${message}; queryId=${queryId}; cleanupStatus=${cleanupStatus}`);
		}
		throw primaryFailure;
	}
	if (!completedPayload || !queryId || !cleanupStatus)
		throw safeError('ended without a completed query result');
	const table = collectTable(completedPayload, queryId);
	table.metadata.cleanupStatus = cleanupStatus;
	const warning = cleanupWarning(cleanupStatus);
	if (warning) (table.metadata.warnings as string[]).push(warning);
	return boundOutput(outputMode, table, maxRows, maxResponseBytes, itemIndex);
}

export const sdlOperation: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	default: 'execute',
	displayOptions: { show: { resource: ['sdlQuery'] } },
	options: [
		{
			name: 'Execute',
			value: 'execute',
			description: 'Run a bounded SDL PowerQuery and wait for its result',
			action: 'Execute an SDL query',
		},
	],
};

export const sdlDescription: INodeProperties[] = [
	{
		displayName: 'Query',
		name: 'query',
		type: 'string',
		typeOptions: { rows: 8 },
		default: '',
		required: true,
		displayOptions: { show: { resource: ['sdlQuery'], operation: ['execute'] } },
		description: 'SDL PowerQuery text',
	},
	{
		displayName: 'Start Time',
		name: 'startTime',
		type: 'dateTime',
		default: '',
		required: true,
		displayOptions: { show: { resource: ['sdlQuery'], operation: ['execute'] } },
		description: 'Start of the query time range',
	},
	{
		displayName: 'End Time',
		name: 'endTime',
		type: 'dateTime',
		default: '',
		required: true,
		displayOptions: { show: { resource: ['sdlQuery'], operation: ['execute'] } },
		description: 'End of the query time range',
	},
	{
		displayName: 'Query Scope',
		name: 'queryScope',
		type: 'options',
		noDataExpression: true,
		default: 'tenant',
		required: true,
		displayOptions: { show: { resource: ['sdlQuery'], operation: ['execute'] } },
		options: [
			{ name: 'Entire Tenant', value: 'tenant' },
			{ name: 'Selected Accounts', value: 'accounts' },
		],
		description: 'Tenant or account boundary sent to SDL',
	},
	{
		displayName: 'Account Names or IDs',
		name: 'accountIds',
		type: 'multiOptions',
		default: [],
		required: true,
		typeOptions: { loadOptionsMethod: 'getAccounts' },
		displayOptions: {
			show: { resource: ['sdlQuery'], operation: ['execute'], queryScope: ['accounts'] },
		},
		description:
			'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
	},
	{
		displayName: 'Output Mode',
		name: 'outputMode',
		type: 'options',
		noDataExpression: true,
		default: 'rows',
		required: true,
		displayOptions: { show: { resource: ['sdlQuery'], operation: ['execute'] } },
		options: [
			{ name: 'Rows', value: 'rows' },
			{ name: 'Table', value: 'table' },
		],
		description:
			'Rows emits one item per row, or a metadata-only item when no rows are returned. Table emits one item containing columns, values, and metadata.',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { resource: ['sdlQuery'], operation: ['execute'] } },
		options: [
			{
				displayName: 'Maximum Output Size (MiB)',
				name: 'maxResponseSizeMiB',
				type: 'number',
				default: 10,
				typeOptions: { minValue: 1, maxValue: 50 },
				description:
					'Maximum size of each received response and the emitted output. Oversized responses fail; output rows are truncated to fit.',
			},
			{
				displayName: 'Maximum Rows',
				name: 'maxRows',
				type: 'number',
				default: 5000,
				typeOptions: { minValue: 1, maxValue: 100000 },
				description: 'Maximum number of SDL result rows to emit',
			},
			{
				displayName: 'Poll Interval (Milliseconds)',
				name: 'pollIntervalMs',
				type: 'number',
				default: 1500,
				typeOptions: { minValue: 1000, maxValue: 10000 },
				description: 'Delay between successful SDL status checks',
			},
			{
				displayName: 'Timeout (Seconds)',
				name: 'timeoutSeconds',
				type: 'number',
				default: 100,
				typeOptions: { minValue: 10, maxValue: 300 },
				description: 'Maximum time for the SDL query lifecycle, excluding final cleanup',
			},
		],
	},
];
