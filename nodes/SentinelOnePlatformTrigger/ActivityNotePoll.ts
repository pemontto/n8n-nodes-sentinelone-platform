import type { IDataObject } from 'n8n-workflow';
import { fingerprintConfig } from './SentinelOneTriggerHelpers';
import type {
	AuthenticatedRequest,
	TriggerConfig,
	TriggerState,
	PollMode,
	PollResult,
} from './SentinelOneTriggerHelpers';
import {
	readActivityFeed,
	readActivityFeedPrefix,
	type ActivityFeedEvent,
	type ActivityFeedTiming,
} from './ActivityFeed';
import { compileExclusions, matchesExclusion } from './Exclusions';
import { matchesActivityConditions } from './ActivityConditions';
import { responseStatus } from '../shared/transport/retry';

// SDL rejects Unix epoch dates; use a verified historical query boundary.
const PREVIEW_START_MS = Date.UTC(2020, 0, 1);

export const ACTIVITY_STATE_LIMIT = 40_000;
export const ALERT_QUERY = `query ActivityAlerts($first: Int!, $after: String, $scope: ScopeSelectorInput!, $filters: [FilterInput!]) {
  alerts(first: $first, after: $after, scope: $scope, viewType: ALL, filters: $filters) {
    edges { node { id name severity status realTime { scope { account { id name } site { id name } group { id name } } } } }
    pageInfo { hasNextPage endCursor }
  }
}`;
function record(value: unknown): IDataObject | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as IDataObject)
		: undefined;
}
function fail(message: string): Error {
	return new Error(`SentinelOne activity polling ${message}; state was not advanced.`);
}
function stringId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.trim() === value;
}
async function parallel<T, R>(items: T[], worker: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	let position = 0;
	const failures: unknown[] = [];
	await Promise.all(
		Array.from({ length: Math.min(5, items.length) }, async () => {
			while (position < items.length && failures.length === 0) {
				const index = position++;
				await worker(items[index]).then(
					(value) => {
						results[index] = value;
					},
					(error: unknown) => {
						failures.push(error);
					},
				);
			}
		}),
	);
	if (failures.length) throw failures[0];
	return results;
}

async function pages(
	request: AuthenticatedRequest,
	config: TriggerConfig,
	query: string,
	variables: IDataObject,
	key: string,
	maxPages: number,
): Promise<IDataObject[]> {
	const rows: IDataObject[] = [];
	const cursors = new Set<string>();
	let after: string | null = null;
	for (let page = 0; page < maxPages; page++) {
		let response: IDataObject | undefined;
		try {
			response = record(
				await request({
					method: 'POST',
					url: `${config.baseUrl}/web/api/v2.1/unifiedalerts/graphql`,
					timeout: config.requestTimeoutMs,
					json: true,
					body: { query, variables: { ...variables, after } },
				}),
			);
		} catch (error) {
			const status = responseStatus(error);
			throw fail(
				`current alert lookup failed${status ? ` (HTTP ${status})` : ''}. Check alert read permissions and service availability`,
			);
		}
		if (
			response?.errors !== undefined &&
			(!Array.isArray(response.errors) || response.errors.length > 0)
		)
			throw fail('current alert lookup received GraphQL errors; check alert read permissions');
		const connection = record(record(response?.data)?.[key]);
		const info = record(connection?.pageInfo);
		if (!Array.isArray(connection?.edges) || typeof info?.hasNextPage !== 'boolean')
			throw fail('received an incomplete page');
		for (const edge of connection.edges) {
			const node = record(record(edge)?.node);
			if (!node) throw fail('received an invalid page row');
			rows.push(node);
		}
		if (!info.hasNextPage) return rows;
		if (!stringId(info.endCursor) || cursors.has(info.endCursor))
			throw fail('received a missing or repeated cursor');
		cursors.add(info.endCursor);
		after = info.endCursor;
	}
	throw fail('exceeded its page limit');
}

