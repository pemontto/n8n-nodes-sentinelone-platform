import { sleep as workflowSleep, type IDataObject } from 'n8n-workflow';
import type { AuthenticatedRequest } from './SentinelOneTriggerHelpers';

export const ACTIVITY_FEED_LIMIT = 1000;
export const ACTIVITY_FEED_INLINE_BYTES = 5 * 1024 * 1024;
const ROUTING_HEADER = 'x-dataset-query-forward-tag';
export const ACTIVITY_FEED_LOG_FILTER =
	"dataSource.name='ActivityFeed' dataset='activityLog' data.alert.id=*";

export interface ActivityChange {
	field: string;
	oldValue?: IDataObject[string];
	newValue?: IDataObject[string];
}

export interface ActivityFeedEvent {
	activityId: string;
	activityTypeId: string;
	activityKind: string;
	alertId: string;
	timestampNs: string;
	createdAt: string;
	changes: ActivityChange[];
	noteText?: string | null;
	mitigation?: { actionType?: IDataObject[string]; activityStatus?: IDataObject[string] };
	rawActivity?: IDataObject;
	authorId: string | null;
	authorName: string | null;
}

const ACTIVITY_KINDS: Record<string, string> = {
	'16000': 'alertCreated',
	'16001': 'statusChanged',
	'16002': 'analystVerdictChanged',
	'16003': 'severityChanged',
	'16004': 'assigneeChanged',
	'16005': 'mitigationActivity',
	'16007': 'noteCreated',
};

export interface ActivityFeedTiming {
	now?: () => number;
	sleep?: (milliseconds: number) => Promise<void>;
	deadlineMs?: number;
	lifecycleMs?: number;
	maxQueries?: number;
	inlineBytes?: number;
}

function record(value: unknown): IDataObject | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as IDataObject)
		: undefined;
}

function failure(message: string): Error {
	return new Error(`SentinelOne ActivityFeed ${message}; state was not advanced.`);
}

function validateQuality(payload: IDataObject): void {
	for (const object of [payload, record(payload.data)]) {
		if (!object) continue;
		for (const key of ['errors', 'warnings']) {
			const value = object[key];
			if (value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0))
				throw failure('returned errors or warnings');
		}
		if (
			object.partialResultsDueToTimeLimit !== undefined &&
			object.partialResultsDueToTimeLimit !== false
		)
			throw failure('returned partial results');
		for (const key of ['omittedEvents', 'discardedArrayItems']) {
			if (object[key] !== undefined && object[key] !== 0)
				throw failure('omitted or discarded query data');
		}
	}
}

function complete(payload: IDataObject): boolean {
	return (
		typeof payload.stepsCompleted === 'number' &&
		Number.isFinite(payload.stepsCompleted) &&
		typeof payload.stepsTotal === 'number' &&
		Number.isFinite(payload.stepsTotal) &&
		payload.stepsTotal >= 0 &&
		payload.stepsCompleted >= payload.stepsTotal &&
		record(payload.data) !== undefined
	);
}

function retryable(error: unknown): boolean {
	const value = record(error);
	const response = record(value?.response);
	const status = Number(
		value?.statusCode ??
			value?.httpCode ??
			value?.status ??
			response?.status ??
			response?.statusCode,
	);
	return status === 404 || status === 429;
}

function parseLogJson(text: string): unknown {
	const parts: string[] = [];
	let index = 0;
	while (index < text.length) {
		const start = index;
		if (text[index] === '"') {
			index++;
			while (index < text.length) {
				if (text[index] === '\\') {
					index += 2;
					continue;
				}
				if (text[index++] === '"') break;
			}
			parts.push(text.slice(start, index));
		} else if (text[index] === '-' || /[0-9]/.test(text[index])) {
			const token = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)?.[0];
			if (!token) throw failure('returned invalid LOG JSON');
			const value = Number(token);
			parts.push(
				!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER
					? JSON.stringify(token)
					: token,
			);
			index += token.length;
		} else {
			parts.push(text[index++]);
		}
	}
	try {
		return JSON.parse(parts.join('')) as unknown;
	} catch {
		throw failure('returned invalid LOG JSON');
	}
}

