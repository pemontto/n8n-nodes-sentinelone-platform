import type { IDataObject, IHttpRequestOptions } from 'n8n-workflow';
import type { ScopeType } from '../shared/Scopes';
import { alertFieldSelection, additionalAlertOutput } from '../shared/AlertFields';
import type { ActivityCondition } from './ActivityConditions';
import { PollBudgetError } from '../shared/transport/request';

export type TriggerEvent = 'alert.new' | 'alert.updated' | 'alert.activity';
export type PollMode = 'manual' | 'scheduled';

export const MAX_SEEN_ALERT_IDS = 20_000;
export const MAX_SEEN_ALERT_VERSIONS = 40_000;
export const MANUAL_RESULT_LIMIT = 10;
export const MAX_SCOPE_IDS_PER_QUERY = 500;
/** Alerts sharing one timestamp are excluded by ID when that timestamp is read again; more than this fails visibly. */
export const MAX_TIE_IDS = 5_000;
const MAX_RESUME_EXCLUSION_IDS = 1_000;

import { compileExclusions, matchesExclusion, type ExclusionPatterns } from './Exclusions';

export interface TriggerConfig extends ExclusionPatterns {
	baseUrl: string;
	credentialIdentity: IDataObject;
	scopeType: ScopeType;
	scopeIds: string[];
	activityAccountIds?: string[];
	activityTypeIds?: string[];
	activityConditions?: ActivityCondition[];
	conditionMatch?: 'any' | 'all';
	includeRawActivity?: boolean;
	includeCurrentAlert?: boolean;
	allVisibleAccounts: boolean;
	events: TriggerEvent[];
	severities: string[];
	statuses: string[];
	alertName: string;
	advancedFilters?: unknown;
	simplifyOutput: boolean;
	additionalAlertFields?: string[];
	debug: boolean;
	debugLog?: (message: string, details?: IDataObject) => void;
	warnLog?: (message: string, details?: IDataObject) => void;
	overlapSeconds: number;
	concurrentRequests: number;
	requestTimeoutMs: number;
	alertPageSize: number;
	maxAlertPages: number;
	/** Absolute epoch time at which the n8n poll budget runs out. The transport enforces it; poll helpers only reserve time for steps that follow a read. */
	pollDeadlineMs?: number;
}

/** Per stream and scope batch: the latest completed timestamp, its processed IDs, and the exact position and IDs for an interrupted overlap read. */
export interface AlertCursor extends IDataObject {
	throughMs: number;
	ids: string[];
	resumeMs?: number;
	resumeIds?: string[];
	/** Lower edge of a resumed New overlap scan, retained so later budget stops continue from resumeMs. */
	resumeOverlapStartMs?: number;
}

export interface TriggerState extends IDataObject {
	configFingerprint?: string;
	initialized?: boolean;
	/** The earliest cursor; kept for diagnostics and for state saved before per-unit cursors existed. */
	checkpointMs?: number;
	/** Poll start of the first scheduled poll; alerts created or updated before it are recorded, never emitted. */
	activationMs?: number;
	alertCursors?: Record<string, AlertCursor>;
	/** Seen alert IDs, each followed by a NUL and its creation time so resumed and overlap reads do not repeat deliveries. */
	seenAlertIds?: string[];
	seenAlertVersions?: string[];
	/** Consecutive budget stops with no cursor progress, keyed by stream and scope batch. */
	stalledAlertPolls?: Record<string, number>;
	seenActivityIds?: string[];
	activityActivationMs?: number;
}

export interface PollResult {
	items: IDataObject[];
	nextState?: TriggerState;
}

export type AuthenticatedRequest = (options: IHttpRequestOptions) => Promise<unknown>;

interface Alert extends IDataObject {
	id: string;
	createdAt?: string | null;
	updatedAt?: string | null;
	noteExists?: boolean | null;
}

interface PageInfo {
	hasNextPage: boolean;
	endCursor?: string | null;
}

interface AlertPage {
	edges?: Array<{ node?: Alert | null } | null> | null;
	pageInfo?: PageInfo | null;
}

interface GraphQlEnvelope {
	data?: {
		alerts?: AlertPage | null;
	} | null;
	errors?: Array<{ message?: string }> | null;
}

const ALERTS_QUERY = `
query PollAlerts($first: Int!, $after: String, $scope: ScopeSelectorInput!, $filters: [FilterInput!], $orFilter: OrFilterSelectionInput, $sortBy: String!, $sortOrder: SortOrderType!) {
  alerts(first: $first, after: $after, scope: $scope, viewType: ALL, sort: { by: $sortBy, order: $sortOrder }, filters: $filters, orFilter: $orFilter) {
    edges {
      node {
        id
        externalId
        name
        severity
        status
        createdAt
        updatedAt
        detectedAt
        firstSeenAt
        lastSeenAt
        noteExists
			realTime {
			  scope {
			    account { id name }
			    site { id name }
			    group { id name }
			  }
			}
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

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
		throw new Error(`Unknown advanced filter key: ${unknownKeys.join(', ')}.`);
	const fieldId = typeof filter.fieldId === 'string' ? filter.fieldId.trim() : '';
	if (!fieldId) throw new Error('Each advanced filter needs a non-empty fieldId.');
	if (filter.isNegated !== undefined && typeof filter.isNegated !== 'boolean')
		throw new Error('Advanced filter isNegated must be true or false.');
	const comparators = FILTER_COMPARATORS.filter((key) => filter[key] !== undefined);
	if (comparators.length !== 1)
		throw new Error(`Advanced filter ${fieldId} must use exactly one comparator.`);
	const comparator = asRecord(filter[comparators[0]]);
	if (!comparator) throw new Error(`Advanced filter ${fieldId} comparator must be an object.`);
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

export function advancedFilterSelection(
	baseFilters: IDataObject[],
	input: unknown,
): FilterSelection {
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
		if (value.length > 100) throw new Error('Advanced Filters supports at most 100 filters.');
		return { filters: [...baseFilters, ...value.map(validateRawFilter)], orFilter: null };
	}
	const selection = asRecord(value);
	if (!selection || Object.keys(selection).length !== 1 || !Array.isArray(selection.or))
		throw new Error('Advanced Filters must be a FilterInput array or an object containing or.');
	if (selection.or.length === 0 || selection.or.length > 20)
		throw new Error('Advanced Filters or must contain from 1 to 20 groups.');
	const groups = selection.or.map((value) => {
		const group = asRecord(value);
		if (!group || Object.keys(group).length !== 1 || !Array.isArray(group.and))
			throw new Error('Each Advanced Filters or group must contain an and array.');
		if (group.and.length > 100)
			throw new Error('Each Advanced Filters and group supports at most 100 filters.');
		return { and: [...baseFilters, ...group.and.map(validateRawFilter)] };
	});
	return { filters: null, orFilter: { or: groups } };
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	const record = value as IDataObject;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
		.join(',')}}`;
}

function simpleHash(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16);
}

function debugLog(config: TriggerConfig, message: string, details: IDataObject = {}): void {
	if (!config.debug) return;
	try {
		config.debugLog?.(message, details);
	} catch {
		// Diagnostic logging must never affect polling or checkpoint advancement.
	}
}

function warnLog(config: TriggerConfig, message: string, details: IDataObject = {}): void {
	try {
		config.warnLog?.(message, details);
	} catch {
		// Diagnostic logging must never affect polling or checkpoint advancement.
	}
}

