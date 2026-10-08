import { advancedFilterSelection } from '../shared/AlertFilterSelection';
export { advancedFilterSelection } from '../shared/AlertFilterSelection';
import type { IDataObject, IHttpRequestOptions } from 'n8n-workflow';
import type { ScopeType } from '../shared/Scopes';
import { alertFieldSelection, additionalAlertOutput } from '../shared/AlertFields';
import type { ActivityCondition } from './ActivityConditions';
import { PollBudgetError } from '../shared/transport/request';
import { isRetryableReadError, responseStatus, retryAfterMs } from '../shared/transport/retry';

export type TriggerEvent = 'alert.new' | 'alert.updated' | 'alert.activity';

export type PollMode = 'manual' | 'scheduled';

export const TRIGGER_STATE_VERSION = 2;

export const MAX_SEEN_ALERT_IDS = 20_000;

export const MAX_SEEN_ALERT_VERSIONS = 40_000;

export const MANUAL_RESULT_LIMIT = 10;

export const MAX_SCOPE_IDS_PER_QUERY = 500;

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
	alertFilters?: IDataObject[];
	alertFilterMatch?: 'all' | 'any';
	/** Saved parameter values keep relative expressions from resetting the baseline on every poll. */
	filterParameters?: {
		alertName?: unknown;
		advancedFilters?: unknown;
		alertFilters?: unknown;
	};
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
	/** Lower edge to replay once an interrupted New range completes. */
	resumeLowerEdge?: number;
}

export interface TriggerState extends IDataObject {
	version?: number;
	configFingerprint?: string;
	initialized?: boolean;
	/** Completed activity window; alert streams use their own cursors. */
	checkpointMs?: number;
	/** Poll start of the first scheduled poll; alerts created or updated before it are recorded, never emitted. */
	activationMs?: number;
	alertCursors?: Record<string, AlertCursor>;
	/** Seen alert IDs with creation time and selected scope separated by NULs, so resumed and overlap reads do not repeat deliveries. */
	seenAlertIds?: string[];
	seenAlertVersions?: string[];
	activityActivationMs?: number;
}

export interface PollResult {
	items: IDataObject[];
	nextState?: TriggerState;
}

export type AuthenticatedRequest = (
	options: IHttpRequestOptions,
	deadlineMs?: number,
) => Promise<unknown>;

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

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);

	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	// SAFETY: the preceding object check excludes null and arrays, leaving a JSON object record.
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
	const results: R[] = [];
	results.length = items.length;
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

function containsExpression(value: unknown): boolean {
	if (typeof value === 'string') return value.startsWith('=');

	if (Array.isArray(value)) return value.some(containsExpression);

	const object = asRecord(value);

	return object ? Object.values(object).some(containsExpression) : false;
}

