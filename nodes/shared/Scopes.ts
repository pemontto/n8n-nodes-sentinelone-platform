import type {
	IDataObject,
	IExecuteFunctions,
	IPollFunctions,
	INode,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { requestWithRetry } from './transport/request';

export type ScopeType = 'ACCOUNT' | 'SITE' | 'GROUP';
export type ManagementScopeType = ScopeType;
export interface ScopeDiscoveryFilters {
	accountIds?: string[];
	siteIds?: string[];
	groupIds?: string[];
}

export const MAX_MANAGEMENT_SCOPE_PAGES = 100;
export const MAX_MANAGEMENT_SCOPE_OPTIONS = 25_000;
export const MAX_MANAGEMENT_SCOPE_LOAD_MS = 120_000;

type AuthenticatedRequest = (options: IHttpRequestOptions) => Promise<unknown>;

interface ManagementScopeItem extends IDataObject {
	id: string;
	name?: string;
	accountName?: string;
	siteName?: string;
	siteId?: string;
}

class ManagementScopeResponseError extends Error {}

export function normalizeBaseUrl(value: unknown): string {
	return String(value ?? '')
		.trim()
		.replace(/\/+$/, '');
}

export function authenticatedRequest(context: ILoadOptionsFunctions): AuthenticatedRequest {
	return async (options) =>
		await context.helpers.httpRequestWithAuthentication.call(
			context,
			'sentinelOnePlatformApi',
			options,
		);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function statusCode(error: unknown): number | undefined {
	if (!isRecord(error)) return undefined;
	const response = isRecord(error.response) ? error.response : undefined;
	const value =
		error.statusCode ?? error.httpCode ?? error.status ?? response?.statusCode ?? response?.status;
	const parsed = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function scopePath(scopeType: ManagementScopeType): 'accounts' | 'sites' | 'groups' {
	if (scopeType === 'ACCOUNT') return 'accounts';
	if (scopeType === 'SITE') return 'sites';
	return 'groups';
}

function parseItem(value: unknown, path: string, index: number): ManagementScopeItem {
	if (!isRecord(value)) {
		throw new ManagementScopeResponseError(
			`The ${path} response contains an invalid item at position ${index + 1}.`,
		);
	}
	if (
		typeof value.id !== 'string' &&
		(typeof value.id !== 'number' || !Number.isSafeInteger(value.id))
	) {
		throw new ManagementScopeResponseError(
			`The ${path} response contains an item without a valid ID at position ${index + 1}.`,
		);
	}
	const id = String(value.id).trim();
	if (!id) {
		throw new ManagementScopeResponseError(
			`The ${path} response contains an empty ID at position ${index + 1}.`,
		);
	}

	const item: ManagementScopeItem = { id };
	for (const field of ['name', 'accountName', 'siteName', 'siteId'] as const) {
		const fieldValue = value[field];
		if (fieldValue !== undefined && fieldValue !== null) item[field] = String(fieldValue);
	}
	return item;
}

function parseItems(
	response: Record<string, unknown>,
	scopeType: ManagementScopeType,
	path: string,
): ManagementScopeItem[] {
	const data = response.data;
	let values: unknown;
	if (scopeType === 'SITE') values = isRecord(data) ? data.sites : undefined;
	else values = data;

	if (!Array.isArray(values)) {
		throw new ManagementScopeResponseError(
			`The ${path} response is missing its expected data list.`,
		);
	}
	return values.map((value, index) => parseItem(value, path, index));
}

function parseNextCursor(response: Record<string, unknown>, path: string): string | undefined {
	if (!Object.prototype.hasOwnProperty.call(response, 'pagination')) {
		return undefined;
	}
	if (!isRecord(response.pagination)) {
		throw new ManagementScopeResponseError(`The ${path} response has invalid pagination data.`);
	}
	if (!Object.prototype.hasOwnProperty.call(response.pagination, 'nextCursor')) {
		return undefined;
	}

	const nextCursor = response.pagination.nextCursor;
	if (nextCursor === null) return undefined;
	if (typeof nextCursor !== 'string' || !nextCursor.trim()) {
		throw new ManagementScopeResponseError(
			`The ${path} response has an invalid pagination.nextCursor.`,
		);
	}
	return nextCursor.trim();
}

function scopeLabel(scopeType: ManagementScopeType, item: ManagementScopeItem): string {
	const name = item.name?.trim() || item.id;
	if (scopeType === 'SITE' && item.accountName?.trim()) {
		return `${item.accountName.trim()} / ${name}`;
	}
	if (scopeType === 'GROUP' && item.siteName?.trim()) {
		return `${item.siteName.trim()} / ${name}`;
	}
	if (scopeType === 'GROUP' && item.siteId?.trim()) {
		return `Site ${item.siteId.trim()} / ${name}`;
	}
	return name;
}

function requestFailureMessage(scopeType: ManagementScopeType, error: unknown): string {
	const label = scopeType.toLowerCase();
	const status = statusCode(error);
	if (status === 401) {
		return `Unable to load SentinelOne ${label} scopes because authentication failed. Check the credential.`;
	}
	if (status === 403) {
		return `Unable to load SentinelOne ${label} scopes because this credential does not have permission.`;
	}
	if (status === 429) {
		return `Unable to load SentinelOne ${label} scopes because the service rate limit was reached. Try again later.`;
	}
	if (status !== undefined && status >= 500) {
		return `Unable to load SentinelOne ${label} scopes because the service is unavailable. Try again later.`;
	}
	return `Unable to load SentinelOne ${label} scopes. Check the credential and service availability.`;
}

export async function loadScopeOptions(
	request: AuthenticatedRequest,
	baseUrl: string,
	scopeType: ScopeType,
	filters: ScopeDiscoveryFilters = {},
): Promise<INodePropertyOptions[]> {
	const startedAt = Date.now();
	const path = scopePath(scopeType);

	const optionsById = new Map<string, INodePropertyOptions>();
	const seenCursors = new Set<string>();
	let pageCount = 0;
	let cursor: string | undefined;

	do {
		if (Date.now() - startedAt >= MAX_MANAGEMENT_SCOPE_LOAD_MS) {
			throw new Error(
				`SentinelOne ${path} scope loading exceeded ${MAX_MANAGEMENT_SCOPE_LOAD_MS / 1000} seconds. Narrow the accessible management scope or try again later.`,
			);
		}
		if (pageCount >= MAX_MANAGEMENT_SCOPE_PAGES) {
			throw new Error(
				`SentinelOne ${path} scope loading exceeded ${MAX_MANAGEMENT_SCOPE_PAGES} pages. Narrow the accessible management scope or contact SentinelOne support.`,
			);
		}
		pageCount++;
		const remainingMs = MAX_MANAGEMENT_SCOPE_LOAD_MS - (Date.now() - startedAt);

		const qs: IDataObject = { limit: 1000 };
		if (scopeType !== 'GROUP') qs.states = 'active';
		if (filters.accountIds?.length) qs.accountIds = filters.accountIds.join(',');
		if (filters.siteIds?.length) qs.siteIds = filters.siteIds.join(',');
		if (filters.groupIds?.length) qs.groupIds = filters.groupIds.join(',');
		if (cursor) qs.cursor = cursor;

		const result = await requestWithRetry(
			(timeoutMs) =>
				request({
					method: 'GET',
					url: `${baseUrl}/web/api/v2.1/${path}`,
					timeout: timeoutMs,
					qs,
					json: true,
					sendCredentialsOnCrossOriginRedirect: false,
				}),
			{ timeoutMs: remainingMs },
		);
		if (!result.ok) {
			const error = result.error;
			if (Date.now() - startedAt >= MAX_MANAGEMENT_SCOPE_LOAD_MS) {
				throw new ManagementScopeResponseError(
					`SentinelOne ${path} scope loading exceeded ${MAX_MANAGEMENT_SCOPE_LOAD_MS / 1000} seconds. Narrow the accessible management scope or try again later.`,
				);
			}
			throw Object.assign(new Error(requestFailureMessage(scopeType, error)), {
				statusCode: statusCode(error),
			});
		}

		const response = result.value;
		if (Date.now() - startedAt >= MAX_MANAGEMENT_SCOPE_LOAD_MS) {
			throw new ManagementScopeResponseError(
				`SentinelOne ${path} scope loading exceeded ${MAX_MANAGEMENT_SCOPE_LOAD_MS / 1000} seconds. Narrow the accessible management scope or try again later.`,
			);
		}
		if (!isRecord(response)) {
			throw new ManagementScopeResponseError(`The ${path} response is not an object.`);
		}
		for (const item of parseItems(response, scopeType, path)) {
			if (!optionsById.has(item.id)) {
				if (optionsById.size >= MAX_MANAGEMENT_SCOPE_OPTIONS) {
					throw new ManagementScopeResponseError(
						`SentinelOne returned more than ${MAX_MANAGEMENT_SCOPE_OPTIONS} ${path} scopes. Narrow the accessible management scope before loading options.`,
					);
				}
				optionsById.set(item.id, { name: scopeLabel(scopeType, item), value: item.id });
			}
		}

		const nextCursor = parseNextCursor(response, path);
		if (!nextCursor) break;
		if (seenCursors.has(nextCursor)) {
			throw new ManagementScopeResponseError(
				`SentinelOne repeated the ${path} cursor while loading management scopes.`,
			);
		}
		seenCursors.add(nextCursor);
		cursor = nextCursor;
	} while (cursor);

	return [...optionsById.values()].sort((left, right) => {
		const byName = left.name.localeCompare(right.name);
		return byName || String(left.value).localeCompare(String(right.value));
	});
}

interface ListScope extends IDataObject {
	scopeType: ScopeType;
	scopeIds: string[];
}

export function scopeIds(value: unknown): string[] {
	if (!Array.isArray(value)) throw new Error('Scope IDs must be an array of IDs.');
	const values = value.map((entry) => {
		if (typeof entry === 'string' && entry.trim()) return entry.trim();
		if (typeof entry === 'number' && Number.isSafeInteger(entry)) return String(entry);
		throw new Error('Every selected scope must have a non-empty string or safe integer ID.');
	});
	return [...new Set(values)];
}

async function options(
	context: IExecuteFunctions | ILoadOptionsFunctions,
	scopeType: ScopeType,
	filters: ScopeDiscoveryFilters,
): Promise<INodePropertyOptions[]> {
	const credentials = await context.getCredentials('sentinelOnePlatformApi');
	const baseUrl = normalizeBaseUrl(credentials.baseUrl);
	if (!baseUrl)
		throw new Error('The SentinelOne credential is missing its Management Console URL.');
	return await loadScopeOptions(
		async (request) =>
			await context.helpers.httpRequestWithAuthentication.call(
				context,
				'sentinelOnePlatformApi',
				request,
			),
		baseUrl,
		scopeType,
		filters,
	);
}

export function readManagementScopeIds(
	context: ILoadOptionsFunctions | IPollFunctions | IExecuteFunctions,
	name: 'accountIds' | 'siteIds' | 'groupIds',
	itemIndex?: number,
): string[] {
	const get = (key: string, fallback: IDataObject | string[]) =>
		itemIndex === undefined
			? (context as ILoadOptionsFunctions).getNodeParameter(key, fallback)
			: (context as IExecuteFunctions).getNodeParameter(key, itemIndex, fallback);
	const configuration = get('options', {});
	if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration))
		throw new Error('Options must be an object.');
	if (Object.prototype.hasOwnProperty.call(configuration, 'scope')) {
		const scope = (configuration as IDataObject).scope;
		if (!scope || typeof scope !== 'object' || Array.isArray(scope))
			throw new Error('Scope must be an object.');
		const selection = (scope as IDataObject).selection;
		if (selection === undefined) return [];
		if (!selection || typeof selection !== 'object' || Array.isArray(selection))
			throw new Error('Scope selection must be an object.');
		const value = (selection as IDataObject)[name];
		return scopeIds(value === undefined ? [] : value);
	}
	return scopeIds(get(name, []));
}

export async function loadListScopeOptions(
	context: ILoadOptionsFunctions,
	scopeType: ScopeType,
): Promise<INodePropertyOptions[]> {
	try {
		const accountIds = readManagementScopeIds(context, 'accountIds');
		const siteIds = readManagementScopeIds(context, 'siteIds');
		if (scopeType === 'GROUP' && siteIds.length === 0) return [];
		return await options(
			context,
			scopeType,
			scopeType === 'ACCOUNT'
				? {}
				: scopeType === 'SITE'
					? { accountIds }
					: { accountIds, siteIds },
		);
	} catch (error) {
		if (scopeType === 'ACCOUNT' && isScopePermissionError(error)) return [];
		throw new NodeOperationError(context.getNode(), error as Error);
	}
}

export async function readListScope(
	context: IExecuteFunctions,
	itemIndex: number,
): Promise<ListScope | null> {
	try {
		const accountIds = readManagementScopeIds(context, 'accountIds', itemIndex);
		const siteIds = readManagementScopeIds(context, 'siteIds', itemIndex);
		const configuration = context.getNodeParameter('options', itemIndex, {}) as IDataObject;
		const hasNewScope = Object.prototype.hasOwnProperty.call(configuration, 'scope');
		const groupIds =
			siteIds.length || hasNewScope ? readManagementScopeIds(context, 'groupIds', itemIndex) : [];
		if (hasNewScope && groupIds.length > 0 && siteIds.length === 0) {
			throw new Error(
				'Group selections require a site selection. Select the sites for these groups, or clear the group selections before executing.',
			);
		}
		for (const [scopeType, selected, filters] of [
			['ACCOUNT', accountIds, { accountIds }],
			['SITE', siteIds, { accountIds, siteIds }],
			['GROUP', groupIds, { accountIds, siteIds, groupIds }],
		] as [ScopeType, string[], ScopeDiscoveryFilters][]) {
			if (!selected.length) continue;
			const available = new Set(
				(await options(context, scopeType, filters)).map((option) => String(option.value)),
			);
			if (selected.some((id) => !available.has(id)))
				throw new Error(
					`The selected ${scopeType.toLowerCase()} no longer belongs to the selected parent scope or is not visible to this credential. Reload the scope fields and try again.`,
				);
		}
		if (groupIds.length) return { scopeType: 'GROUP', scopeIds: groupIds };
		if (siteIds.length) return { scopeType: 'SITE', scopeIds: siteIds };
		if (accountIds.length) return { scopeType: 'ACCOUNT', scopeIds: accountIds };
		return null;
	} catch (error) {
		throw new NodeOperationError(context.getNode(), error as Error, { itemIndex });
	}
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}
export async function loadManagementScopeOptions(
	context: ILoadOptionsFunctions,
	scopeType: ScopeType,
): Promise<INodePropertyOptions[]> {
	try {
		return await options(context, scopeType, {});
	} catch (error) {
		if (scopeType === 'ACCOUNT' && isScopePermissionError(error)) return [];
		throw new NodeOperationError(context.getNode(), error as Error);
	}
}
export function isScopePermissionError(error: unknown): boolean {
	const record = recordOrUndefined(error);
	const response = recordOrUndefined(record?.response);
	return (
		Number(
			record?.statusCode ??
				record?.httpCode ??
				record?.status ??
				response?.status ??
				response?.statusCode,
		) === 403
	);
}

export async function discoverVisibleScopes(
	request: AuthenticatedRequest,
	baseUrl: string,
	node: INode,
): Promise<{ scopeType: ScopeType; scopeIds: string[] }> {
	try {
		const accounts = await loadScopeOptions(request, baseUrl, 'ACCOUNT');
		if (accounts.length)
			return { scopeType: 'ACCOUNT', scopeIds: accounts.map((option) => String(option.value)) };
	} catch (error) {
		if (!isScopePermissionError(error))
			throw new NodeOperationError(
				node,
				'Unable to discover SentinelOne accounts. Check the credential and service availability.',
			);
	}
	const sites = await loadScopeOptions(request, baseUrl, 'SITE');
	return { scopeType: 'SITE', scopeIds: sites.map((option) => String(option.value)) };
}

export async function activityAccountIds(
	request: AuthenticatedRequest,
	baseUrl: string,
	scopeType: ScopeType,
	scopeIds: string[],
): Promise<string[]> {
	if (scopeType === 'ACCOUNT') return [...new Set(scopeIds)];
	const deadline = Date.now() + MAX_MANAGEMENT_SCOPE_LOAD_MS;
	let pageCount = 0;
	async function parents(
		kind: 'sites' | 'groups',
		ids: string[],
		parent: 'accountId' | 'siteId',
	): Promise<string[]> {
		const output = new Set<string>();
		const found = new Set<string>();
		for (let offset = 0; offset < ids.length; offset += 500) {
			const selected = ids.slice(offset, offset + 500);
			const cursors = new Set<string>();
			let cursor: string | undefined;
			do {
				const remainingMs = deadline - Date.now();
				if (remainingMs <= 0 || pageCount++ >= MAX_MANAGEMENT_SCOPE_PAGES)
					throw new Error(
						'ActivityFeed scope discovery exceeded its time or page limit. Narrow the selected scopes.',
					);
				const result = await requestWithRetry(
					(timeoutMs) =>
						request({
							method: 'GET',
							url: `${baseUrl}/web/api/v2.1/${kind}`,
							timeout: timeoutMs,
							sendCredentialsOnCrossOriginRedirect: false,
							json: true,
							qs: {
								limit: 1000,
								[kind === 'sites' ? 'siteIds' : 'groupIds']: selected.join(','),
								...(cursor ? { cursor } : {}),
							},
						}),
					{ timeoutMs: remainingMs },
				);
				if (!result.ok)
					throw Object.assign(
						new Error(requestFailureMessage(kind === 'sites' ? 'SITE' : 'GROUP', result.error)),
						{ statusCode: statusCode(result.error) },
					);
				const response = result.value as {
					data?: IDataObject[] | { sites?: IDataObject[] };
					pagination?: { nextCursor?: string | null };
				};
				const rows =
					kind === 'sites' && !Array.isArray(response.data) ? response.data?.sites : response.data;
				if (!Array.isArray(rows))
					throw new Error('SentinelOne returned incomplete scope lineage for ActivityFeed.');
				for (const row of rows) {
					const id = String(row.id ?? '');
					if (!selected.includes(id)) continue;
					const value = row[parent];
					if (typeof value !== 'string' || !value)
						throw new Error(
							'SentinelOne did not expose the parent account/site ID required for ActivityFeed.',
						);
					found.add(id);
					output.add(value);
					if (output.size > MAX_MANAGEMENT_SCOPE_OPTIONS)
						throw new Error(
							'ActivityFeed scope discovery exceeded its result limit. Narrow the selected scopes.',
						);
				}
				cursor = parseNextCursor(response as Record<string, unknown>, kind);
				if (cursor && cursors.has(cursor))
					throw new Error('SentinelOne repeated an ActivityFeed scope-discovery cursor.');
				if (cursor) cursors.add(cursor);
			} while (cursor);
		}
		if (ids.some((id) => !found.has(id)))
			throw new Error(
				'A selected ActivityFeed scope is no longer visible. Reload the scope selection.',
			);
		return [...output];
	}
	const sites = scopeType === 'GROUP' ? await parents('groups', scopeIds, 'siteId') : scopeIds;
	return await parents('sites', sites, 'accountId');
}