async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return [];
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	let stopped = false;
	let firstFailure: unknown;
	let budgetFailure: PollBudgetError | undefined;
	const requestedConcurrency = Number.isFinite(concurrency) ? Math.trunc(concurrency) : 1;
	const workerCount = Math.max(1, Math.min(requestedConcurrency, items.length));
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (!stopped && nextIndex < items.length) {
				const currentIndex = nextIndex++;
				try {
					results[currentIndex] = await worker(items[currentIndex], currentIndex);
				} catch (error) {
					stopped = true;
					// A permanent failure outranks a budget stop, so denied access is never reported as a partial delivery.
					if (error instanceof PollBudgetError) budgetFailure ??= error;
					else firstFailure ??= error;
				}
			}
		}),
	);
	if (firstFailure !== undefined) {
		throw firstFailure;
	}
	if (budgetFailure) throw budgetFailure;
	return results;
}

export function fingerprintConfig(config: TriggerConfig): string {
	return simpleHash(
		stableStringify({
			baseUrl: config.baseUrl,
			credentialIdentity: {
				type: config.credentialIdentity.type ?? null,
				id: config.credentialIdentity.id ?? null,
			},
			scopeType: config.scopeType,
			scopeSelection: config.allVisibleAccounts ? 'allVisibleAccounts' : 'explicit',
			scopeIds: config.allVisibleAccounts ? [] : [...config.scopeIds].sort(),
			events: [...config.events].sort(),
			severities: [...config.severities].sort(),
			statuses: [...config.statuses].sort(),
			alertName: config.alertName.trim(),
			advancedFilters: advancedFilterSelection([], config.advancedFilters),
			excludeAccountName: config.excludeAccountName ?? '',
			excludeSiteName: config.excludeSiteName ?? '',
			excludeGroupName: config.excludeGroupName ?? '',
			...(config.events.includes('alert.activity')
				? {
						activity: {
							types: config.activityTypeIds ? [...config.activityTypeIds].sort() : null,
							conditions: config.activityConditions ?? [],
							match: config.conditionMatch ?? 'any',
							excludeActorName: config.excludeActorName ?? '',
							excludeActorIds: [...(config.excludeActorIds ?? [])].sort(),
							detection: 'activityFeed-v2-once-per-id',
						},
					}
				: { excludeNoteAuthorName: '', noteDetection: null }),
		}),
	);
}

function assertStateCapacity(values: string[], limit: number, label: string): void {
	const uniqueCount = new Set(values).size;
	if (uniqueCount <= limit) return;
	throw new Error(
		`The poll found ${uniqueCount} ${label}, which exceeds the safe state limit of ${limit}. Narrow the scope or filters so the overlap fits; state was not advanced.`,
	);
}

function requireRelayCursor(
	pageInfo: PageInfo,
	seenCursors: Set<string>,
	label: string,
): string | undefined {
	if (!pageInfo.hasNextPage) return undefined;
	const cursor = pageInfo.endCursor?.trim();
	if (!cursor) {
		throw new Error(
			`${label} returned more pages without a continuation cursor. Try again after SentinelOne is available.`,
		);
	}
	if (seenCursors.has(cursor)) {
		throw new Error(
			`${label} repeated a continuation cursor. Try again after SentinelOne is available.`,
		);
	}
	seenCursors.add(cursor);
	return cursor;
}

function graphQlData(response: unknown): NonNullable<GraphQlEnvelope['data']> {
	const envelope = (asRecord(response) ?? {}) as GraphQlEnvelope;
	if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
		throw new Error(
			'SentinelOne rejected the Unified Alerts query. Check credential permissions, the tenant schema, and selected filters. Enable Debug to inspect the redacted request.',
		);
	}
	if (!envelope.data) {
		throw new Error(
			'SentinelOne returned no Unified Alerts data. Check the tenant URL and try again.',
		);
	}
	return envelope.data;
}

function buildFilters(
	config: TriggerConfig,
	fieldId: 'createdAt' | 'updatedAt',
	start: number,
	end: number,
	excludeIds: string[] = [],
): IDataObject[] {
	const filters: IDataObject[] = [
		{
			fieldId,
			dateTimeRange: { start, startInclusive: true, end, endInclusive: true },
		},
	];
	if (config.severities.length > 0) {
		filters.push({ fieldId: 'severity', stringIn: { values: config.severities } });
	}
	if (config.statuses.length > 0) {
		filters.push({ fieldId: 'status', stringIn: { values: config.statuses } });
	}
	if (config.alertName.trim()) {
		filters.push({ fieldId: 'alertName', match: { values: [config.alertName.trim()] } });
	}
	if (excludeIds.length > 0) {
		filters.push({ fieldId: 'id', isNegated: true, stringIn: { values: excludeIds } });
	}
	return filters;
}

interface AlertPageRead {
	/** Every validated alert on the page, in the order the API returned them. */
	nodes: Alert[];
	/** The nodes that pass the name exclusions. */
	kept: Alert[];
	pageInfo: PageInfo;
}

async function requestAlertPage(
	request: AuthenticatedRequest,
	config: TriggerConfig,
	fieldId: 'createdAt' | 'updatedAt',
	start: number,
	end: number,
	first: number,
	after: string | undefined,
	sortOrder: 'ASC' | 'DESC',
	excludeIds: string[],
): Promise<AlertPageRead> {
	const exclusions = compileExclusions(config);
	const selection = advancedFilterSelection(
		buildFilters(config, fieldId, start, end, excludeIds),
		config.advancedFilters,
	);
	const response = await request({
		method: 'POST',
		url: `${config.baseUrl}/web/api/v2.1/unifiedalerts/graphql`,
		timeout: config.requestTimeoutMs,
		body: {
			query: ALERTS_QUERY.replace(
				'        id',
				`        ${alertFieldSelection(config.additionalAlertFields)}\n        id`,
			),
			variables: {
				first,
				after: after ?? null,
				scope: { scopeType: config.scopeType, scopeIds: config.scopeIds },
				filters: selection.filters,
				orFilter: selection.orFilter,
				sortBy: fieldId,
				sortOrder,
			},
		},
		json: true,
	});
	const connection = graphQlData(response).alerts;
	if (
		!connection?.pageInfo ||
		typeof connection.pageInfo.hasNextPage !== 'boolean' ||
		!Array.isArray(connection.edges)
	) {
		throw new Error(
			`SentinelOne returned an incomplete ${fieldId} alert page. Try again after the service is available.`,
		);
	}
	const nodes: Alert[] = [];
	const kept: Alert[] = [];
	for (const edge of connection.edges) {
		const alert = edge?.node;
		if (!alert?.id) {
			throw new Error(`SentinelOne returned a ${fieldId} alert without an ID.`);
		}
		if (typeof alert[fieldId] !== 'string' || Number.isNaN(Date.parse(String(alert[fieldId])))) {
			throw new Error(
				`SentinelOne returned alert ${alert.id} without a usable ${fieldId} timestamp; state was not advanced.`,
			);
		}
		nodes.push(alert);
		const scope = asRecord(asRecord(alert.realTime)?.scope);
		if (
			matchesExclusion(exclusions.account, asRecord(scope?.account)?.name) ||
			matchesExclusion(exclusions.site, asRecord(scope?.site)?.name) ||
			matchesExclusion(exclusions.group, asRecord(scope?.group)?.name)
		)
			continue;
		kept.push(alert);
	}
	return { nodes, kept, pageInfo: connection.pageInfo };
}

