import type { IDataObject, IHttpRequestOptions } from 'n8n-workflow';
import type { ScopeType } from '../shared/Scopes';
import { alertFieldSelection, additionalAlertOutput } from '../shared/AlertFields';
import { fetchOcsfDetail } from './Ocsf';
import type { ActivityCondition } from './ActivityConditions';

export type TriggerEvent = 'alert.new' | 'alert.updated' | 'alert.activity';
export type PollMode = 'manual' | 'scheduled';

export const MAX_SEEN_ALERT_IDS = 20_000;
export const MAX_SEEN_ALERT_VERSIONS = 40_000;
export const MANUAL_RESULT_LIMIT = 10;
export const MAX_SCOPE_IDS_PER_QUERY = 500;

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
	includeOcsf?: boolean;
	debug: boolean;
	debugLog?: (message: string, details?: IDataObject) => void;
	warnLog?: (message: string, details?: IDataObject) => void;
	overlapSeconds: number;
	concurrentRequests: number;
	requestTimeoutMs: number;
	alertPageSize: number;
	maxAlertPages: number;
}

export interface TriggerState extends IDataObject {
	configFingerprint?: string;
	initialized?: boolean;
	checkpointMs?: number;
	seenAlertIds?: string[];
	seenAlertVersions?: string[];
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
query PollAlerts($first: Int!, $after: String, $scope: ScopeSelectorInput!, $filters: [FilterInput!], $orFilter: OrFilterSelectionInput, $sortBy: String!) {
  alerts(first: $first, after: $after, scope: $scope, viewType: ALL, sort: { by: $sortBy, order: DESC }, filters: $filters, orFilter: $orFilter) {
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
					firstFailure ??= error;
				}
			}
		}),
	);
	if (firstFailure !== undefined) {
		throw new Error(
			firstFailure instanceof Error ? firstFailure.message : 'SentinelOne request failed',
		);
	}
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

function boundedUnique(previous: string[], current: string[], limit: number): string[] {
	const values = new Map<string, true>();
	for (const value of previous) values.set(value, true);
	for (const value of current) {
		values.delete(value);
		values.set(value, true);
	}
	return [...values.keys()].slice(-limit);
}