function validateLogNumbers(value: unknown): void {
	if (
		typeof value === 'number' &&
		(!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
	)
		throw failure('received already-parsed unsafe LOG numbers; a text response is required');
	if (Array.isArray(value)) for (const item of value) validateLogNumbers(item);
	else if (record(value))
		for (const item of Object.values(value as IDataObject)) validateLogNumbers(item);
}

function decodeLog(payload: IDataObject): ActivityFeedEvent[] {
	const matches = record(payload.data)?.matches;
	if (!Array.isArray(matches)) throw failure('returned an invalid LOG match list');
	return matches.map((match) => {
		const rawActivity = record(match);
		const fields = record(rawActivity?.values);
		const identifier = (value: unknown) =>
			typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
		const activityId = identifier(fields?.activity_id);
		const activityTypeId = identifier(fields?.activity_type);
		const alertId = identifier(fields?.['data.alert.id']);
		const createdAt = fields?.created_at;
		const noteText = fields?.['data.payload.note_text'];
		const userId = fields?.['data.user.id'];
		const authorId =
			typeof userId === 'number' && Number.isSafeInteger(userId)
				? String(userId)
				: (userId ?? null);
		const authorName = fields?.['data.user.enriched_name'] ?? null;
		const timestamp = rawActivity?.timestamp;
		const timestampNs =
			typeof timestamp === 'number' && Number.isSafeInteger(timestamp)
				? String(timestamp)
				: timestamp;
		if (
			!rawActivity ||
			!fields ||
			typeof activityTypeId !== 'string' ||
			!/^\d+$/.test(activityTypeId) ||
			typeof activityId !== 'string' ||
			!activityId.trim() ||
			activityId.trim() !== activityId ||
			typeof alertId !== 'string' ||
			!alertId.trim() ||
			alertId.trim() !== alertId ||
			typeof timestampNs !== 'string' ||
			!/^\d{1,30}$/.test(timestampNs) ||
			typeof createdAt !== 'string' ||
			!Number.isFinite(Date.parse(createdAt)) ||
			(noteText !== undefined && noteText !== null && typeof noteText !== 'string') ||
			(authorId !== null && typeof authorId !== 'string') ||
			(authorName !== null && typeof authorName !== 'string')
		)
			throw failure('returned invalid LOG activity identity, timestamps or note text');
		const changes: ActivityChange[] = [];
		for (const [field, source] of [
			['status', 'status'],
			['analystVerdict', 'analyst_verdict'],
			['severity', 'severity'],
			['assigneeEmail', 'assignee_email'],
			['assigneeId', 'assignee_id'],
		]) {
			const change: ActivityChange = { field };
			for (const [endpoint, property] of [
				['old', 'oldValue'],
				['new', 'newValue'],
			] as const) {
				if (source === 'assignee_id' && endpoint === 'old') continue;
				const key = `data.payload.changes.${endpoint}_${source}`;
				if (Object.prototype.hasOwnProperty.call(fields, key)) change[property] = fields[key];
			}
			if (Object.keys(change).length > 1) changes.push(change);
		}
		const mitigation: NonNullable<ActivityFeedEvent['mitigation']> = {};
		for (const [source, target] of [
			['mitigation_action_type', 'actionType'],
			['mitigation_action_status', 'activityStatus'],
		] as const) {
			const key = `data.payload.${source}`;
			if (Object.prototype.hasOwnProperty.call(fields, key)) mitigation[target] = fields[key];
		}
		return {
			activityId,
			activityTypeId,
			activityKind: ACTIVITY_KINDS[activityTypeId] ?? 'unknown',
			changes,
			...(Object.keys(mitigation).length ? { mitigation } : {}),
			alertId,
			timestampNs,
			createdAt,
			...(noteText !== undefined ? { noteText } : {}),
			authorId,
			authorName,
			rawActivity,
		};
	});
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	const object = record(value);
	if (object)
		return `{${Object.keys(object)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
			.join(',')}}`;
	return JSON.stringify(value) ?? 'undefined';
}

export async function readActivityFeed(
	request: AuthenticatedRequest,
	baseUrl: string,
	startMs: number,
	endMs: number,
	accountIds: string[] = [],
	timing: ActivityFeedTiming = {},
	previewWindow?: (events: ActivityFeedEvent[]) => Promise<boolean>,
	fullOutput = false,
	activityTypeIds?: string[],
): Promise<ActivityFeedEvent[]> {
	if (
		typeof fullOutput !== 'boolean' ||
		!Number.isSafeInteger(startMs) ||
		!Number.isSafeInteger(endMs) ||
		startMs < 0 ||
		endMs <= startMs ||
		!Number.isFinite(new Date(endMs).getTime()) ||
		accountIds.some((id) => typeof id !== 'string' || !id.trim() || id !== id.trim()) ||
		(activityTypeIds !== undefined &&
			(!activityTypeIds.length || activityTypeIds.some((id) => !/^\d+$/.test(id))))
	)
		throw failure('requires a valid half-open time window, account IDs and activity selection');
	const now = timing.now ?? Date.now;
	const sleep = timing.sleep ?? workflowSleep;
	const deadlineMs = timing.deadlineMs ?? 300_000;
	const lifecycleMs = timing.lifecycleMs ?? 100_000;
	const maxQueries = timing.maxQueries ?? 128;
	const inlineBytes = timing.inlineBytes ?? ACTIVITY_FEED_INLINE_BYTES;
	if (
		![deadlineMs, lifecycleMs, maxQueries, inlineBytes].every(
			(value) => Number.isSafeInteger(value) && value > 0,
		)
	)
		throw failure('requires positive integer query limits');
	const deadline = now() + Math.min(deadlineMs, 300_000);
	const endpoint = `${baseUrl}/sdl/v2/api/queries`;
	let queries = 0;
	const collected = new Map<string, ActivityFeedEvent>();
	const observedPayloads = new Map<string, string>();

	async function queryWindow(start: number, end: number): Promise<ActivityFeedEvent[] | null> {
		if (++queries > Math.min(maxQueries, 128) || now() >= deadline)
			throw failure('exceeded the query budget or deadline');
		const expires = Math.min(deadline, now() + Math.min(lifecycleMs, 100_000));
		let id: string | undefined;
		let accepted = false;
		let routingTag: string | undefined;
		const unwrap = (response: unknown): IDataObject | undefined => {
			const wrapper = record(response);
			const headers = record(wrapper?.headers);
			const routingEntry = Object.entries(headers ?? {}).find(
				([key]) => key.toLowerCase() === ROUTING_HEADER,
			);
			if (routingEntry) {
				const tag = routingEntry[1];
				if (typeof tag !== 'string' || !tag || tag.length > 1024 || !/^[\x20-\x7e]+$/.test(tag))
					throw failure('returned an invalid routing header');
				routingTag = tag;
			}
			const body =
				wrapper && Object.prototype.hasOwnProperty.call(wrapper, 'body') ? wrapper.body : response;
			const payload = typeof body === 'string' ? parseLogJson(body) : body;
			validateLogNumbers(payload);
			return record(payload);
		};
		const routedHeaders = () => (routingTag ? { [ROUTING_HEADER]: routingTag } : {});

		const remaining = () => {
			const milliseconds = expires - now();
			if (milliseconds <= 0) throw failure('exceeded the query deadline');
			return Math.max(1, Math.min(milliseconds, 30_000));
		};
		try {
			const queryBody = {
				queryType: 'LOG',
				startTime: new Date(start).toISOString(),
				endTime: new Date(end).toISOString(),
				log: {
					filter:
						ACTIVITY_FEED_LOG_FILTER +
						(activityTypeIds
							? ` (${activityTypeIds.map((id) => `activity_type='${id}'`).join(' OR ')})`
							: ''),
					limit: ACTIVITY_FEED_LIMIT,
				},
				...(accountIds.length ? { tenant: false, accountIds } : { tenant: true }),
			};
			let payload = unwrap(
				await request({
					method: 'POST',
					returnFullResponse: true,
					url: endpoint,
					timeout: remaining(),
					json: false,
					encoding: 'text',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(queryBody),
				}).catch(() => {
					throw failure('SDL query launch failed');
				}),
			);
			if (typeof payload?.id !== 'string' || !payload.id.trim())
				throw failure('create response omitted its query ID');
			id = payload.id;
			while (true) {
				remaining();
				if (!payload) throw failure('returned an invalid query response');
				if (payload.id !== undefined && payload.id !== id)
					throw failure('returned a mismatched query ID');
				validateQuality(payload);
				let externalResult = false;
				for (const part of [payload, record(payload.data)]) {
					const url = part?.fullResultUrl;
					if (url !== undefined && url !== null && url !== '') {
						if (typeof url !== 'string') throw failure('returned an invalid full-result URL');
						externalResult = true;
					}
				}
				const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
				if (externalResult || bytes > Math.min(inlineBytes, ACTIVITY_FEED_INLINE_BYTES)) {
					accepted = complete(payload);
					return null;
				}
				if (complete(payload)) {
					const rows = decodeLog(payload);
					accepted = true;
					return rows;
				}
				await sleep(Math.min(1500, remaining()));
				const result = await request({
					method: 'GET',
					returnFullResponse: true,
					headers: routedHeaders(),
					url: `${endpoint}/${encodeURIComponent(id)}`,
					timeout: remaining(),
					json: false,
					encoding: 'text',
				}).then(
					(value) => ({ value, error: undefined }),
					(error: unknown) => ({ value: undefined, error }),
				);
				if (result.error !== undefined) {
					const errorResponse = record(record(result.error)?.response);
					if (errorResponse?.headers) unwrap(errorResponse);
					if (retryable(result.error)) continue;
					throw failure('query polling failed');
				}
				payload = unwrap(result.value);
			}
		} finally {
			if (id && !accepted) {
				await request({
					method: 'DELETE',
					returnFullResponse: true,
					headers: routedHeaders(),
					url: `${endpoint}/${encodeURIComponent(id)}`,
					timeout: 1000,
					json: false,
				}).then(
					() => undefined,
					() => undefined,
				);
			}
		}
	}

	let previewComplete = false;
	async function visit(start: number, end: number): Promise<void> {
		if (previewComplete) return;
		const rows = await queryWindow(start, end);
		if (rows === null || rows.length >= ACTIVITY_FEED_LIMIT) {
			if (end - start <= 1)
				throw failure('hit a row, inline-byte or external-result limit inside one millisecond');
			const middle = start + Math.floor((end - start) / 2);
			if (previewWindow) {
				await visit(middle, end);
				await visit(start, middle);
			} else {
				await visit(start, middle);
				await visit(middle, end);
			}
			return;
		}
		const windowEvents = new Map<string, ActivityFeedEvent>();
		for (const event of rows) {
			const timestamp = BigInt(event.timestampNs);
			if (
				timestamp < BigInt(start) * BigInt(1_000_000) ||
				timestamp >= BigInt(end) * BigInt(1_000_000)
			)
				continue;
			const identity = JSON.stringify([event.activityId, event.timestampNs]);
			const payload = canonical(event.rawActivity?.values);
			const observed = observedPayloads.get(identity);
			if (observed !== undefined && observed !== payload)
				throw failure('returned conflicting duplicate activity IDs at the same source timestamp');
			observedPayloads.set(identity, payload);
			const previous = collected.get(event.activityId);
			if (previous) {
				const previousTimestamp = BigInt(previous.timestampNs);
				if (timestamp < previousTimestamp) continue;
				if (timestamp === previousTimestamp) continue;
			}
			collected.set(event.activityId, event);
			windowEvents.set(event.activityId, event);
		}
		const acceptedRows = [...windowEvents.values()];
		if (previewWindow) {
			previewComplete = await previewWindow(acceptedRows);
			collected.clear();
		}
	}
	if (previewWindow) {
		let end = endMs;
		let width = 86400000;
		while (end > startMs && !previewComplete) {
			const start = Math.max(startMs, end - width);
			await visit(start, end);
			end = start;
			width *= 2;
		}
	} else {
		await visit(startMs, endMs);
	}
	return [...collected.values()].sort((left, right) => {
		const a = BigInt(left.timestampNs),
			b = BigInt(right.timestampNs);
		return a < b ? -1 : a > b ? 1 : left.activityId.localeCompare(right.activityId);
	});
}