/** Newest-first read for manual previews: stops at the result limit and splits dense ranges at the page cap. */
async function fetchAlertsNewestFirst(
	request: AuthenticatedRequest,
	config: TriggerConfig,
	fieldId: 'createdAt' | 'updatedAt',
	start: number,
	end: number,
	maxItems: number,
	splitDepth = 0,
	excludeUpdatedIds?: ReadonlySet<string>,
): Promise<Alert[]> {
	const alerts: Alert[] = [];
	const seenCursors = new Set<string>();
	let after: string | undefined;
	for (let pageNumber = 1; pageNumber <= config.maxAlertPages; pageNumber++) {
		const remaining = maxItems - alerts.length;
		if (remaining <= 0) return alerts.slice(0, maxItems);
		const page = await requestAlertPage(
			request,
			config,
			fieldId,
			start,
			end,
			Math.min(config.alertPageSize, remaining),
			after,
			'DESC',
			[],
		);
		for (const alert of page.kept) {
			if (
				fieldId === 'updatedAt' &&
				config.events.length === 1 &&
				config.events[0] === 'alert.updated' &&
				timeValue(alert.updatedAt) <= timeValue(alert.createdAt)
			)
				continue;
			if (fieldId === 'updatedAt' && excludeUpdatedIds?.has(alert.id)) continue;
			alerts.push(alert);
		}
		if (alerts.length >= maxItems) {
			return alerts.slice(0, maxItems);
		}
		const nextCursor = requireRelayCursor(page.pageInfo, seenCursors, `${fieldId} alert query`);
		if (!nextCursor) return alerts;
		after = nextCursor;
	}
	const rangeWidth = end - start;
	if (splitDepth < 48 && rangeWidth >= 1) {
		const midpoint = Math.floor(start + rangeWidth / 2);
		if (midpoint >= start && midpoint < end) {
			debugLog(config, 'Splitting dense alert time range', {
				fieldId,
				splitDepth,
				rangeWidthMs: rangeWidth,
			});
			const newer = await fetchAlertsNewestFirst(
				request,
				config,
				fieldId,
				midpoint + 1,
				end,
				maxItems,
				splitDepth + 1,
				excludeUpdatedIds,
			);
			if (newer.length >= maxItems) return newer.slice(0, maxItems);
			const older = await fetchAlertsNewestFirst(
				request,
				config,
				fieldId,
				start,
				midpoint,
				maxItems - newer.length,
				splitDepth + 1,
				excludeUpdatedIds,
			);
			return [...newer, ...older];
		}
	}
	throw new Error(
		`The ${fieldId} alert query exceeded the configured page limit inside an indivisible time range. Narrow the scope or filters; state was not advanced.`,
	);
}

/** Scope batches in a stable order, so a batch keeps its cursor while its membership is unchanged. */
function scopeBatches(config: TriggerConfig): string[][] {
	const sorted = [...config.scopeIds].sort();
	const chunks: string[][] = [];
	for (let index = 0; index < sorted.length; index += MAX_SCOPE_IDS_PER_QUERY) {
		chunks.push(sorted.slice(index, index + MAX_SCOPE_IDS_PER_QUERY));
	}
	return chunks;
}

async function fetchManualAlertStreams(
	request: AuthenticatedRequest,
	config: TriggerConfig,
	updatedNeeded: boolean,
	end: number,
	maxItems: number,
): Promise<{ createdAlerts: Alert[]; updatedAlerts: Alert[] }> {
	const chunks = scopeBatches(config);
	if (config.events.includes('alert.new') && config.events.includes('alert.updated')) {
		// Classify preview creations first so they do not consume the update result limit.
		const createdAlerts = (
			await mapWithConcurrency(
				chunks,
				Math.min(config.concurrentRequests, 5),
				async (scopeIds) =>
					await fetchAlertsNewestFirst(
						request,
						{ ...config, scopeIds },
						'createdAt',
						0,
						end,
						maxItems,
					),
			)
		).flat();
		const newIds = new Set(createdAlerts.map((alert) => alert.id));
		const updatedAlerts = (
			await mapWithConcurrency(
				chunks,
				Math.min(config.concurrentRequests, 5),
				async (scopeIds) =>
					await fetchAlertsNewestFirst(
						request,
						{ ...config, scopeIds },
						'updatedAt',
						0,
						end,
						maxItems,
						0,
						newIds,
					),
			)
		).flat();
		return { createdAlerts, updatedAlerts };
	}
	const batchResults = await mapWithConcurrency(
		chunks,
		Math.min(config.concurrentRequests, 5),
		async (scopeIds) => {
			const scopedConfig = { ...config, scopeIds };
			const [createdAlerts, updatedAlerts] = await Promise.all([
				fetchAlertsNewestFirst(request, scopedConfig, 'createdAt', 0, end, maxItems),
				updatedNeeded
					? fetchAlertsNewestFirst(request, scopedConfig, 'updatedAt', 0, end, maxItems)
					: Promise.resolve<Alert[]>([]),
			]);
			return { createdAlerts, updatedAlerts };
		},
	);
	return {
		createdAlerts: batchResults.flatMap((result) => result.createdAlerts),
		updatedAlerts: batchResults.flatMap((result) => result.updatedAlerts),
	};
}

/** One oldest-first read of a stream for one scope batch. */
interface UnitRead {
	/** Alerts that pass the name exclusions. */
	alerts: Alert[];
	/** Every alert fetched, for the tie set at the boundary. */
	fetched: Alert[];
	/** The range end when complete, otherwise the last timestamp fetched (below the range start when nothing was). */
	throughMs: number;
	complete: boolean;
	stopped?: Error;
}

interface SeenCapacity {
	alertIds: Set<string>;
	versions: Set<string>;
}

function reserveSeenCapacity(
	capacity: SeenCapacity | undefined,
	fieldId: 'createdAt' | 'updatedAt',
	alert: Alert,
	needsNew: boolean,
	needsUpdated: boolean,
	previousAlertIds: ReadonlySet<string>,
	activationMs: number,
): boolean {
	if (!capacity) return true;
	if (fieldId === 'createdAt') {
		const addId = !capacity.alertIds.has(alert.id);
		const version =
			needsNew &&
			needsUpdated &&
			timeValue(alert.createdAt) >= activationMs &&
			!previousAlertIds.has(alert.id) &&
			alert.updatedAt
				? `${alert.id}\u0000${alert.updatedAt}`
				: undefined;
		const addVersion = version !== undefined && !capacity.versions.has(version);
		if (addId && capacity.alertIds.size >= MAX_SEEN_ALERT_IDS) return false;
		if (addVersion && capacity.versions.size >= MAX_SEEN_ALERT_VERSIONS) return false;
		if (addId) capacity.alertIds.add(alert.id);
		if (version !== undefined && addVersion) {
			capacity.versions.add(version);
		}
		return true;
	}
	if (!alert.updatedAt) return true;
	const version = `${alert.id}\u0000${alert.updatedAt}`;
	if (capacity.versions.has(version)) return true;
	if (capacity.versions.size >= MAX_SEEN_ALERT_VERSIONS) return false;
	capacity.versions.add(version);
	return true;
}

/**
 * Reads a scheduled range and hands over every page read. Budgeted CreatedAt pages are sorted before cursor handoff because late rows can shift page boundaries; descending rows within a page remain an error.
 * Without a budget it requests, pages and splits dense ranges exactly as hosts without a budget always did.
 */