function scopeOf(config: TriggerConfig, alert: IDataObject): IDataObject {
	const value = record(record(alert.realTime)?.scope);
	const entity = (key: string) => {
		const item = record(value?.[key]);
		return item ? { id: item.id ?? null, name: item.name ?? null } : null;
	};
	const account = entity('account'),
		site = entity('site'),
		group = entity('group');
	const selected =
		config.scopeType === 'ACCOUNT' ? account : config.scopeType === 'SITE' ? site : group;
	return {
		type: config.scopeType,
		id: selected?.id ?? null,
		name: selected?.name ?? null,
		account,
		site,
		group,
	};
}

interface AlertLookup {
	alerts: Map<string, IDataObject>;
	unresolvedIds: Set<string>;
	ineligibleIds: Set<string>;
}

async function currentAlerts(
	request: AuthenticatedRequest,
	config: TriggerConfig & { activityAccountIds?: string[] },
	ids: string[],
): Promise<AlertLookup> {
	const exclusions = compileExclusions(config);
	const accounts =
		config.activityAccountIds ?? (config.scopeType === 'ACCOUNT' ? config.scopeIds : []);
	if (!accounts.length) throw fail('requires resolved account IDs');
	async function lookup(
		wanted: string[],
		scopeType: 'ACCOUNT' | 'SITE' | 'GROUP',
		scopeIds: string[],
		filtered: boolean,
	): Promise<IDataObject[]> {
		const batches: Array<{ chunk: string[]; scopes: string[] }> = [];
		for (let offset = 0; offset < wanted.length; offset += 200)
			for (let index = 0; index < scopeIds.length; index += 500)
				batches.push({
					chunk: wanted.slice(offset, offset + 200),
					scopes: scopeIds.slice(index, index + 500),
				});
		return (
			await parallel(batches, async ({ chunk, scopes }) => {
				const filters: IDataObject[] = [{ fieldId: 'id', stringIn: { values: chunk } }];
				if (filtered) {
					if (config.severities.length)
						filters.push({ fieldId: 'severity', stringIn: { values: config.severities } });
					if (config.statuses.length)
						filters.push({ fieldId: 'status', stringIn: { values: config.statuses } });
					filters.push({ fieldId: 'alertName', match: { values: [config.alertName.trim()] } });
				}
				const found = await pages(
					request,
					config,
					ALERT_QUERY,
					{ first: 200, filters, scope: { scopeType, scopeIds: scopes } },
					'alerts',
					config.maxAlertPages,
				);
				for (const alert of found) {
					if (!stringId(alert.id) || !chunk.includes(alert.id))
						throw fail('received an unrequested alert');
					const scope = scopeOf(config, alert);
					const accountId = record(scope.account)?.id;
					if (!stringId(accountId) || !(filtered ? accounts : scopes).includes(accountId))
						throw fail('received an alert outside the requested account scope');
				}
				return found;
			})
		).flat();
	}
	const found = await lookup(ids, 'ACCOUNT', accounts, false);
	const alerts = new Map<string, IDataObject>();
	const unresolvedIds = new Set(ids);
	const ineligibleIds = new Set<string>();
	const eligible = (alert: IDataObject) => {
		const scope = scopeOf(config, alert);
		return (
			stringId(scope.id) &&
			config.scopeIds.includes(scope.id) &&
			(!config.severities.length || config.severities.includes(String(alert.severity))) &&
			(!config.statuses.length || config.statuses.includes(String(alert.status))) &&
			!matchesExclusion(exclusions.account, record(scope.account)?.name) &&
			!matchesExclusion(exclusions.site, record(scope.site)?.name) &&
			!matchesExclusion(exclusions.group, record(scope.group)?.name)
		);
	};
	for (const alert of found) {
		const id = String(alert.id);
		if (!stringId(scopeOf(config, alert).id))
			throw fail('could not resolve current alert scope from a returned alert');
		unresolvedIds.delete(id);
		if (eligible(alert)) alerts.set(id, alert);
		else ineligibleIds.add(id);
	}
	if (config.alertName.trim() && alerts.size) {
		const filtered = new Map(
			(await lookup([...alerts.keys()], config.scopeType, config.scopeIds, true)).map((alert) => [
				String(alert.id),
				alert,
			]),
		);
		for (const id of alerts.keys()) {
			const alert = filtered.get(id);
			if (alert && !stringId(scopeOf(config, alert).id)) {
				throw fail('could not resolve current alert scope from a returned alert');
			}
			if (alert && eligible(alert)) alerts.set(id, alert);
			else {
				alerts.delete(id);
				ineligibleIds.add(id);
			}
		}
	}
	return { alerts, unresolvedIds, ineligibleIds };
}

