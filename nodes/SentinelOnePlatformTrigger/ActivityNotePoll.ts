import type { IDataObject } from 'n8n-workflow';
import { fingerprintConfig } from './SentinelOneTriggerHelpers';
import type {
	AuthenticatedRequest,
	TriggerConfig,
	TriggerState,
	PollMode,
	PollResult,
} from './SentinelOneTriggerHelpers';
import { readActivityFeed, type ActivityFeedEvent, type ActivityFeedTiming } from './ActivityFeed';
import { compileExclusions, matchesExclusion } from './Exclusions';

// SDL rejects Unix epoch dates; use a verified historical query boundary.
const PREVIEW_START_MS = Date.UTC(2020, 0, 1);

export const ACTIVITY_NOTE_STATE_LIMIT = 40_000;
export const ALERT_QUERY = `query ActivityNoteAlerts($first: Int!, $after: String, $scope: ScopeSelectorInput!, $filters: [FilterInput!]) {
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
	return new Error(`SentinelOne note polling ${message}; state was not advanced.`);
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
	if (failures.length) throw fail('could not finish all alert or note requests');
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
		const response = record(
			await request({
				method: 'POST',
				url: `${config.baseUrl}/web/api/v2.1/unifiedalerts/graphql`,
				timeout: config.requestTimeoutMs,
				json: true,
				body: { query, variables: { ...variables, after } },
			}),
		);
		if (
			response?.errors !== undefined &&
			(!Array.isArray(response.errors) || response.errors.length > 0)
		)
			throw fail('received GraphQL errors');
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
	config: TriggerConfig & { noteAccountIds?: string[] },
	ids: string[],
): Promise<AlertLookup> {
	const exclusions = compileExclusions(config);
	const accounts = config.noteAccountIds ?? (config.scopeType === 'ACCOUNT' ? config.scopeIds : []);
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
	const note: IDataObject = {
		alertId: event.alertId,
		activityId: event.activityId,
		id: null,
		actionType: 'CREATE',
		createdAt: event.createdAt,
		updatedAt: null,
		eventText: 'New note was added to alert',
		text: { content: event.noteText, type: null },
		createdBy:
			event.authorId !== null || event.authorName !== null
				? { userId: event.authorId, fullName: event.authorName }
				: null,
	};
	if (!config.simplifyOutput) {
		if (!event.rawActivity) throw fail('omitted the full activity record');
		return {
			eventType: 'alert.note.created',
			eventTimestamp: event.createdAt,
			activityId: event.activityId,
			scope,
			note,
			activity: event.rawActivity,
		};
	}
	return {
		eventType: 'alert.note.created',
		eventTimestamp: event.createdAt,
		scope,
		alertId: event.alertId,
		activityId: event.activityId,
		noteId: null,
		actionType: 'CREATE',
		createdAt: event.createdAt,
		updatedAt: null,
		noteType: null,
		noteText: event.noteText,
		authorType: null,
		authorId: event.authorId,
		authorName: event.authorName,
		authorEmail: null,
	};
}

export async function pollActivityNotes(
	request: AuthenticatedRequest,
	config: TriggerConfig & { noteAccountIds?: string[] },
	previousState: TriggerState,
	mode: PollMode,
	pollStartMs: number,
	timing?: ActivityFeedTiming,
): Promise<PollResult> {
	const exclusions = compileExclusions(config);
	const fingerprint = `${fingerprintConfig(config)}:sdl-notes-v2`;
	const matches =
		mode === 'scheduled' &&
		previousState.configFingerprint === fingerprint &&
		previousState.initialized === true;
	const checkpoint = matches ? previousState.checkpointMs : undefined;
	const activation = matches ? previousState.noteActivationMs : pollStartMs;
	if (
		matches &&
		(typeof activation !== 'number' ||
			!Number.isFinite(activation) ||
			typeof checkpoint !== 'number' ||
			!Number.isFinite(checkpoint) ||
			activation > checkpoint)
	)
		throw fail('has an invalid activation checkpoint');
	const accountIds =
		config.noteAccountIds ?? (config.scopeType === 'ACCOUNT' ? config.scopeIds : undefined);
	if (!accountIds?.length || !config.scopeIds.length)
		throw fail('requires resolved account and selected scope IDs');
	if (mode === 'manual') {
		const preview: IDataObject[] = [];
		await readActivityFeed(
			request,
			config.baseUrl,
			PREVIEW_START_MS,
			pollStartMs,
			accountIds,
			timing,
			async (events) => {
				const candidates = events.filter(
					(event) => !matchesExclusion(exclusions.author, event.authorName),
				);
				const lookup = await currentAlerts(request, config, [
					...new Set(candidates.map((event) => event.alertId)),
				]);
				if (lookup.unresolvedIds.size)
					throw fail('could not resolve current alert scope for an activity');
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
			!config.simplifyOutput,
		);
		return { items: preview.reverse() };
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
		if (previous.size > ACTIVITY_NOTE_STATE_LIMIT)
			throw fail('exceeded the activity state capacity');
	}
	const activities = await readActivityFeed(
		request,
		config.baseUrl,
		Math.max(0, Math.floor(start)),
		pollStartMs,
		accountIds,
		timing,
		undefined,
		!config.simplifyOutput,
	);
	if (activities.length > ACTIVITY_NOTE_STATE_LIMIT)
		throw fail('exceeded the activity state capacity');
	const baseline = mode === 'scheduled' && !matches;
	let items: IDataObject[] = [];
	if (!baseline) {
		const candidates = activities.filter(
			(event) =>
				!previous.has(event.activityId) &&
				!matchesExclusion(exclusions.author, event.authorName) &&
				BigInt(event.timestampNs) >= BigInt(Number(activation)) * BigInt(1000000),
		);
		const lookup = await currentAlerts(request, config, [
			...new Set(candidates.map((event) => event.alertId)),
		]);
		if (lookup.unresolvedIds.size)
			throw fail(
				'could not resolve current alert scope for an activity; retry after alert indexing completes',
			);
		items = candidates.flatMap((event) => {
			const alert = lookup.alerts.get(event.alertId);
			return alert ? [output(config, alert, event)] : [];
		});
	}
	for (const event of activities) {
		const earlier = previous.get(event.activityId);
		if (earlier !== undefined && earlier !== event.timestampNs)
			throw fail('received conflicting timestamps for an activity ID');
		previous.set(event.activityId, event.timestampNs);
	}
	const retainFrom =
		BigInt(Math.max(0, Math.floor(pollStartMs - config.overlapSeconds * 1000))) * BigInt(1000000);
	for (const [id, timestamp] of previous) if (BigInt(timestamp) < retainFrom) previous.delete(id);
	if (previous.size > ACTIVITY_NOTE_STATE_LIMIT)
		throw fail('exceeded the activity state capacity inside the overlap');
	if (config.debug)
		config.debugLog?.('Completed direct ActivityFeed note poll', {
			outputCount: items.length,
			checkpointAdvanced: true,
			seenActivityCount: previous.size,
		});
	return {
		items,
		nextState: {
			configFingerprint: fingerprint,
			initialized: true,
			checkpointMs: pollStartMs,
			noteActivationMs: activation,
			seenActivityIds: [...previous.keys()],
			seenActivityTimestamps: Object.fromEntries(previous),
		},
	};
}