async function readAlertsOldestFirst(
	request: AuthenticatedRequest,
	config: TriggerConfig,
	fieldId: 'createdAt' | 'updatedAt',
	start: number,
	end: number,
	excludeIds: string[],
	splitDepth = 0,
	capacity?: SeenCapacity,
	needsNew = false,
	needsUpdated = false,
	previousAlertIds: ReadonlySet<string> = new Set(),
	activationMs = 0,
): Promise<UnitRead> {
	const budgeted = config.pollDeadlineMs !== undefined;
	const alerts: Alert[] = [];
	const fetched: Alert[] = [];
	const seenCursors = new Set<string>();
	let after: string | undefined;
	let previousMs: number | undefined;
	const finish = (complete: boolean, stopped?: Error): UnitRead => {
		const orderedFetched =
			budgeted && fieldId === 'createdAt'
				? [...fetched].sort(
						(left, right) =>
							timeValue(left.createdAt) - timeValue(right.createdAt) ||
							left.id.localeCompare(right.id),
					)
				: fetched;
		const orderedAlerts =
			budgeted && fieldId === 'createdAt'
				? [...alerts].sort(
						(left, right) =>
							timeValue(left.createdAt) - timeValue(right.createdAt) ||
							left.id.localeCompare(right.id),
					)
				: alerts;
		const throughMs = complete
			? end
			: orderedFetched.length
				? timeValue(orderedFetched[orderedFetched.length - 1][fieldId])
				: start - 1;
		debugLog(config, 'Read Unified Alerts range', {
			fieldId,
			start,
			end,
			throughMs,
			fetchedCount: fetched.length,
			complete,
			scopeCount: config.scopeIds.length,
			excludedIdCount: excludeIds.length,
		});
		return { alerts: orderedAlerts, fetched: orderedFetched, throughMs, complete, stopped };
	};
	for (let pageNumber = 1; budgeted || pageNumber <= config.maxAlertPages; pageNumber++) {
		let page: AlertPageRead;
		try {
			page = await requestAlertPage(
				request,
				config,
				fieldId,
				start,
				end,
				config.alertPageSize,
				after,
				budgeted ? 'ASC' : 'DESC',
				excludeIds,
			);
		} catch (error) {
			if (error instanceof PollBudgetError) return finish(false, error);
			// The trigger boundary wraps these failures with its node context.
			// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
			throw error;
		}
		const keptIds = new Set(page.kept.map((alert) => alert.id));
		let pagePreviousMs: number | undefined;
		let capacityStopped = false;
		for (const alert of page.nodes) {
			const ms = timeValue(alert[fieldId]);
			if (ms < start || ms > end) continue;
			if (budgeted && pagePreviousMs !== undefined && ms < pagePreviousMs)
				throw new Error(
					`SentinelOne returned ${fieldId} alerts out of ascending order at ${new Date(ms).toISOString()}; state was not advanced.`,
				);
			if (budgeted && fieldId === 'updatedAt' && previousMs !== undefined && ms < previousMs)
				throw new Error(
					`SentinelOne returned ${fieldId} alerts out of ascending order at ${new Date(ms).toISOString()}; state was not advanced.`,
				);
			if (
				keptIds.has(alert.id) &&
				!reserveSeenCapacity(
					capacity,
					fieldId,
					alert,
					needsNew,
					needsUpdated,
					previousAlertIds,
					activationMs,
				)
			) {
				capacityStopped = true;
				break;
			}
			previousMs = ms;
			pagePreviousMs = ms;
			fetched.push(alert);
			if (keptIds.has(alert.id)) alerts.push(alert);
		}
		if (capacityStopped)
			return finish(
				false,
				new Error(
					'The alert state reached its safe capacity before the range ended. Narrow the scope or filters so the overlap fits.',
				),
			);
		const nextCursor = requireRelayCursor(page.pageInfo, seenCursors, `${fieldId} alert query`);
		if (!nextCursor) return finish(true);
		after = nextCursor;
	}
	const rangeWidth = end - start;
	if (splitDepth < 48 && rangeWidth >= 1) {
		const midpoint = Math.floor(start + rangeWidth / 2);
		if (midpoint >= start && midpoint < end) {
			const halves = [
				await readAlertsOldestFirst(
					request,
					config,
					fieldId,
					midpoint + 1,
					end,
					excludeIds,
					splitDepth + 1,
					capacity,
					needsNew,
					needsUpdated,
					previousAlertIds,
					activationMs,
				),
				await readAlertsOldestFirst(
					request,
					config,
					fieldId,
					start,
					midpoint,
					excludeIds,
					splitDepth + 1,
					capacity,
					needsNew,
					needsUpdated,
					previousAlertIds,
					activationMs,
				),
			];
			return {
				alerts: halves.flatMap((half) => half.alerts),
				fetched: halves.flatMap((half) => half.fetched),
				throughMs: end,
				complete: true,
			};
		}
	}
	throw new Error(
		`The ${fieldId} alert query exceeded the configured page limit inside an indivisible time range. Narrow the scope or filters; state was not advanced.`,
	);
}

function timeValue(value: unknown): number {
	const parsed = Date.parse(String(value ?? ''));
	return Number.isNaN(parsed) ? 0 : parsed;
}

function sortOutputs(items: IDataObject[]): IDataObject[] {
	return items.sort((left, right) => {
		const timeDifference = timeValue(left.eventTimestamp) - timeValue(right.eventTimestamp);
		if (timeDifference !== 0) return timeDifference;
		return stableStringify(left).localeCompare(stableStringify(right));
	});
}

function scopeEntity(value: unknown): IDataObject | null {
	const record = asRecord(value);
	if (!record) return null;
	return {
		id: record.id === undefined || record.id === null ? null : String(record.id),
		name: record.name === undefined || record.name === null ? null : String(record.name),
	};
}

function alertScopeContext(config: TriggerConfig, alert: Alert): IDataObject {
	const realTime = asRecord(alert.realTime);
	const apiScope = asRecord(realTime?.scope);
	const account = scopeEntity(apiScope?.account);
	const site = scopeEntity(apiScope?.site);
	const group = scopeEntity(apiScope?.group);
	const selectedEntity =
		config.scopeType === 'GROUP' ? group : config.scopeType === 'SITE' ? site : account;
	return {
		type: config.scopeType,
		id: selectedEntity?.id ?? null,
		name: selectedEntity?.name ?? null,
		account,
		site,
		group,
	};
}

function alertOutput(
	config: TriggerConfig,
	eventType: 'alert.new' | 'alert.updated',
	alert: Alert,
): IDataObject {
	const eventTimestamp =
		eventType === 'alert.new'
			? (alert.createdAt ?? alert.updatedAt ?? '')
			: (alert.updatedAt ?? alert.createdAt ?? '');
	const scope = alertScopeContext(config, alert);
	if (config.simplifyOutput) {
		return {
			eventType,
			eventTimestamp,
			scope,
			...additionalAlertOutput(config.additionalAlertFields, alert),
			alertId: alert.id,
			externalId: alert.externalId ?? null,
			name: alert.name ?? null,
			severity: alert.severity ?? null,
			status: alert.status ?? null,
			createdAt: alert.createdAt ?? null,
			updatedAt: alert.updatedAt ?? null,
			detectedAt: alert.detectedAt ?? null,
			firstSeenAt: alert.firstSeenAt ?? null,
			lastSeenAt: alert.lastSeenAt ?? null,
			noteExists: alert.noteExists ?? null,
		};
	}
	return {
		eventType,
		eventTimestamp,
		scope,
		alert,
	};
}

function unionById(alerts: Alert[]): Alert[] {
	const byId = new Map<string, Alert>();
	for (const alert of alerts) {
		const current = byId.get(alert.id);
		if (!current || timeValue(alert.updatedAt) > timeValue(current.updatedAt))
			byId.set(alert.id, alert);
	}
	return [...byId.values()];
}

function sortAlertsBy(alerts: Alert[], fieldId: 'createdAt' | 'updatedAt'): Alert[] {
	return alerts.sort((left, right) => {
		const difference = timeValue(left[fieldId]) - timeValue(right[fieldId]);
		if (difference !== 0) return difference;
		return left.id.localeCompare(right.id);
	});
}

/** One fetched alert's place in a poll: what it records and, when emitted, its output item. */
interface AlertRecord {
	fieldId: 'createdAt' | 'updatedAt';
	alertId: string;
	timeMs: number;
	seenId?: string;
	version?: string;
	item?: IDataObject;
}