function output(config: TriggerConfig, alert: IDataObject, event: ActivityFeedEvent): IDataObject {
	const scope = scopeOf(config, alert);
	const item: IDataObject = {
		eventType: 'alert.activity',
		activityId: event.activityId,
		activityTypeId: event.activityTypeId,
		activityKind: event.activityKind,
		alertId: event.alertId,
		eventTimestamp: event.createdAt,
		actor: { id: event.authorId, name: event.authorName },
		scope: { ...scope, source: 'current' },
		changes: event.changes,
	};
	if (event.noteText !== undefined) item.note = { text: event.noteText };
	if (event.mitigation !== undefined) item.mitigation = event.mitigation;
	if (config.includeRawActivity) {
		if (!event.rawActivity) throw fail('omitted the full activity record');
		item.rawActivity = event.rawActivity;
	}
	if (config.includeCurrentAlert) item.currentAlert = alert;
	return item;
}

function expiredMissingActivities(
	config: TriggerConfig,
	candidates: ActivityFeedEvent[],
	lookup: AlertLookup,
	pollStartMs: number,
): number {
	const retryFrom =
		BigInt(Math.max(0, Math.floor(pollStartMs - config.overlapSeconds * 1000))) * BigInt(1000000);
	const missing = candidates.filter((event) => lookup.unresolvedIds.has(event.alertId));
	if (missing.some((event) => BigInt(event.timestampNs) >= retryFrom))
		throw fail(
			'could not resolve current alert scope for a recent activity; retry while alert indexing completes',
		);
	return missing.length;
}

function warnDropped(config: TriggerConfig, count: number): void {
	if (!count) return;
	try {
		config.warnLog?.(
			'Dropped alert activities whose parent alerts remained unavailable beyond the overlap retry window.',
			{ droppedActivityCount: count },
		);
	} catch {
		// Logging must not change delivery or checkpoint state.
	}
}