export function fingerprintConfig(config: TriggerConfig): string {
	const raw = config.filterParameters;
	const rawAdvancedFilters = raw?.advancedFilters;
	// Static configurations without builder rows retain the 0.1.0 fingerprint shape.

	const rawFilters =
		raw &&
		(config.alertFilters?.length ||
			containsExpression(rawAdvancedFilters) ||
			containsExpression(raw.alertFilters));

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
			alertName: (raw ? String(raw.alertName ?? '') : config.alertName).trim(),
			advancedFilters: rawFilters
				? {
						advancedFilters: rawAdvancedFilters ?? [],
						alertFilters: raw.alertFilters ?? {},
						match: config.alertFilterMatch ?? 'all',
					}
				: advancedFilterSelection(
						[],
						raw ? rawAdvancedFilters : config.advancedFilters,
						config.alertFilters,
						config.alertFilterMatch,
					),
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
				: {}),
		}),
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
	// SAFETY: this request uses the typed alert query and asRecord confirms the envelope is an object.
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
		config.alertFilters,
		config.alertFilterMatch,
	);

	const remainingMs = (config.pollDeadlineMs ?? Infinity) - Date.now();

	if (remainingMs <= 0) throw new PollBudgetError();

	const response = await request({
		method: 'POST',
		url: `${config.baseUrl}/web/api/v2.1/unifiedalerts/graphql`,
		timeout: Math.min(config.requestTimeoutMs, remainingMs),
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

/** Newest-first read for manual previews, bounded by the result and page limits. */
async function fetchAlertsNewestFirst(
	request: AuthenticatedRequest,
	config: TriggerConfig,
	fieldId: 'createdAt' | 'updatedAt',
	start: number,
	end: number,
	maxItems: number,
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
			// Full pages: exclusions are applied after fetching, so small pages exhaust the page cap early.
			config.alertPageSize,
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

	// A preview has no state to protect: show what the page limit found rather than failing.
	return alerts.slice(0, maxItems);
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

/** Reads oldest first and hands over completed pages at the budget or page cap. */
async function readAlertsOldestFirst(
	request: AuthenticatedRequest,
	config: TriggerConfig,
	fieldId: 'createdAt' | 'updatedAt',
	start: number,
	end: number,
	excludeIds: string[],
): Promise<UnitRead> {
	const alerts: Alert[] = [];
	const fetched: Alert[] = [];
	const seenCursors = new Set<string>();
	let after: string | undefined;
	let previousMs: number | undefined;

	const finish = (complete: boolean, stopped?: Error): UnitRead => {
		const orderedFetched =
			fieldId === 'createdAt'
				? [...fetched].sort(
						(left, right) =>
							timeValue(left.createdAt) - timeValue(right.createdAt) ||
							left.id.localeCompare(right.id),
					)
				: fetched;

		const orderedAlerts =
			fieldId === 'createdAt'
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

	for (let pageNumber = 1; pageNumber <= config.maxAlertPages; pageNumber++) {
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
				'ASC',
				excludeIds,
			);
		} catch (error) {
			if (error instanceof PollBudgetError) return finish(false, error);

			if (
				responseStatus(error) !== null &&
				isRetryableReadError(error) &&
				Date.now() + Math.max(1000, retryAfterMs(error)) >= (config.pollDeadlineMs ?? Infinity)
			)
				return finish(
					false,
					error instanceof Error
						? error
						: Object.assign(new Error('The retry no longer fits the poll time budget.'), {
								cause: error,
							}),
				);
			// The trigger boundary wraps these failures with its node context.
			// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
			throw error;
		}

		const keptIds = new Set(page.kept.map((alert) => alert.id));
		let pagePreviousMs: number | undefined;

		for (const alert of page.nodes) {
			const ms = timeValue(alert[fieldId]);

			if (ms < start || ms > end) continue;

			if (pagePreviousMs !== undefined && ms < pagePreviousMs)
				throw new Error(
					`SentinelOne returned ${fieldId} alerts out of ascending order at ${new Date(ms).toISOString()}; state was not advanced.`,
				);

			if (fieldId === 'updatedAt' && previousMs !== undefined && ms < previousMs)
				throw new Error(
					`SentinelOne returned ${fieldId} alerts out of ascending order at ${new Date(ms).toISOString()}; state was not advanced.`,
				);

			previousMs = ms;
			pagePreviousMs = ms;
			fetched.push(alert);

			if (keptIds.has(alert.id)) alerts.push(alert);
		}

		const nextCursor = requireRelayCursor(page.pageInfo, seenCursors, `${fieldId} alert query`);

		if (!nextCursor) return finish(true);
		after = nextCursor;
	}

	return finish(false, new Error('The alert query reached the configured page limit.'));
}

function timeValue(value: unknown): number {
	const parsed = Date.parse(String(value ?? ''));

	return Number.isNaN(parsed) ? 0 : parsed;
}

function sortOutputs(items: IDataObject[]): IDataObject[] {
	return items.sort((left, right) => {
		const timeDifference = timeValue(left.eventTime) - timeValue(right.eventTime);

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

	const eventId = [
		new URL(config.baseUrl).host,
		'alert',
		alert.id,
		...(eventType === 'alert.new' ? ['new'] : ['updated', String(alert.updatedAt)]),
	]
		.map(encodeURIComponent)
		.join('/');

	if (config.simplifyOutput) {
		// Field names match SentinelOne's filter field IDs, so output lines up with Advanced Filters.
		return {
			eventId,
			eventType,
			eventTime: eventTimestamp,
			id: alert.id,
			externalId: alert.externalId ?? null,
			alertName: alert.name ?? null,
			severity: alert.severity ?? null,
			status: alert.status ?? null,
			createdAt: alert.createdAt ?? null,
			updatedAt: alert.updatedAt ?? null,
			detectedAt: alert.detectedAt ?? null,
			firstSeenAt: alert.firstSeenAt ?? null,
			lastSeenAt: alert.lastSeenAt ?? null,
			alertNoteExists: alert.noteExists ?? null,
			...additionalAlertOutput(config.additionalAlertFields, alert),
			accountId: asRecord(scope.account)?.id ?? null,
			accountName: asRecord(scope.account)?.name ?? null,
			siteId: asRecord(scope.site)?.id ?? null,
			siteName: asRecord(scope.site)?.name ?? null,
			groupId: asRecord(scope.group)?.id ?? null,
			groupName: asRecord(scope.group)?.name ?? null,
		};
	}

	return {
		eventId,
		eventType,
		eventTime: eventTimestamp,
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
				typeof scopeId === 'string' ? scopeId : '',
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

function readCursor(value: unknown, key: string): AlertCursor | undefined {
	if (value === undefined) return undefined;
	const cursor = asRecord(value);

	if (
		!cursor ||
		typeof cursor.throughMs !== 'number' ||
		!Number.isFinite(cursor.throughMs) ||
		!Array.isArray(cursor.ids) ||
		cursor.ids.some((id) => typeof id !== 'string') ||
		(cursor.resumeMs !== undefined &&
			(typeof cursor.resumeMs !== 'number' || !Number.isFinite(cursor.resumeMs))) ||
		(cursor.resumeLowerEdge !== undefined &&
			(typeof cursor.resumeLowerEdge !== 'number' || !Number.isFinite(cursor.resumeLowerEdge))) ||
		(cursor.resumeIds !== undefined &&
			(!Array.isArray(cursor.resumeIds) || cursor.resumeIds.some((id) => typeof id !== 'string')))
	)
		throw new Error(`The saved alert cursor ${key} is invalid; state was not advanced.`);

	return {
		throughMs: cursor.throughMs,
		ids: cursor.ids as string[],
		...(typeof cursor.resumeMs === 'number' ? { resumeMs: cursor.resumeMs } : {}),
		...(Array.isArray(cursor.resumeIds) ? { resumeIds: cursor.resumeIds as string[] } : {}),
		...(typeof cursor.resumeLowerEdge === 'number'
			? { resumeLowerEdge: cursor.resumeLowerEdge }
			: {}),
	};
}

/** Keeps recent entries inside the replay window, evicting the oldest keys at the cache cap. */
function retainSeen(
	previous: string[],
	current: string[],
	timeOf: (entry: string) => number,
	retireBeforeMs: number,
	limit: number,
	label: string,
	config: TriggerConfig,
): string[] {
	const ordered = new Map<string, true>();

	for (const entry of [...previous, ...current]) {
		ordered.set(entry, true);
	}

	const entries = [...ordered.keys()]
		.filter((entry) => timeOf(entry) >= retireBeforeMs)
		.sort((left, right) => timeOf(left) - timeOf(right));

	if (entries.length > limit)
		warnLog(config, `The recent ${label} cache evicted its oldest keys. Events may repeat.`, {
			evicted: entries.length - limit,
			limit,
		});

	return entries.slice(-limit);
}

interface Unit {
	key: string;
	fieldId: 'createdAt' | 'updatedAt';
	scopeIds: string[];
	batchNumber: number;
	previous?: AlertCursor;
	start: number;
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
		next.resumeLowerEdge !== previous.resumeLowerEdge ||
		next.resumeIds?.length !== previous.resumeIds?.length ||
		!!next.resumeIds?.some((id, index) => id !== previous.resumeIds?.[index])
	);
}

/** New positions are immutable. Updated exclusions apply only at the exact resume timestamp so later revisions remain visible. */
async function readUnit(
	request: AuthenticatedRequest,
	config: TriggerConfig,
	unit: Unit,
	end: number,
): Promise<UnitRead> {
	const cursor = unit.previous;
	const position = cursor?.resumeMs ?? cursor?.throughMs;
	const ids = cursor?.resumeMs !== undefined ? (cursor.resumeIds ?? []) : (cursor?.ids ?? []);

	const scopedConfig = { ...config, scopeIds: unit.scopeIds };

	if (
		unit.fieldId === 'createdAt' ||
		ids.length === 0 ||
		position === undefined ||
		position < unit.start ||
		position > end
	)
		return await readAlertsOldestFirst(request, scopedConfig, unit.fieldId, unit.start, end, ids);

	const total: UnitRead = { alerts: [], fetched: [], throughMs: unit.start - 1, complete: true };
	const ranges: Array<[number, number, string[]]> = [];

	if (unit.start < position) ranges.push([unit.start, position - 1, []]);
	ranges.push([position, position, ids]);

	if (position < end) ranges.push([position + 1, end, []]);

	for (const [start, stop, excludeIds] of ranges) {
		const read = await readAlertsOldestFirst(
			request,
			scopedConfig,
			unit.fieldId,
			start,
			stop,
			excludeIds,
		);

		total.alerts.push(...read.alerts);
		total.fetched.push(...read.fetched);

		if (read.fetched.length > 0 || read.complete) total.throughMs = read.throughMs;

		if (!read.complete) return { ...total, complete: false, stopped: read.stopped };
	}

	return total;
}

/** Alert identities carry creation time and selected scope; versions carry update time. */
function seenEntry(id: string, time: string, scopeId: string): string {
	return `${id}\u0000${time}\u0000${scopeId}`;
}

function seenId(entry: string): string {
	return entry.split('\u0000')[0];
}

function seenTime(entry: string): number {
	return Date.parse(entry.split('\u0000')[1]);
}

function readSeenEntries(value: unknown, scoped: boolean): string[] {
	if (
		!Array.isArray(value) ||
		value.some((entry) => {
			if (typeof entry !== 'string') return true;
			const parts = entry.split('\u0000');

			return (
				parts.length !== (scoped ? 3 : 2) || !parts[0] || !Number.isFinite(Date.parse(parts[1]))
			);
		})
	)
		throw new Error('The saved alert identities are invalid; state was not advanced.');

	return value as string[];
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
		previousState.version === TRIGGER_STATE_VERSION &&
		previousState.configFingerprint === fingerprint &&
		previousState.initialized === true;

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
	const activationMs = stateMatches ? previousState.activationMs : pollStartMs;
	const savedCursors = stateMatches ? asRecord(previousState.alertCursors) : {};

	if (typeof activationMs !== 'number' || !Number.isFinite(activationMs) || !savedCursors)
		throw new Error('The saved alert activation or cursors are invalid; state was not advanced.');
	const previousSeenIds = stateMatches ? readSeenEntries(previousState.seenAlertIds, true) : [];

	const previousSeenVersions = stateMatches
		? readSeenEntries(previousState.seenAlertVersions, false)
		: [];

	const batches = scopeBatches(config);
	const previousAlertIds = new Set(previousSeenIds.map(seenId));
	const previousVersions = new Set(previousSeenVersions);

	const units: Unit[] = [];

	for (const [batchIndex, scopeIds] of batches.entries()) {
		for (const fieldId of streams) {
			const key = `${fieldId}:${simpleHash(scopeIds.join('\u0000'))}`;

			// A batch whose membership changed takes the slowest saved cursor of its stream, so nothing that cursor had not reached is skipped and it can never save an earlier one.
			const saved = Object.entries(savedCursors).flatMap(([savedKey, value]) => {
				if (!savedKey.startsWith(`${fieldId}:`)) return [];

				const cursor = readCursor(value, savedKey);

				return cursor ? [cursor.throughMs] : [];
			});

			const previous =
				readCursor(savedCursors[key], key) ??
				(saved.length ? { throughMs: Math.min(...saved), ids: [] } : undefined);

			const start = previous
				? (previous.resumeMs ??
					Math.max(
						0,
						Math.min(previous.resumeLowerEdge ?? Infinity, previous.throughMs - overlapMs),
					))
				: Math.max(0, activationMs - overlapMs);

			units.push({ key, fieldId, scopeIds, batchNumber: batchIndex + 1, previous, start });
		}
	}

	// Lagging units read first, so a batch behind the others cannot be starved by those ahead of it.
	units.sort((left, right) => left.start - right.start);
	const batchOrder = [...new Set(units.map((unit) => unit.scopeIds))];
	await mapWithConcurrency(batchOrder, Math.min(config.concurrentRequests, 5), async (scopeIds) => {
		const batchUnits = units.filter((unit) => unit.scopeIds === scopeIds);

		for (const unit of batchUnits) unit.read = await readUnit(request, config, unit, pollStartMs);
	});

	for (const unit of units) {
		const read = unit.read;

		if (!read) {
			unit.next = unit.previous;
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

		// A complete range may restart at the overlap on the next poll. Interrupted ranges retain their exact read position and IDs.
		if (read?.complete && previous && read.throughMs < previous.throughMs)
			unit.next = {
				throughMs: previous.throughMs,
				ids: previous.ids,
				resumeMs: read.throughMs,
				resumeIds: mergedIdsAt(read.throughMs),
			};
		else if (read?.complete)
			unit.next = { throughMs: read.throughMs, ids: mergedIdsAt(read.throughMs) };
		else if (read && read.fetched.length === 0)
			unit.next =
				read.throughMs >= unit.start
					? {
							throughMs: Math.max(previous?.throughMs ?? read.throughMs, read.throughMs),
							ids: previous?.ids ?? [],
							resumeMs: read.throughMs + 1,
							resumeIds: mergedIdsAt(read.throughMs + 1),
						}
					: previous;
		else if (read) {
			const throughMs = Math.max(previous?.throughMs ?? read.throughMs, read.throughMs);
			unit.next = {
				throughMs,
				ids: mergedIdsAt(throughMs),
				resumeMs: read.throughMs,
				resumeIds: mergedIdsAt(read.throughMs),
			};
		}

		if (unit.fieldId === 'createdAt' && unit.next && read) {
			// Replay the original lower edge once; a capped replay resumes without starting another replay.
			const replayStarting =
				previous?.resumeMs === undefined && previous?.resumeLowerEdge !== undefined;

			const lowerEdge =
				previous?.resumeLowerEdge ?? (previous?.resumeMs === undefined ? unit.start : undefined);

			if (!read.complete && !replayStarting && lowerEdge !== undefined)
				unit.next.resumeLowerEdge = lowerEdge;
			else if (
				read.complete &&
				previous?.resumeMs !== undefined &&
				previous.resumeLowerEdge !== undefined
			)
				unit.next.resumeLowerEdge = previous.resumeLowerEdge;
		}

		if (read?.stopped) {
			const position =
				unit.next?.resumeMs ?? previous?.resumeMs ?? previous?.throughMs ?? unit.start;

			warnLog(
				config,
				`The ${unit.fieldId} stream in scope batch ${unit.batchNumber} stopped at ${new Date(position).toISOString()}: ${read.stopped.message}`,
				{
					stream: unit.fieldId,
					scopeBatch: unit.batchNumber,
					position: new Date(position).toISOString(),
					rowCount: read.fetched.length,
					httpStatus: responseStatus(read.stopped),
				},
			);
		}

		if (
			(unit.next?.ids.length ?? 0) > MAX_RESUME_EXCLUSION_IDS ||
			(unit.next?.resumeIds?.length ?? 0) > MAX_RESUME_EXCLUSION_IDS
		)
			throw new Error(
				`The ${unit.fieldId} stream in scope batch ${unit.batchNumber} exceeded ${MAX_RESUME_EXCLUSION_IDS} cursor IDs at ${new Date(unit.next?.resumeMs ?? unit.next!.throughMs).toISOString()}. Narrow the scope or filters; state was not advanced.`,
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

	const outputItems = stateMatches
		? sortOutputs(records.flatMap((record) => (record.item ? [record.item] : [])))
		: [];

	if (
		outputItems.length === 0 &&
		!units.some((unit) => cursorPositionChanged(unit.previous, unit.next))
	) {
		const failure = units.find((candidate) => responseStatus(candidate.read?.stopped) !== null)
			?.read?.stopped;
		// A transient stop without poll-wide progress remains the original HTTP failure.

		if (failure) throw failure;
		const unit = units.find((candidate) => candidate.read?.stopped) ?? units[0];
		const position = unit.previous?.resumeMs ?? unit.previous?.throughMs ?? unit.start;
		throw new Error(
			`The ${unit.fieldId} stream in scope batch ${unit.batchNumber} made no progress at ${new Date(position).toISOString()} (${unit.read?.stopped?.message ?? 'no events or cursor advancement'}); state was not advanced.`,
		);
	}

	const alertCursors: Record<string, AlertCursor> = {};

	for (const unit of units) if (unit.next) alertCursors[unit.key] = unit.next;

	const slowest = (fieldId: 'createdAt' | 'updatedAt') =>
		Math.min(
			pollStartMs,
			...units.flatMap((unit) =>
				unit.fieldId === fieldId
					? [unit.next?.throughMs ?? unit.previous?.throughMs ?? unit.start - 1]
					: [],
			),
		);

	// Recent identities retire when the slowest cursor leaves their overlap; the cache cap can evict older keys first.
	const currentIds = new Set(currentAlertIds.map(seenId));

	const seenAlertIds = retainSeen(
		previousSeenIds.filter((entry) => !currentIds.has(seenId(entry))),
		currentAlertIds,
		seenTime,
		Math.min(
			slowest('createdAt') - overlapMs,
			...units.flatMap((unit) =>
				unit.fieldId === 'createdAt' && unit.next
					? [unit.next.resumeLowerEdge ?? Infinity, unit.next.resumeMs ?? Infinity]
					: [],
			),
		),
		MAX_SEEN_ALERT_IDS,
		'alert IDs',
		config,
	);

	const seenAlertVersions = retainSeen(
		previousSeenVersions,
		currentVersions,
		seenTime,
		(needsUpdated ? slowest('updatedAt') : slowest('createdAt')) - overlapMs,
		MAX_SEEN_ALERT_VERSIONS,
		'alert versions',
		config,
	);

	debugLog(config, 'Completed scheduled SentinelOne poll', {
		outputCount: outputItems.length,
		checkpointAdvanced: true,
		budgetStopped: units.some((unit) => unit.read?.stopped),
		seenAlertIdCount: seenAlertIds.length,
		seenAlertVersionCount: seenAlertVersions.length,
	});

	return {
		items: outputItems,
		nextState: {
			version: TRIGGER_STATE_VERSION,
			configFingerprint: fingerprint,
			initialized: true,
			activationMs,
			alertCursors,
			seenAlertIds,
			seenAlertVersions,
		},
	};
}