function classifyAlerts(
	config: TriggerConfig,
	mode: PollMode,
	previousAlertIds: ReadonlySet<string>,
	previousVersions: ReadonlySet<string>,
	createdAlerts: Alert[],
	updatedAlerts: Alert[],
	activationMs: number,
): AlertRecord[] {
	const needsNew = config.events.includes('alert.new');
	const needsUpdated = config.events.includes('alert.updated');
	const records: AlertRecord[] = [];
	const emittedAsNew = new Set<string>();
	const latestAlertById = new Map(
		unionById([...createdAlerts, ...updatedAlerts]).map((alert) => [alert.id, alert]),
	);
	for (const alert of sortAlertsBy(unionById(createdAlerts), 'createdAt')) {
		const scopeId = alertScopeContext(config, alert).id;
		const record: AlertRecord = {
			fieldId: 'createdAt',
			alertId: alert.id,
			timeMs: timeValue(alert.createdAt),
			seenId: seenEntry(
				alert.id,
				String(alert.createdAt),
				typeof scopeId === 'string' ? scopeId : undefined,
			),
		};
		// Alerts created before activation are recorded, never replayed as new.
		if (needsNew && record.timeMs >= activationMs && !previousAlertIds.has(alert.id)) {
			const emitted = latestAlertById.get(alert.id) ?? alert;
			record.item = alertOutput(config, 'alert.new', emitted);
			emittedAsNew.add(alert.id);
			// The emitted state is the delivered version, so a later poll does not repeat it as an update.
			if (needsUpdated && emitted.updatedAt)
				record.version = `${emitted.id}\u0000${emitted.updatedAt}`;
		}
		records.push(record);
	}
	if (needsUpdated) {
		for (const alert of sortAlertsBy(unionById(updatedAlerts), 'updatedAt')) {
			if (!alert.updatedAt) continue;
			const version = `${alert.id}\u0000${alert.updatedAt}`;
			const record: AlertRecord = {
				fieldId: 'updatedAt',
				alertId: alert.id,
				timeMs: timeValue(alert.updatedAt),
				version,
			};
			// Only a revision counts as an update, and an alert already emitted as new in this poll is not emitted twice.
			const isRevision = timeValue(alert.updatedAt) > timeValue(alert.createdAt);
			if (
				record.timeMs >= activationMs &&
				isRevision &&
				!emittedAsNew.has(alert.id) &&
				!previousVersions.has(version)
			) {
				record.item = alertOutput(config, 'alert.updated', alert);
			}
			records.push(record);
		}
	}
	return records.sort((left, right) => {
		const difference = left.timeMs - right.timeMs;
		if (difference !== 0) return difference;
		return stableStringify(left.item ?? left.alertId).localeCompare(
			stableStringify(right.item ?? right.alertId),
		);
	});
}

function readCursor(value: unknown, key: string, budgeted: boolean): AlertCursor | undefined {
	if (value === undefined) return undefined;
	const cursor = asRecord(value);
	if (
		!cursor ||
		typeof cursor.throughMs !== 'number' ||
		!Number.isFinite(cursor.throughMs) ||
		!Array.isArray(cursor.ids) ||
		cursor.ids.some((id) => typeof id !== 'string') ||
		(cursor.resumeMs !== undefined && typeof cursor.resumeMs !== 'number') ||
		(budgeted &&
			cursor.resumeOverlapStartMs !== undefined &&
			(typeof cursor.resumeOverlapStartMs !== 'number' ||
				!Number.isFinite(cursor.resumeOverlapStartMs))) ||
		(cursor.resumeIds !== undefined &&
			(!Array.isArray(cursor.resumeIds) || cursor.resumeIds.some((id) => typeof id !== 'string')))
	)
		throw new Error(`The saved alert cursor ${key} is invalid; state was not advanced.`);
	return {
		throughMs: cursor.throughMs,
		ids: cursor.ids as string[],
		...(typeof cursor.resumeMs === 'number' ? { resumeMs: cursor.resumeMs } : {}),
		...(Array.isArray(cursor.resumeIds) ? { resumeIds: cursor.resumeIds as string[] } : {}),
		...(budgeted && typeof cursor.resumeOverlapStartMs === 'number'
			? { resumeOverlapStartMs: cursor.resumeOverlapStartMs }
			: {}),
	};
}

/** Keeps the entries still inside a replay window, oldest first; entries with no known time retire first when the limit is reached, and a window that needs more than the limit fails visibly. */
function retainSeen(
	previous: string[],
	current: string[],
	timeOf: (entry: string) => number | undefined,
	retireBeforeMs: number,
	limit: number,
	label: string,
): string[] {
	const ordered = new Map<string, true>();
	for (const entry of [...previous, ...current]) {
		ordered.delete(entry);
		ordered.set(entry, true);
	}
	const entries = [...ordered.keys()].filter((entry) => {
		const time = timeOf(entry);
		return time === undefined || time >= retireBeforeMs;
	});
	const timeless = entries.filter((entry) => timeOf(entry) === undefined);
	const excess = entries.length - limit;
	if (excess > timeless.length)
		throw new Error(
			`The overlap window holds ${entries.length - timeless.length} ${label}, which exceeds the safe state limit of ${limit}. Narrow the scope or filters so the overlap fits; state was not advanced.`,
		);
	if (excess <= 0) return entries;
	const retire = new Set(timeless.slice(0, excess));
	return entries.filter((entry) => !retire.has(entry));
}

interface Unit {
	key: string;
	fieldId: 'createdAt' | 'updatedAt';
	scopeIds: string[];
	batchNumber: number;
	previous?: AlertCursor;
	start: number;
	resumeOverlapStartMs?: number;
	read?: UnitRead;
	next?: AlertCursor;
}

function cursorPositionChanged(
	previous: AlertCursor | undefined,
	next: AlertCursor | undefined,
): boolean {
	if (!next) return false;
	if (!previous) return true;
	return (
		next.throughMs !== previous.throughMs ||
		next.ids.length !== previous.ids.length ||
		next.ids.some((id, index) => id !== previous.ids[index]) ||
		next.resumeMs !== previous.resumeMs ||
		next.resumeOverlapStartMs !== previous.resumeOverlapStartMs ||
		next.resumeIds?.length !== previous.resumeIds?.length ||
		!!next.resumeIds?.some((id, index) => id !== previous.resumeIds?.[index])
	);
}