function assertStateCapacity(values: string[], limit: number, label: string): void {
	const uniqueCount = new Set(values).size;
	if (uniqueCount <= limit) return;
	throw new Error(
		`The poll found ${uniqueCount} ${label}, which exceeds the safe state limit of ${limit}. Narrow the scope or filters; state was not advanced.`,
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
	return filters;
}

async function fetchAlerts(
	request: AuthenticatedRequest,
	config: TriggerConfig,
	fieldId: 'createdAt' | 'updatedAt',
	start: number,
	end: number,
	maxItems?: number,
	splitDepth = 0,
	excludeUpdatedIds?: ReadonlySet<string>,
): Promise<Alert[]> {
	const alerts: Alert[] = [];
	const exclusions = compileExclusions(config);
	const seenCursors = new Set<string>();
	let after: string | undefined;
	for (let pageNumber = 1; pageNumber <= config.maxAlertPages; pageNumber++) {
		const remaining = maxItems === undefined ? undefined : maxItems - alerts.length;
		if (remaining !== undefined && remaining <= 0) return alerts.slice(0, maxItems);
		const first =
			remaining === undefined ? config.alertPageSize : Math.min(config.alertPageSize, remaining);
		const selection = advancedFilterSelection(
			buildFilters(config, fieldId, start, end),
			config.advancedFilters,
		);
		debugLog(config, 'Requesting Unified Alerts page', {
			fieldId,
			pageNumber,
			first,
			hasCursor: after !== undefined,
			scopeType: config.scopeType,
			scopeCount: config.scopeIds.length,
			filterMode: selection.orFilter ? 'orFilter' : 'filters',
		});
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
		debugLog(config, 'Received Unified Alerts page', {
			fieldId,
			pageNumber,
			itemCount: connection.edges?.length ?? 0,
			hasNextPage: connection.pageInfo.hasNextPage,
		});
		for (const edge of connection.edges ?? []) {
			const alert = edge?.node;
			if (!alert?.id) {
				throw new Error(`SentinelOne returned a ${fieldId} alert without an ID.`);
			}
			if (typeof alert[fieldId] !== 'string' || Number.isNaN(Date.parse(String(alert[fieldId])))) {
				throw new Error(
					`SentinelOne returned alert ${alert.id} without a usable ${fieldId} timestamp; state was not advanced.`,
				);
			}
			const scope = asRecord(asRecord(alert.realTime)?.scope);
			if (
				matchesExclusion(exclusions.account, asRecord(scope?.account)?.name) ||
				matchesExclusion(exclusions.site, asRecord(scope?.site)?.name) ||
				matchesExclusion(exclusions.group, asRecord(scope?.group)?.name)
			)
				continue;
			if (
				maxItems !== undefined &&
				fieldId === 'updatedAt' &&
				config.events.length === 1 &&
				config.events[0] === 'alert.updated' &&
				timeValue(alert.updatedAt) <= timeValue(alert.createdAt)
			)
				continue;
			if (fieldId === 'updatedAt' && excludeUpdatedIds?.has(alert.id)) continue;
			alerts.push(alert);
		}
		if (maxItems !== undefined && alerts.length >= maxItems) {
			return alerts.slice(0, maxItems);
		}
		const nextCursor = requireRelayCursor(
			connection.pageInfo,
			seenCursors,
			`${fieldId} alert query`,
		);
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
			const newer = await fetchAlerts(
				request,
				config,
				fieldId,
				midpoint + 1,
				end,
				maxItems,
				splitDepth + 1,
				excludeUpdatedIds,
			);
			if (maxItems !== undefined && newer.length >= maxItems) return newer.slice(0, maxItems);
			const older = await fetchAlerts(
				request,
				config,
				fieldId,
				start,
				midpoint,
				maxItems === undefined ? undefined : maxItems - newer.length,
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

async function fetchAlertStreams(
	request: AuthenticatedRequest,
	config: TriggerConfig,
	createdNeeded: boolean,
	updatedNeeded: boolean,
	createdStart: number,
	updatedStart: number,
	end: number,
	maxItems?: number,
): Promise<{ createdAlerts: Alert[]; updatedAlerts: Alert[] }> {
	const chunks: string[][] = [];
	for (let index = 0; index < config.scopeIds.length; index += MAX_SCOPE_IDS_PER_QUERY) {
		chunks.push(config.scopeIds.slice(index, index + MAX_SCOPE_IDS_PER_QUERY));
	}
	debugLog(config, 'Starting scoped alert query batches', {
		scopeCount: config.scopeIds.length,
		batchCount: chunks.length,
		batchSize: MAX_SCOPE_IDS_PER_QUERY,
	});
	if (
		maxItems !== undefined &&
		config.events.includes('alert.new') &&
		config.events.includes('alert.updated')
	) {
		// Classify preview creations first so they do not consume the update result limit.
		const createdAlerts = (
			await mapWithConcurrency(
				chunks,
				Math.min(config.concurrentRequests, 5),
				async (scopeIds) =>
					await fetchAlerts(
						request,
						{ ...config, scopeIds },
						'createdAt',
						createdStart,
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
					await fetchAlerts(
						request,
						{ ...config, scopeIds },
						'updatedAt',
						updatedStart,
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
				createdNeeded
					? fetchAlerts(request, scopedConfig, 'createdAt', createdStart, end, maxItems)
					: Promise.resolve<Alert[]>([]),
				updatedNeeded
					? fetchAlerts(request, scopedConfig, 'updatedAt', updatedStart, end, maxItems)
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

async function enrichOcsfItems(
	request: AuthenticatedRequest,
	config: TriggerConfig,
	items: IDataObject[],
): Promise<IDataObject[]> {
	if (!config.includeOcsf || items.length === 0) return items;
	const exclusions = compileExclusions(config);
	const alerts = new Map<string, { id: string; scopeId: string }>();
	for (const item of items) {
		if (item.eventType === 'alert.activity') continue;
		const id = config.simplifyOutput ? item.alertId : asRecord(item.alert)?.id;
		const scopeId = asRecord(item.scope)?.id;
		if (typeof id !== 'string' || typeof scopeId !== 'string' || !scopeId)
			throw new Error(
				'An alert is missing its actual scope ID; cannot safely retrieve OCSF detail. State was not advanced.',
			);
		alerts.set(id, { id, scopeId });
	}
	const details = new Map(
		await mapWithConcurrency(
			[...alerts.values()],
			Math.min(config.concurrentRequests, 5),
			async ({ id, scopeId }): Promise<[string, IDataObject | null]> => {
				const detail = await fetchOcsfDetail(
					request,
					config.baseUrl,
					id,
					config.scopeType,
					[scopeId],
					config.requestTimeoutMs,
				);
				const scope = alertScopeContext(config, detail as Alert);
				if (scope.id === null)
					throw new Error(
						'SentinelOne returned OCSF detail without its scope ID; state was not advanced.',
					);
				if (
					scope.id !== scopeId ||
					matchesExclusion(exclusions.account, asRecord(scope.account)?.name) ||
					matchesExclusion(exclusions.site, asRecord(scope.site)?.name) ||
					matchesExclusion(exclusions.group, asRecord(scope.group)?.name)
				)
					return [id, null];
				return [id, detail];
			},
		),
	);
	return items.flatMap((item) => {
		if (item.eventType === 'alert.activity') return [item];
		const id = String(config.simplifyOutput ? item.alertId : asRecord(item.alert)?.id);
		const detail = details.get(id);
		return detail
			? [{ ...item, ocsf: detail.ocsf ?? null, ocsfAlertUpdatedAt: detail.updatedAt ?? null }]
			: [];
	});
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
	const isBaseline = mode === 'scheduled' && !stateMatches;
	const checkpointMs =
		stateMatches && typeof previousState.checkpointMs === 'number'
			? previousState.checkpointMs
			: undefined;
	const defaultOverlapStart = Math.max(0, pollStartMs - config.overlapSeconds * 1000);
	const overlapStart =
		checkpointMs === undefined
			? defaultOverlapStart
			: Math.max(0, checkpointMs - config.overlapSeconds * 1000);
	const needsNew = config.events.includes('alert.new');
	const needsUpdated = config.events.includes('alert.updated');

	const alertEventStart = mode === 'manual' ? 0 : overlapStart;
	const manualFetchLimit = mode === 'manual' ? MANUAL_RESULT_LIMIT : undefined;
	const createdQueryStart = alertEventStart;
	const updatedQueryStart = alertEventStart;
	const queryCreated = needsNew || needsUpdated;
	const queryUpdated = needsUpdated;
	debugLog(config, 'Starting SentinelOne poll', {
		mode,
		isBaseline,
		scopeType: config.scopeType,
		scopeCount: config.scopeIds.length,
		events: config.events,
		severityCount: config.severities.length,
		statusCount: config.statuses.length,
		hasAlertNameFilter: config.alertName.trim().length > 0,
		overlapSeconds: config.overlapSeconds,
	});

	const { createdAlerts, updatedAlerts } = await fetchAlertStreams(
		request,
		config,
		queryCreated,
		queryUpdated,
		createdQueryStart,
		updatedQueryStart,
		pollStartMs,
		manualFetchLimit,
	);
	debugLog(config, 'Completed alert candidate queries', {
		createdCandidateCount: createdAlerts.length,
		updatedCandidateCount: updatedAlerts.length,
	});

	const useDurableDedupe = mode === 'scheduled' && stateMatches;
	const previousAlertIds = new Set(useDurableDedupe ? (previousState.seenAlertIds ?? []) : []);
	const previousVersions = new Set(useDurableDedupe ? (previousState.seenAlertVersions ?? []) : []);
	const currentAlertIds: string[] = [];
	const currentVersions: string[] = [];
	const items: IDataObject[] = [];
	const newInThisPoll = new Set<string>();
	const latestAlertById = new Map(
		unionById([...createdAlerts, ...updatedAlerts]).map((alert) => [alert.id, alert]),
	);
	const createdEventAlerts = sortAlertsBy(
		unionById(createdAlerts).filter(
			(alert) =>
				timeValue(alert.createdAt) >= alertEventStart && timeValue(alert.createdAt) <= pollStartMs,
		),
		'createdAt',
	);
	const updatedEventAlerts = sortAlertsBy(
		unionById(updatedAlerts).filter(
			(alert) =>
				timeValue(alert.updatedAt) >= alertEventStart && timeValue(alert.updatedAt) <= pollStartMs,
		),
		'updatedAt',
	);

	if (needsNew || needsUpdated) {
		for (const alert of createdEventAlerts) {
			currentAlertIds.push(alert.id);
			const isNewForClassification =
				mode === 'manual'
					? needsNew || timeValue(alert.updatedAt) <= timeValue(alert.createdAt)
					: !previousAlertIds.has(alert.id);
			if (isNewForClassification) {
				newInThisPoll.add(alert.id);
			}
			if (needsNew && !isBaseline && !previousAlertIds.has(alert.id)) {
				items.push(alertOutput(config, 'alert.new', latestAlertById.get(alert.id) ?? alert));
			}
		}
	}

	if (needsUpdated) {
		for (const alert of updatedEventAlerts) {
			if (!alert.updatedAt) continue;
			const version = `${alert.id}\u0000${alert.updatedAt}`;
			currentVersions.push(version);
			if (!isBaseline && !newInThisPoll.has(alert.id) && !previousVersions.has(version)) {
				items.push(alertOutput(config, 'alert.updated', alert));
			}
		}
	}

	if (mode === 'manual') {
		const manualItems = await enrichOcsfItems(
			request,
			config,
			sortOutputs(items).slice(-MANUAL_RESULT_LIMIT),
		);
		debugLog(config, 'Completed manual SentinelOne poll', {
			outputCount: manualItems.length,
			outputLimit: MANUAL_RESULT_LIMIT,
		});
		return { items: manualItems };
	}
	assertStateCapacity(currentAlertIds, MAX_SEEN_ALERT_IDS, 'alert IDs');
	assertStateCapacity(currentVersions, MAX_SEEN_ALERT_VERSIONS, 'alert versions');
	const outputItems = isBaseline ? [] : await enrichOcsfItems(request, config, sortOutputs(items));
	debugLog(config, 'Completed scheduled SentinelOne poll', {
		outputCount: outputItems.length,
		checkpointAdvanced: true,
		seenAlertIdCount: currentAlertIds.length,
		seenAlertVersionCount: currentVersions.length,
	});

	return {
		items: outputItems,
		nextState: {
			configFingerprint: fingerprint,
			initialized: true,
			checkpointMs: pollStartMs,
			seenAlertIds: boundedUnique(
				stateMatches ? (previousState.seenAlertIds ?? []) : [],
				currentAlertIds,
				MAX_SEEN_ALERT_IDS,
			),
			seenAlertVersions: boundedUnique(
				stateMatches ? (previousState.seenAlertVersions ?? []) : [],
				currentVersions,
				MAX_SEEN_ALERT_VERSIONS,
			),
		},
	};
}
