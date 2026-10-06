import type { IDataObject } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { fingerprintConfig, TRIGGER_STATE_VERSION } from './SentinelOneTriggerHelpers';
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
import { isRetryableReadError, responseStatus, retryAfterMs } from '../shared/transport/retry';
import { PollBudgetError } from '../shared/transport/request';
import { ActivityFeedBudgetError } from './ActivityFeed';

// SDL rejects Unix epoch dates; use a verified historical query boundary.
const PREVIEW_START_MS = Date.UTC(2020, 0, 1);

/** Poll budget kept back from the feed read for the current alert lookup that follows it. */
const ALERT_LOOKUP_RESERVE_MS = 10_000;

export const ACTIVITY_STATE_LIMIT = 40_000;

export const ALERT_QUERY = `query ActivityAlerts($first: Int!, $after: String, $scope: ScopeSelectorInput!, $filters: [FilterInput!]) {
  alerts(first: $first, after: $after, scope: $scope, viewType: ALL, filters: $filters) {
    edges { node { id externalId name severity status analystVerdict realTime { scope { account { id name } site { id name } group { id name } } } } }
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
			// The lookup keeps the batches that completed; the poll cuts its window before the first activity still waiting.
			// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
			if (error instanceof PollBudgetError) throw error;

			// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
			if (error instanceof NodeApiError) throw error;
			const status = responseStatus(error);

			const failure = fail(
				`current alert lookup failed${status ? ` (HTTP ${status})` : ''}. Check alert read permissions and service availability`,
			);

			throw Object.assign(failure, { cause: error, statusCode: status ?? undefined });
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
	/** Alert IDs whose lookup the poll budget cut short; nothing is known about them yet. */
	pendingIds: Set<string>;
	/** Preserve the HTTP failure if no resolved prefix can advance the poll. */
	stopped?: unknown;
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
	const pendingIds = new Set<string>();
	let stopped: unknown;

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

		const transientStops: unknown[] = [];
		let completedBatches = 0;

		const results = await parallel(batches, async ({ chunk, scopes }) => {
			const filters: IDataObject[] = [{ fieldId: 'id', stringIn: { values: chunk } }];

			if (filtered) {
				if (config.severities.length)
					filters.push({ fieldId: 'severity', stringIn: { values: config.severities } });

				if (config.statuses.length)
					filters.push({ fieldId: 'status', stringIn: { values: config.statuses } });
				filters.push({ fieldId: 'alertName', match: { values: [config.alertName.trim()] } });
			}

			let found: IDataObject[];

			try {
				found = await pages(
					request,
					config,
					ALERT_QUERY,
					{ first: 200, filters, scope: { scopeType, scopeIds: scopes } },
					'alerts',
					config.maxAlertPages,
				);
			} catch (error) {
				if (!(error instanceof PollBudgetError)) {
					// The trigger boundary wraps lookup failures with its node context.
					if (
						responseStatus(error) === null ||
						!isRetryableReadError(error) ||
						Date.now() + Math.max(1000, retryAfterMs(error)) < (config.pollDeadlineMs ?? Infinity)
					)
						// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
						throw error;
					transientStops.push(error);
					stopped ??= error;
				}

				for (const id of chunk) pendingIds.add(id);

				return [];
			}

			for (const alert of found) {
				if (!stringId(alert.id) || !chunk.includes(alert.id))
					throw fail('received an unrequested alert');
				const scope = scopeOf(config, alert);
				const accountId = record(scope.account)?.id;

				if (!stringId(accountId) || !(filtered ? accounts : scopes).includes(accountId))
					throw fail('received an alert outside the requested account scope');
			}

			completedBatches++;

			return found;
		});

		// Wait for concurrent batches before deciding whether a transient stop has progress to hand over.
		if (transientStops.length && completedBatches === 0) throw transientStops[0];

		for (const error of transientStops) {
			try {
				config.warnLog?.(
					'Current alert lookup stopped before its retry fit the poll time budget.',
					{
						httpStatus: responseStatus(error),
					},
				);
			} catch {
				// Logging must not change delivery or checkpoint state.
			}
		}

		return results.flat();
	}

	const found = await lookup(ids, 'ACCOUNT', accounts, false);
	const alerts = new Map<string, IDataObject>();
	const unresolvedIds = new Set(ids.filter((id) => !pendingIds.has(id)));

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
	}

	if (config.alertName.trim() && alerts.size) {
		const filtered = new Map(
			(await lookup([...alerts.keys()], config.scopeType, config.scopeIds, true)).map((alert) => [
				String(alert.id),
				alert,
			]),
		);

		for (const id of alerts.keys()) {
			if (pendingIds.has(id)) {
				alerts.delete(id);
				continue;
			}

			const alert = filtered.get(id);

			if (alert && !stringId(scopeOf(config, alert).id)) {
				throw fail('could not resolve current alert scope from a returned alert');
			}

			if (alert && eligible(alert)) alerts.set(id, alert);
			else {
				alerts.delete(id);
			}
		}
	}

	return { alerts, unresolvedIds, pendingIds, stopped };
}

function output(config: TriggerConfig, alert: IDataObject, event: ActivityFeedEvent): IDataObject {
	const scope = scopeOf(config, alert);

	const item: IDataObject = {
		alertId: event.alertId,
		alertName: alert.name ?? null,
		alertExternalId: alert.externalId ?? null,
		eventType: 'alert.activity',
		eventId: [new URL(config.baseUrl).host, 'alert', event.alertId, 'activity', event.activityId]
			.map(encodeURIComponent)
			.join('/'),
		eventTime: event.createdAt,
		activityId: event.activityId,
		activityTypeId: event.activityTypeId,
		activityKind: event.activityKind,
		eventTimestamp: event.createdAt,
		changes: event.changes,
	};

	if (config.simplifyOutput) {
		const fields: Record<string, string> = {
			'16001': 'status',
			'16002': 'analystVerdict',
			'16003': 'severity',
			'16004': 'assigneeEmail',
		};

		const field = fields[event.activityTypeId];
		const change = event.changes.find((entry) => entry.field === field);

		// Assignee arrives as email and id entries for one change; keep the id beside the emails.
		const assigneeId =
			field === 'assigneeEmail'
				? event.changes.find((entry) => entry.field === 'assigneeId')
				: undefined;

		const simplified: IDataObject = {
			eventId: item.eventId,
			eventType: item.eventType,
			eventTime: item.eventTime,
			activityKind: event.activityKind,
			// An unrecognised type keeps its numeric id, the only thing that identifies it.
			...(event.activityKind === 'unknown' ? { activityTypeId: event.activityTypeId } : {}),
			...(field && event.changes.length
				? {
						change: {
							field: field === 'assigneeEmail' ? 'assignee' : field,
							...(change && 'oldValue' in change ? { from: change.oldValue } : {}),
							...(change && 'newValue' in change ? { to: change.newValue } : {}),
							...(assigneeId && 'newValue' in assigneeId ? { toId: assigneeId.newValue } : {}),
						},
					}
				: event.changes.length
					? { changes: event.changes }
					: {}),
			...(event.activityKind === 'noteCreated' && typeof event.noteText === 'string'
				? { note: event.noteText }
				: {}),
			actor: { id: event.authorId, name: event.authorName },
			alertId: event.alertId,
			alertName: alert.name ?? null,
			alertExternalId: alert.externalId ?? null,
			alertStatus: alert.status ?? null,
			alertSeverity: alert.severity ?? null,
			alertAnalystVerdict: alert.analystVerdict ?? null,
			accountId: record(scope.account)?.id ?? null,
			accountName: record(scope.account)?.name ?? null,
			siteId: record(scope.site)?.id ?? null,
			siteName: record(scope.site)?.name ?? null,
			groupId: record(scope.group)?.id ?? null,
			groupName: record(scope.group)?.name ?? null,
		};

		if (event.mitigation !== undefined) simplified.mitigation = event.mitigation;

		if (config.includeRawActivity) {
			if (!event.rawActivity) throw fail('omitted the full activity record');
			simplified.rawActivity = event.rawActivity;
		}

		if (config.includeCurrentAlert) simplified.currentAlert = alert;

		return simplified;
	}

	if (event.noteText !== undefined) item.note = { text: event.noteText };

	if (event.mitigation !== undefined) item.mitigation = event.mitigation;
	Object.assign(item, {
		currentAlertStatus: alert.status ?? null,
		currentAlertSeverity: alert.severity ?? null,
		currentAlertAnalystVerdict: alert.analystVerdict ?? null,
		actor: { id: event.authorId, name: event.authorName },
		scope: { ...scope, source: 'current' },
	});

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

function warnNoProgress(config: TriggerConfig, position: number): void {
	try {
		config.warnLog?.(
			`The activity stream in scope batch 1 stopped at ${new Date(position).toISOString()} without completing a forward window.`,
			{
				scopeBatch: 1,
				stream: 'activity',
				scopeType: config.scopeType,
				scopeIds: config.scopeIds,
				position: new Date(position).toISOString(),
			},
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
	const now = timing?.now ?? Date.now;
	const deadline = config.pollDeadlineMs ?? Infinity;
	const originalRequest = request;
	request = async (options, readerDeadline) => {
		const remaining = deadline - now();

		if (remaining <= 0) throw new PollBudgetError();

		return originalRequest(
			{
				...options,
				timeout: Math.max(1, Math.min(options.timeout ?? config.requestTimeoutMs, remaining)),
			},
			readerDeadline,
		);
	};

	const exclusions = compileExclusions(config);

	const selected = (event: ActivityFeedEvent) =>
		(!config.activityTypeIds || config.activityTypeIds.includes(event.activityTypeId)) &&
		!matchesExclusion(exclusions.author, event.authorName) &&
		!(config.excludeActorIds ?? []).includes(event.authorId ?? '') &&
		matchesActivityConditions(event, config.activityConditions, config.conditionMatch);

	const fingerprint = `${fingerprintConfig(config)}:sdl-activities-v1`;

	const matches =
		mode === 'scheduled' &&
		previousState.version === TRIGGER_STATE_VERSION &&
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
			{ ...timing, warnLog: config.warnLog },
			async (events) => {
				const candidates = events.filter(selected);

				const lookup = await currentAlerts(request, config, [
					...new Set(candidates.map((event) => event.alertId)),
				]);

				if (lookup.pendingIds.size)
					throw fail('ran out of the n8n poll time budget during the current alert lookup');
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
	}

	const baseline = mode === 'scheduled' && !matches;

	// The feed stops early enough to leave the lookup its reserve; the transport enforces the budget itself.
	const feedTiming: ActivityFeedTiming = {
		...timing,
		warnLog: config.warnLog,
		...(config.pollDeadlineMs !== undefined
			? {
					deadlineMs: Math.max(
						1,
						Math.min(
							timing?.deadlineMs ?? Infinity,
							Math.floor(deadline - ALERT_LOOKUP_RESERVE_MS - now()),
						),
					),
				}
			: {}),
	};

	// A baseline reads through the same resumable prefix, so a budget stop saves its progress and the activation time instead of restarting activation.
	const startMs = Math.max(0, Math.floor(start));
	let result;

	try {
		result = await readActivityFeedPrefix(request, {
			baseUrl: config.baseUrl,
			startMs,
			endMs: pollStartMs,
			accountIds,
			timing: feedTiming,
			checkpointMs: baseline ? startMs : Number(checkpoint),
			activityTypeIds: config.activityTypeIds,
			includeRawActivity: config.includeRawActivity,
		});
	} catch (error) {
		if (error instanceof ActivityFeedBudgetError) {
			const position = baseline ? startMs : Number(checkpoint);
			const budget = error.kind === 'event-count' ? 'activity event budget' : 'query budget';
			warnNoProgress(config, position);
			throw fail(
				`activity stream is stuck at checkpoint ${new Date(position).toISOString()} because its ${budget} ended before a forward window completed`,
			);
		}

		// Transport failures keep their identity for the trigger boundary to report.
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
		throw error;
	}

	let activities = result.events;
	let end = result.completedThroughMs;

	if (end <= (baseline ? startMs : Number(checkpoint))) {
		const position = baseline ? startMs : Number(checkpoint);
		warnNoProgress(config, position);
		throw fail(
			`activity stream is stuck at checkpoint ${new Date(position).toISOString()} and did not complete a forward window within the query budget`,
		);
	}

	let items: IDataObject[] = [];
	let dropped = 0;

	if (!baseline) {
		let candidates = activities.filter(
			(event) =>
				!previous.has(event.activityId) &&
				selected(event) &&
				BigInt(event.timestampNs) >= BigInt(Number(activation)) * BigInt(1000000),
		);

		const lookup = await currentAlerts(request, config, [
			...new Set(candidates.map((event) => event.alertId)),
		]);

		// A lookup the poll budget cut short ends this poll's window at the first activity still waiting on it; every earlier activity, including ones in the same millisecond, is delivered and retained, so the next poll starts past them.
		const waiting = candidates.find((event) => lookup.pendingIds.has(event.alertId));

		if (waiting) {
			end = Math.max(Number(checkpoint), Number(BigInt(waiting.timestampNs) / BigInt(1000000)));

			const before = (event: ActivityFeedEvent) =>
				BigInt(event.timestampNs) < BigInt(waiting.timestampNs);

			activities = activities.filter(before);
			candidates = candidates.filter(before);

			if (
				end <= Number(checkpoint) &&
				candidates.every((event) => previous.has(event.activityId))
			) {
				warnNoProgress(config, Number(checkpoint));

				// The trigger boundary reports the original transient HTTP status when there is no prefix to hand over.
				if (lookup.stopped !== undefined) throw lookup.stopped;

				throw fail(
					`activity stream is stuck at checkpoint ${new Date(Number(checkpoint)).toISOString()} because the n8n poll time budget ended before the current alert lookup completed a forward window`,
				);
			}
		}

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

	if (previous.size > ACTIVITY_STATE_LIMIT) {
		const evicted = previous.size - ACTIVITY_STATE_LIMIT;

		const oldest = [...previous].sort(([, left], [, right]) =>
			BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0,
		);

		for (const [id] of oldest.slice(0, evicted)) previous.delete(id);

		try {
			config.warnLog?.('Evicted oldest activity keys from the recent deduplication cache.', {
				evictedActivityCount: evicted,
			});
		} catch {
			// Logging must not change delivery or checkpoint state.
		}
	}

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
			version: TRIGGER_STATE_VERSION,
			seenActivityTimestamps: Object.fromEntries(previous),
		},
	};
}