/** Reads a unit from its resume point or overlap start. CreatedAt is immutable, so its exact IDs are safe to exclude across the whole range; updatedAt keeps timestamp segments so later revisions remain visible. */
async function readUnit(
	request: AuthenticatedRequest,
	config: TriggerConfig,
	unit: Unit,
	end: number,
	capacity?: SeenCapacity,
	previousAlertIds: ReadonlySet<string> = new Set(),
	activationMs = 0,
	previousSeenEntries: readonly string[] = [],
): Promise<UnitRead> {
	const tie = unit.previous;
	let segments: Array<[number, number, string[]]>;
	if (unit.fieldId === 'createdAt' && config.pollDeadlineMs !== undefined) {
		const overlapEnd = tie ? Math.min(end, tie.throughMs) : end;
		const overlapStart = Math.max(0, overlapEnd - config.overlapSeconds * 1000);
		const start =
			tie?.resumeMs !== undefined && tie.resumeOverlapStartMs === undefined
				? Math.min(unit.start, overlapStart)
				: unit.start;
		if (tie?.resumeMs !== undefined)
			unit.resumeOverlapStartMs = tie.resumeOverlapStartMs ?? overlapStart;
		const exclusions = new Map<string, number | undefined>();
		const addExclusion = (id: string, time: number | undefined) => {
			const previousTime = exclusions.get(id);
			if (
				!exclusions.has(id) ||
				(time !== undefined && (previousTime === undefined || time < previousTime))
			)
				exclusions.set(id, time);
		};
		if (tie?.resumeMs !== undefined && tie.resumeMs >= start && tie.resumeMs <= end)
			for (const id of tie.resumeIds ?? []) addExclusion(id, tie.resumeMs);
		if (tie && tie.throughMs >= start && tie.throughMs <= end)
			for (const id of tie.ids) addExclusion(id, tie.throughMs);
		for (const entry of previousSeenEntries) {
			const time = seenTime(entry);
			if (time === undefined || (time >= start && time <= end)) addExclusion(seenId(entry), time);
		}
		const excludeIds = [...exclusions]
			.sort(
				([leftId, leftTime], [rightId, rightTime]) =>
					(leftTime ?? Number.POSITIVE_INFINITY) - (rightTime ?? Number.POSITIVE_INFINITY) ||
					leftId.localeCompare(rightId),
			)
			.slice(0, MAX_RESUME_EXCLUSION_IDS)
			.map(([id]) => id);
		segments = [[start, end, excludeIds]];
	} else if (
		tie?.resumeMs !== undefined &&
		tie.resumeMs >= unit.start &&
		tie.resumeMs <= tie.throughMs
	) {
		segments = [];
		if (unit.start < tie.resumeMs) segments.push([unit.start, tie.resumeMs - 1, []]);
		segments.push([tie.resumeMs, tie.resumeMs, tie.resumeIds ?? []]);
		if (tie.resumeMs < tie.throughMs) segments.push([tie.resumeMs + 1, tie.throughMs, tie.ids]);
		if (tie.throughMs < end) segments.push([tie.throughMs + 1, end, []]);
	} else if (tie && tie.ids.length > 0 && tie.throughMs >= unit.start && tie.throughMs < end) {
		segments = [
			[unit.start, tie.throughMs, tie.ids],
			[tie.throughMs + 1, end, []],
		];
	} else {
		segments = [[unit.start, end, tie?.ids ?? []]];
	}
	const total: UnitRead = { alerts: [], fetched: [], throughMs: unit.start - 1, complete: true };
	for (const [start, stop, excludeIds] of segments) {
		if (stop < start) continue;
		const read = await readAlertsOldestFirst(
			request,
			{ ...config, scopeIds: unit.scopeIds },
			unit.fieldId,
			start,
			stop,
			excludeIds,
			0,
			capacity,
			config.events.includes('alert.new'),
			config.events.includes('alert.updated'),
			previousAlertIds,
			activationMs,
		);
		total.alerts.push(...read.alerts);
		total.fetched.push(...read.fetched);
		if (read.fetched.length > 0 || read.complete) total.throughMs = read.throughMs;
		if (!read.complete) return { ...total, complete: false, stopped: read.stopped };
	}
	return total;
}

/** Seen entries carry their timestamp and selected scope after NUL separators; older entries may lack both. */
function seenEntry(id: string, time: string, scopeId?: string): string {
	return scopeId === undefined ? `${id} ${time}` : `${id} ${time} ${scopeId}`;
}
function seenId(entry: string): string {
	const separator = entry.indexOf(' ');
	return separator < 0 ? entry : entry.slice(0, separator);
}
function seenTime(entry: string): number | undefined {
	const separator = entry.indexOf(' ');
	const scopeSeparator = entry.indexOf(' ', separator + 1);
	const time =
		separator < 0
			? NaN
			: Date.parse(entry.slice(separator + 1, scopeSeparator < 0 ? undefined : scopeSeparator));
	return Number.isNaN(time) ? undefined : time;
}
function seenScope(entry: string): string | undefined {
	const separator = entry.indexOf(' ');
	const scopeSeparator = entry.indexOf(' ', separator + 1);
	if (separator < 0 || scopeSeparator < 0) return undefined;
	const scopeId = entry.slice(scopeSeparator + 1);
	return scopeId.length ? scopeId : undefined;
}