export async function pollAlertActivities(
	request: AuthenticatedRequest,
	config: TriggerConfig & { activityAccountIds?: string[] },
	previousState: TriggerState,
	mode: PollMode,
	pollStartMs: number,
	timing?: ActivityFeedTiming,
): Promise<PollResult> {
	const exclusions = compileExclusions(config);
	const selected = (event: ActivityFeedEvent) =>
		(!config.activityTypeIds || config.activityTypeIds.includes(event.activityTypeId)) &&
		!matchesExclusion(exclusions.author, event.authorName) &&
		!(config.excludeActorIds ?? []).includes(event.authorId ?? '') &&
		matchesActivityConditions(event, config.activityConditions, config.conditionMatch);
	const fingerprint = `${fingerprintConfig(config)}:sdl-activities-v1`;
	const matches =
		mode === 'scheduled' &&
		previousState.configFingerprint === fingerprint &&
		previousState.initialized === true;
	const checkpoint = matches ? previousState.checkpointMs : undefined;
	const activation = matches ? previousState.activityActivationMs : pollStartMs;
	if (
		matches &&
		(typeof activation !== 'number' ||
			!Number.isFinite(activation) ||
			typeof checkpoint !== 'number' ||
			!Number.isFinite(checkpoint) ||
			activation > checkpoint ||
			checkpoint > pollStartMs)
	)
		throw fail('has an invalid activation checkpoint');
	const accountIds =
		config.activityAccountIds ?? (config.scopeType === 'ACCOUNT' ? config.scopeIds : undefined);
	if (!accountIds?.length || !config.scopeIds.length)
		throw fail('requires resolved account and selected scope IDs');
	if (mode === 'manual') {
		const preview: IDataObject[] = [];
		let dropped = 0;
		await readActivityFeed(
			request,
			config.baseUrl,
			PREVIEW_START_MS,
			pollStartMs,
			accountIds,
			timing,
			async (events) => {
				const candidates = events.filter(selected);
				const lookup = await currentAlerts(request, config, [
					...new Set(candidates.map((event) => event.alertId)),
				]);
				dropped += expiredMissingActivities(config, candidates, lookup, pollStartMs);
				const eligible = candidates.filter((event) => lookup.alerts.has(event.alertId));
				eligible.sort((a, b) =>
					BigInt(a.timestampNs) < BigInt(b.timestampNs)
						? 1
						: BigInt(a.timestampNs) > BigInt(b.timestampNs)
							? -1
							: b.activityId.localeCompare(a.activityId),
				);
				for (const event of eligible.slice(0, 10 - preview.length))
					preview.push(output(config, lookup.alerts.get(event.alertId)!, event));
				return preview.length > 0;
			},
			config.includeRawActivity,
			config.activityTypeIds,
		);
		warnDropped(config, dropped);
		return { items: preview };
	}
	const start = (checkpoint ?? pollStartMs) - config.overlapSeconds * 1000;
	const previous = new Map<string, string>();
	if (matches) {
		const timestamps = record(previousState.seenActivityTimestamps);
		if (!timestamps) throw fail('has invalid saved activity timestamps');
		for (const [id, timestamp] of Object.entries(timestamps)) {
			if (!stringId(id) || typeof timestamp !== 'string' || !/^\d{1,30}$/.test(timestamp))
				throw fail('has invalid saved activity identities');
			previous.set(id, timestamp);
		}
		if (previous.size > ACTIVITY_STATE_LIMIT) throw fail('exceeded the activity state capacity');
	}
	const baseline = mode === 'scheduled' && !matches;
	const result = baseline
		? {
				events: await readActivityFeed(
					request,
					config.baseUrl,
					Math.max(0, Math.floor(start)),
					pollStartMs,
					accountIds,
					timing,
					undefined,
					config.includeRawActivity,
					config.activityTypeIds,
				),
				completedThroughMs: pollStartMs,
			}
		: await readActivityFeedPrefix(request, {
				baseUrl: config.baseUrl,
				startMs: Math.max(0, Math.floor(start)),
				endMs: pollStartMs,
				accountIds,
				timing,
				checkpointMs: Number(checkpoint),
				activityTypeIds: config.activityTypeIds,
			});
	const activities = result.events;
	const end = result.completedThroughMs;
	if (!baseline && end <= Number(checkpoint))
		throw fail('did not complete a forward checkpoint window within the query budget');
	if (activities.length > ACTIVITY_STATE_LIMIT) throw fail('exceeded the activity state capacity');
	let items: IDataObject[] = [];
	let dropped = 0;
	if (!baseline) {
		const candidates = activities.filter(
			(event) =>
				!previous.has(event.activityId) &&
				selected(event) &&
				BigInt(event.timestampNs) >= BigInt(Number(activation)) * BigInt(1000000),
		);
		const lookup = await currentAlerts(request, config, [
			...new Set(candidates.map((event) => event.alertId)),
		]);
		dropped = expiredMissingActivities(config, candidates, lookup, pollStartMs);
		items = candidates.flatMap((event) => {
			const alert = lookup.alerts.get(event.alertId);
			return alert ? [output(config, alert, event)] : [];
		});
	}
	for (const event of activities) {
		const earlier = previous.get(event.activityId);
		if (earlier === undefined || BigInt(event.timestampNs) > BigInt(earlier))
			previous.set(event.activityId, event.timestampNs);
	}
	const retainFrom =
		BigInt(Math.max(0, Math.floor(end - config.overlapSeconds * 1000))) * BigInt(1000000);
	for (const [id, timestamp] of previous) if (BigInt(timestamp) < retainFrom) previous.delete(id);
	if (previous.size > ACTIVITY_STATE_LIMIT)
		throw fail('exceeded the activity state capacity inside the overlap');
	warnDropped(config, dropped);
	if (config.debug)
		config.debugLog?.('Completed direct ActivityFeed activity poll', {
			outputCount: items.length,
			checkpointAdvanced: true,
			seenActivityCount: previous.size,
		});
	return {
		items,
		nextState: {
			configFingerprint: fingerprint,
			initialized: true,
			checkpointMs: end,
			activityActivationMs: activation,
			seenActivityIds: [...previous.keys()],
			seenActivityTimestamps: Object.fromEntries(previous),
		},
	};
}