export async function pollSentinelOne(
	request: AuthenticatedRequest,
	config: TriggerConfig,
	previousState: TriggerState,
	mode: PollMode,
	pollStartMs: number,
): Promise<PollResult> {
	if (config.scopeIds.length === 0)
		throw new Error('Select at least one scope before activating the trigger.');
	if (config.events.length === 0)
		throw new Error('Select at least one event before activating the trigger.');

	if (config.events.some((event) => event !== 'alert.new' && event !== 'alert.updated'))
		throw new Error('Activity events must use ActivityFeed polling.');
	compileExclusions(config);
	alertFieldSelection(config.additionalAlertFields);
	const fingerprint = fingerprintConfig(config);
	const stateMatches =
		previousState.configFingerprint === fingerprint && previousState.initialized === true;
	const needsNew = config.events.includes('alert.new');
	const needsUpdated = config.events.includes('alert.updated');
	const streams: Array<'createdAt' | 'updatedAt'> = [
		...(needsNew ? (['createdAt'] as const) : []),
		...(needsUpdated ? (['updatedAt'] as const) : []),
	];
	const overlapMs = config.overlapSeconds * 1000;
	debugLog(config, 'Starting SentinelOne poll', {
		mode,
		isBaseline: mode === 'scheduled' && !stateMatches,
		scopeType: config.scopeType,
		scopeCount: config.scopeIds.length,
		events: config.events,
		severityCount: config.severities.length,
		statusCount: config.statuses.length,
		hasAlertNameFilter: config.alertName.trim().length > 0,
		overlapSeconds: config.overlapSeconds,
	});

	if (mode === 'manual') {
		const { createdAlerts, updatedAlerts } = await fetchManualAlertStreams(
			request,
			config,
			needsUpdated,
			pollStartMs,
			MANUAL_RESULT_LIMIT,
		);
		debugLog(config, 'Completed alert candidate queries', {
			createdCandidateCount: createdAlerts.length,
			updatedCandidateCount: updatedAlerts.length,
		});
		const records = classifyAlerts(
			config,
			mode,
			new Set(),
			new Set(),
			createdAlerts,
			updatedAlerts,
			0,
		);
		const manualItems = records
			.flatMap((record) => (record.item ? [record.item] : []))
			.slice(-MANUAL_RESULT_LIMIT);
		debugLog(config, 'Completed manual SentinelOne poll', {
			outputCount: manualItems.length,
			outputLimit: MANUAL_RESULT_LIMIT,
		});
		return { items: manualItems };
	}

	// Each stream and scope batch keeps one forward-only cursor. A completed range restarts at the overlap; an interrupted range resumes at its last timestamp and the IDs already handled there.
	// State saved before the activation watermark existed suppresses nothing.
	const activationMs = stateMatches ? (previousState.activationMs ?? 0) : pollStartMs;
	const firstStartMs = stateMatches ? (previousState.activationMs ?? pollStartMs) : pollStartMs;
	const savedCursors = stateMatches ? (asRecord(previousState.alertCursors) ?? {}) : {};
	const previousSeenIds = stateMatches ? (previousState.seenAlertIds ?? []) : [];
	const previousSeenVersions = stateMatches ? (previousState.seenAlertVersions ?? []) : [];
	const batches = scopeBatches(config);
	const previousSeenByScope = new Map<string, string[]>();
	const previousUnscopedSeenIds: string[] = [];
	for (const entry of previousSeenIds) {
		const scopeId = seenScope(entry);
		if (scopeId === undefined) {
			previousUnscopedSeenIds.push(entry);
			continue;
		}
		const entries = previousSeenByScope.get(scopeId) ?? [];
		entries.push(entry);
		previousSeenByScope.set(scopeId, entries);
	}
	const previousStalledPolls = stateMatches
		? (asRecord(previousState.stalledAlertPolls) ?? {})
		: {};
	for (const [key, count] of Object.entries(previousStalledPolls))
		if (!Number.isInteger(count) || (count as number) < 0)
			throw new Error(
				`The saved stalled-poll count for ${key} is invalid; state was not advanced.`,
			);
	const previousAlertIds = new Set(previousSeenIds.map(seenId));
	const previousVersions = new Set(previousSeenVersions);
	const capacity: SeenCapacity | undefined =
		config.pollDeadlineMs === undefined
			? undefined
			: { alertIds: new Set(previousAlertIds), versions: new Set(previousVersions) };
	// State saved before per-unit cursors existed carries one checkpoint; it becomes every unit's cursor once.
	const legacyCheckpoint: AlertCursor | undefined =
		stateMatches &&
		previousState.alertCursors === undefined &&
		typeof previousState.checkpointMs === 'number'
			? { throughMs: previousState.checkpointMs, ids: [] }
			: undefined;
	const units: Unit[] = [];
	for (const [batchIndex, scopeIds] of batches.entries()) {
		for (const fieldId of streams) {
			const key = `${fieldId}:${simpleHash(scopeIds.join(' '))}`;
			// A batch whose membership changed takes the slowest saved cursor of its stream, so nothing that cursor had not reached is skipped and it can never save an earlier one.
			const saved = [
				...Object.entries(savedCursors)
					.filter(([savedKey]) => savedKey.startsWith(`${fieldId}:`))
					.flatMap(([savedKey, value]) => {
						const cursor = readCursor(value, savedKey, config.pollDeadlineMs !== undefined);
						return cursor ? [cursor.throughMs] : [];
					}),
				...(legacyCheckpoint ? [legacyCheckpoint.throughMs] : []),
			];
			const previous =
				readCursor(savedCursors[key], key, config.pollDeadlineMs !== undefined) ??
				(saved.length ? { throughMs: Math.min(...saved), ids: [] } : undefined);
			const start = previous
				? (previous.resumeMs ?? Math.max(0, previous.throughMs - overlapMs))
				: Math.max(0, firstStartMs - overlapMs);
			units.push({ key, fieldId, scopeIds, batchNumber: batchIndex + 1, previous, start });
		}
	}
	// Lagging units read first, so a batch behind the others cannot be starved by those ahead of it.
	units.sort((left, right) => left.start - right.start);
	const batchOrder = [...new Set(units.map((unit) => unit.scopeIds))];
	await mapWithConcurrency(batchOrder, Math.min(config.concurrentRequests, 5), async (scopeIds) => {
		const batchUnits = units.filter((unit) => unit.scopeIds === scopeIds);
		const batchCapacity = capacity
			? { alertIds: new Set(capacity.alertIds), versions: new Set(capacity.versions) }
			: undefined;
		const createdUnit = batchUnits.find((unit) => unit.fieldId === 'createdAt');
		const updatedUnit = batchUnits.find((unit) => unit.fieldId === 'updatedAt');
		if (createdUnit)
			createdUnit.read = await readUnit(
				request,
				config,
				createdUnit,
				pollStartMs,
				batchCapacity,
				previousAlertIds,
				activationMs,
				[
					...createdUnit.scopeIds.flatMap((scopeId) => previousSeenByScope.get(scopeId) ?? []),
					...(batches.length === 1 ? previousUnscopedSeenIds : []),
				],
			);
		if (updatedUnit) {
			const createdRead = createdUnit?.read;
			const safelyCreatedThrough = !createdUnit
				? pollStartMs
				: !createdRead
					? undefined
					: createdRead.complete
						? createdRead.throughMs
						: createdRead.fetched.length > 0
							? createdRead.throughMs - 1
							: undefined;
			if (safelyCreatedThrough !== undefined && updatedUnit.start <= safelyCreatedThrough)
				updatedUnit.read = await readUnit(
					request,
					config,
					updatedUnit,
					safelyCreatedThrough,
					batchCapacity,
					previousAlertIds,
					activationMs,
					previousSeenIds,
				);
		}
	});
	const capacityBlockedNewIds = new Set<string>();
	if (capacity) {
		const capacityOrder = new Map(units.map((unit, index) => [unit, index]));
		const entries = units.flatMap((unit) => {
			const read = unit.read;
			if (!read) return [];
			const keptIds = new Set(read.alerts.map((alert) => alert.id));
			return read.fetched.map((alert, index) => ({
				unit,
				alert,
				index,
				kept: keptIds.has(alert.id),
				time: timeValue(alert[unit.fieldId]),
			}));
		});
		entries.sort(
			(left, right) =>
				left.time - right.time ||
				(left.unit.fieldId === 'createdAt' ? 0 : 1) -
					(right.unit.fieldId === 'createdAt' ? 0 : 1) ||
				capacityOrder.get(left.unit)! - capacityOrder.get(right.unit)! ||
				left.index - right.index,
		);
		const acceptedThrough = new Map<Unit, number>();
		const blocked = new Set<Unit>();
		const reconciledCapacity: SeenCapacity = {
			alertIds: new Set(capacity.alertIds),
			versions: new Set(capacity.versions),
		};
		for (const entry of entries) {
			if (blocked.has(entry.unit)) {
				if (
					entry.unit.fieldId === 'createdAt' &&
					needsNew &&
					timeValue(entry.alert.createdAt) >= activationMs &&
					!previousAlertIds.has(entry.alert.id)
				)
					capacityBlockedNewIds.add(entry.alert.id);
				continue;
			}
			if (
				entry.kept &&
				!reserveSeenCapacity(
					reconciledCapacity,
					entry.unit.fieldId,
					entry.alert,
					needsNew,
					needsUpdated,
					previousAlertIds,
					activationMs,
				)
			) {
				blocked.add(entry.unit);
				if (
					entry.unit.fieldId === 'createdAt' &&
					needsNew &&
					timeValue(entry.alert.createdAt) >= activationMs &&
					!previousAlertIds.has(entry.alert.id)
				)
					capacityBlockedNewIds.add(entry.alert.id);
				continue;
			}
			acceptedThrough.set(entry.unit, entry.index + 1);
		}
		for (const unit of units) {
			const read = unit.read;
			if (!read) continue;
			const acceptedCount = acceptedThrough.get(unit) ?? 0;
			if (acceptedCount >= read.fetched.length) continue;
			read.fetched = read.fetched.slice(0, acceptedCount);
			const acceptedIds = new Set(read.fetched.map((alert) => alert.id));
			read.alerts = read.alerts.filter((alert) => acceptedIds.has(alert.id));
			read.throughMs = read.fetched.length
				? timeValue(read.fetched[read.fetched.length - 1][unit.fieldId])
				: unit.start - 1;
			read.complete = false;
			read.stopped = new Error(
				'The alert state reached its safe capacity before the range ended. Narrow the scope or filters so the overlap fits; state was not advanced.',
			);
		}
	}
	if (needsNew && needsUpdated && capacityBlockedNewIds.size > 0) {
		const acceptedCreatedIds = new Set(
			units
				.filter((unit) => unit.fieldId === 'createdAt')
				.flatMap((unit) => unit.read?.alerts.map((alert) => alert.id) ?? []),
		);
		for (const unit of units.filter((candidate) => candidate.fieldId === 'updatedAt')) {
			const read = unit.read;
			if (!read) continue;
			const keptIds = new Set(read.alerts.map((alert) => alert.id));
			const blockedIndex = read.fetched.findIndex(
				(alert) =>
					keptIds.has(alert.id) &&
					capacityBlockedNewIds.has(alert.id) &&
					!acceptedCreatedIds.has(alert.id),
			);
			if (blockedIndex < 0) continue;
			read.fetched = read.fetched.slice(0, blockedIndex);
			const acceptedIds = new Set(read.fetched.map((alert) => alert.id));
			read.alerts = read.alerts.filter((alert) => acceptedIds.has(alert.id));
			read.throughMs = read.fetched.length
				? timeValue(read.fetched[read.fetched.length - 1][unit.fieldId])
				: unit.start - 1;
			read.complete = false;
			read.stopped = new Error('The Updated range is waiting for its New alert.');
		}
	}
	const stalledAlertPolls: Record<string, number> = {};
	const progressedByBatch = new Map<string[], Unit[]>();
	for (const candidate of units)
		if (candidate.read && (candidate.read.complete || candidate.read.fetched.length > 0)) {
			const progressed = progressedByBatch.get(candidate.scopeIds) ?? [];
			progressed.push(candidate);
			progressedByBatch.set(candidate.scopeIds, progressed);
		}
	const pollAdvanced = progressedByBatch.size > 0;
	for (const unit of units) {
		const read = unit.read;
		if (!read) {
			unit.next = unit.previous;
			if (config.pollDeadlineMs === undefined) continue;
		}
		const previous = unit.previous;
		const idsAt = (time: number) =>
			(read?.fetched ?? [])
				.filter((alert) => timeValue(alert[unit.fieldId]) === time)
				.map((alert) => alert.id);
		const knownAt = (time: number) => [
			...(previous?.throughMs === time ? previous.ids : []),
			...(previous?.resumeMs === time ? (previous.resumeIds ?? []) : []),
		];
		const mergedIdsAt = (time: number) => [...new Set([...knownAt(time), ...idsAt(time)])];
		// A complete range may restart at the overlap on the next poll. Interrupted ranges retain their exact read position and IDs; budgeted New reads also retain the overlap start.
		if (read?.complete && previous && read.throughMs < previous.throughMs)
			unit.next = {
				throughMs: previous.throughMs,
				ids: previous.ids,
				resumeMs: read.throughMs,
				resumeIds: mergedIdsAt(read.throughMs),
			};
		else if (read?.complete)
			unit.next = { throughMs: read.throughMs, ids: mergedIdsAt(read.throughMs) };
		else if (read && read.fetched.length === 0) unit.next = previous;
		else if (read) {
			const throughMs = Math.max(previous?.throughMs ?? read.throughMs, read.throughMs);
			unit.next = {
				throughMs,
				ids: mergedIdsAt(throughMs),
				resumeMs: read.throughMs,
				resumeIds: mergedIdsAt(read.throughMs),
				...(unit.resumeOverlapStartMs === undefined
					? {}
					: { resumeOverlapStartMs: unit.resumeOverlapStartMs }),
			};
		}
		let stalledPolls = Number(previousStalledPolls[unit.key] ?? 0);
		const blockingRead =
			read?.stopped ??
			(!read && unit.fieldId === 'updatedAt'
				? units.find((other) => other.scopeIds === unit.scopeIds && other.fieldId === 'createdAt')
						?.read?.stopped
				: undefined);
		const batchProgressed =
			progressedByBatch.get(unit.scopeIds)?.some((other) => other !== unit) ?? false;
		const unitProgressed = cursorPositionChanged(unit.previous, unit.next);
		stalledPolls =
			config.pollDeadlineMs !== undefined && blockingRead && !unitProgressed && !batchProgressed
				? stalledPolls + 1
				: 0;
		if (stalledPolls > 0) stalledAlertPolls[unit.key] = stalledPolls;
		const stalledPosition =
			unit.next?.resumeMs ??
			unit.previous?.resumeMs ??
			unit.next?.throughMs ??
			unit.previous?.throughMs ??
			unit.start;
		if (stalledPolls >= 3)
			warnLog(
				config,
				`The ${unit.fieldId} stream in scope batch ${unit.batchNumber} has made no progress for ${stalledPolls} polls.`,
				{ position: new Date(stalledPosition).toISOString(), stalledPolls },
			);
		if (stalledPolls >= 10 && !pollAdvanced)
			throw new Error(
				`The ${unit.fieldId} stream in scope batch ${unit.batchNumber} remained stalled at ${new Date(stalledPosition).toISOString()} for ${stalledPolls} polls (${blockingRead?.message ?? 'the budget stopped the read'}); state was not advanced.`,
			);
		const overflowTime =
			(unit.next?.resumeIds?.length ?? 0) > MAX_TIE_IDS
				? unit.next!.resumeMs!
				: unit.next?.throughMs;
		if (
			(unit.next?.ids.length ?? 0) > MAX_TIE_IDS ||
			(unit.next?.resumeIds?.length ?? 0) > MAX_TIE_IDS
		)
			throw new Error(
				`More than ${MAX_TIE_IDS} alerts share the ${unit.fieldId} timestamp ${new Date(overflowTime!).toISOString()}. Narrow the scope or filters; state was not advanced.`,
			);
	}
	const createdAlerts = units
		.filter((unit) => unit.fieldId === 'createdAt')
		.flatMap((unit) => unit.read?.alerts ?? []);
	const updatedAlerts = units
		.filter((unit) => unit.fieldId === 'updatedAt')
		.flatMap((unit) => unit.read?.alerts ?? []);
	debugLog(config, 'Completed alert candidate queries', {
		createdCandidateCount: createdAlerts.length,
		updatedCandidateCount: updatedAlerts.length,
		stoppedUnitCount: units.filter((unit) => unit.read?.stopped).length,
	});

	const records = classifyAlerts(
		config,
		mode,
		previousAlertIds,
		previousVersions,
		createdAlerts,
		updatedAlerts,
		activationMs,
	);
	const currentAlertIds = records.flatMap((record) => (record.seenId ? [record.seenId] : []));
	const currentVersions = records.flatMap((record) => (record.version ? [record.version] : []));
	assertStateCapacity(currentAlertIds, MAX_SEEN_ALERT_IDS, 'alert IDs');
	assertStateCapacity(currentVersions, MAX_SEEN_ALERT_VERSIONS, 'alert versions');

	const outputItems = sortOutputs(records.flatMap((record) => (record.item ? [record.item] : [])));
	const alertCursors: Record<string, AlertCursor> = {};
	for (const unit of units) if (unit.next) alertCursors[unit.key] = unit.next;
	const slowest = (fieldId: 'createdAt' | 'updatedAt') =>
		Math.min(
			pollStartMs,
			...units
				.filter((unit) => unit.fieldId === fieldId)
				.map((unit) => unit.next?.throughMs ?? unit.previous?.throughMs ?? unit.start - 1),
		);
	const checkpointMs = Math.min(slowest('createdAt'), slowest('updatedAt'));
	// Identities remain until the slowest cursor leaves their overlap, including when a changed scope batch falls back to that cursor.
	const currentIds = new Set(currentAlertIds.map(seenId));
	const seenAlertIds = retainSeen(
		previousSeenIds.filter((entry) => !currentIds.has(seenId(entry))),
		currentAlertIds,
		seenTime,
		slowest('createdAt') - overlapMs,
		MAX_SEEN_ALERT_IDS,
		'alert IDs',
	);
	const seenAlertVersions = retainSeen(
		previousSeenVersions,
		currentVersions,
		seenTime,
		(needsUpdated ? slowest('updatedAt') : slowest('createdAt')) - overlapMs,
		MAX_SEEN_ALERT_VERSIONS,
		'alert versions',
	);
	debugLog(config, 'Completed scheduled SentinelOne poll', {
		outputCount: outputItems.length,
		checkpointAdvanced: true,
		checkpointMs,
		budgetStopped: units.some((unit) => unit.read?.stopped),
		seenAlertIdCount: seenAlertIds.length,
		seenAlertVersionCount: seenAlertVersions.length,
	});

	return {
		items: outputItems,
		nextState: {
			configFingerprint: fingerprint,
			initialized: true,
			checkpointMs,
			activationMs,
			alertCursors,
			seenAlertIds,
			seenAlertVersions,
			...(Object.keys(stalledAlertPolls).length > 0 ? { stalledAlertPolls } : {}),
		},
	};
}
