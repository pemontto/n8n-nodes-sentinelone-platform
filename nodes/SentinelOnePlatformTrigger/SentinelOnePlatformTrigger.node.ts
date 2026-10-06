import {
	additionalAlertFields,
	analystVerdictOptions,
	managementScopeOption,
	severityOptions,
	statusOptions,
} from '../shared/Descriptions';
import {
	loadScopeOptions,
	loadListScopeOptions,
	readManagementScopeIds,
	discoverVisibleScopes,
	isScopePermissionError,
	scopeParentPlaceholder,
	type ScopeDiscoveryFilters,
	type ScopeType,
} from '../shared/Scopes';
import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	pollSentinelOne,
	fingerprintConfig,
	TRIGGER_STATE_VERSION,
	type AuthenticatedRequest,
	type TriggerConfig,
	type TriggerEvent,
	type TriggerState,
} from './SentinelOneTriggerHelpers';

import { DEFAULT_ADDITIONAL_ALERT_FIELDS } from '../shared/AlertFields';
import { activityAccountIds } from '../shared/Scopes';
import { pollAlertActivities } from './ActivityNotePoll';
import { ACTIVITY_FEED_ROUTING_HEADER } from './ActivityFeed';
import {
	parseActivitySelection,
	parseExactValues,
	parseActivityConditions,
	mitigationActionTypeOptions,
	mitigationActivityStatusOptions,
} from './ActivityConditions';
import { debugSetting, logGraphqlRequest, logGraphqlResult } from '../shared/Debug';
import { PollBudgetError, requestWithRetry } from '../shared/transport/request';
import {
	responseHeader,
	responseStatus,
	isRetryableReadError,
	retryAfterMs,
} from '../shared/transport/retry';

const simplifyOption: INodeProperties = {
	displayName: 'Simplify',
	name: 'simplifyOutput',
	type: 'boolean',
	default: true,
	description: 'Whether to return a simplified version of the response instead of the raw data',
};

const activityFields: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'activityTypes',
		type: 'multiOptions',
		default: ['any'],
		displayOptions: { show: { resource: ['alertActivity'] } },
		options: [
			{ name: 'Agentic Investigation Triggered', value: '16008' },
			{ name: 'Alert Created', value: '16000' },
			{ name: 'Analyst Verdict Changed', value: '16002' },
			{
				name: 'Any Alert Activity',
				value: 'any',
				description: 'All alert-linked activity types, including unknown IDs',
			},
			{ name: 'Assignee Changed', value: '16004' },
			{ name: 'Mitigation Activity', value: '16005' },
			{ name: 'Note Created', value: '16007' },
			{ name: 'Other (Unrecognised Types)', value: 'unknown' },
			{ name: 'Severity Changed', value: '16003' },
			{ name: 'Status Changed', value: '16001' },
		],
	},
	{
		displayName: 'Recorded Activity Conditions',
		name: 'activityConditions',
		type: 'fixedCollection',
		default: {},
		placeholder: 'Add Condition',
		typeOptions: { multipleValues: true },
		displayOptions: { show: { resource: ['alertActivity'] } },
		description:
			'Recorded values from one activity. Lists match any selected value; From and To must match the same change. Status, verdict and severity require present, unequal endpoints.',
		options: [
			{
				name: 'conditions',
				displayName: 'Condition',
				// Keep the field selector before its dependent value controls.
				// eslint-disable-next-line n8n-nodes-base/node-param-fixed-collection-type-unsorted-items
				values: [
					{
						displayName: 'Field',
						name: 'field',
						type: 'options',
						default: 'status',
						options: [
							{ name: 'Analyst Verdict', value: 'analystVerdict' },
							{ name: 'Assignment', value: 'assignment' },
							{ name: 'Mitigation', value: 'mitigation' },
							{ name: 'Severity', value: 'severity' },
							{ name: 'Status', value: 'status' },
						],
					},
					...(['status', 'analystVerdict', 'severity'] as const).flatMap(
						(field): INodeProperties[] => {
							const suffix =
								field === 'analystVerdict' ? 'Verdict' : field === 'status' ? 'Status' : 'Severity';

							const options =
								field === 'analystVerdict'
									? analystVerdictOptions
									: field === 'status'
										? statusOptions
										: severityOptions;

							return ['from', 'to'].map(
								(endpoint): INodeProperties => ({
									displayName: endpoint === 'from' ? 'From' : 'To',
									name: `${endpoint}${suffix}`,
									type: 'multiOptions',
									default: [],
									options,
									displayOptions: { show: { field: [field] } },
									description:
										'Optional recorded values. Leave empty for any present value; selected values use OR.',
								}),
							);
						},
					),
					{
						displayName: 'Previous Email Equals',
						name: 'previousEmail',
						type: 'string',
						default: '',
						displayOptions: { show: { field: ['assignment'] } },
						description:
							'Optional comma-separated exact email values. Requires the recorded previous email; a missing value cannot match.',
					},
					{
						displayName: 'New Email Equals',
						name: 'newEmail',
						type: 'string',
						default: '',
						displayOptions: { show: { field: ['assignment'] } },
						description:
							'Optional comma-separated exact email values. Matches the destination email even when the previous email is absent.',
					},
					{
						displayName: 'Destination ID Equals',
						name: 'destinationIds',
						type: 'string',
						default: '',
						displayOptions: { show: { field: ['assignment'] } },
						description:
							'Optional comma-separated exact destination assignee IDs. Does not require a previous assignee value.',
					},
					{
						displayName: 'Action Type Equals',
						name: 'actionTypes',
						type: 'multiOptions',
						default: [],
						options: mitigationActionTypeOptions,
						displayOptions: { show: { field: ['mitigation'] } },
						description: 'Optional recorded action types. Selected values use OR.',
					},
					{
						displayName: 'Activity Status Equals',
						name: 'activityStatuses',
						type: 'multiOptions',
						default: [],
						options: mitigationActivityStatusOptions,
						displayOptions: { show: { field: ['mitigation'] } },
						description:
							'Optional recorded activity statuses. Selected values use OR. Mitigation activity does not by itself mean successful remediation.',
					},
				],
			},
		],
	},
	{
		displayName: 'Match Conditions',
		name: 'conditionMatch',
		type: 'options',
		default: 'any',
		displayOptions: {
			show: {
				resource: ['alertActivity'],
			},
		},
		options: [
			{ name: 'Match All', value: 'all' },
			{ name: 'Match Any', value: 'any' },
		],
		description:
			'Only matters when there are two or more conditions. Evaluate them against one activity.',
	},
];

const activePollKeys = new Set<string>();

interface PendingBaseline {
	fingerprint: string;
	state: TriggerState;
	updatedAtMs: number;
}

const pendingBaselines = new Map<string, PendingBaseline>();

const pendingBaselineTtlMs = 60 * 60 * 1000;

/** Declared by n8n 2.38.0 and later. */
type PollBudgetFunctions = { getPollBudgetMs?: () => number };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Scheduled hosts without a budget use the same reader with five minutes. */
function pollDeadline(context: IPollFunctions): number | undefined {
	if (context.getMode() === 'manual') return undefined;
	// SAFETY: n8n 2.38.0+ adds getPollBudgetMs to poll functions; older hosts are checked below.
	const { getPollBudgetMs } = context as IPollFunctions & PollBudgetFunctions;

	const budgetMs =
		typeof getPollBudgetMs === 'function' ? Number(getPollBudgetMs.call(context)) : 300_000;

	return Date.now() + (Number.isFinite(budgetMs) ? Math.max(0, budgetMs) : 300_000);
}

function normalizeBaseUrl(value: unknown): string {
	return String(value ?? '')
		.trim()
		.replace(/\/+$/, '');
}

function readStringArray(
	context: IPollFunctions | ILoadOptionsFunctions,
	name: 'accountIds' | 'siteIds' | 'groupIds',
): string[] {
	return readManagementScopeIds(context, name);
}

function credentialIdentity(context: IPollFunctions): IDataObject {
	// SAFETY: n8n credentials are exposed as a JSON object keyed by credential type.
	const credentials = context.getNode().credentials as IDataObject | undefined;
	// SAFETY: the selected SentinelOne API credential is a JSON object when configured.
	const selected = credentials?.sentinelOnePlatformApi as IDataObject | undefined;

	return {
		type: 'sentinelOnePlatformApi',
		id: selected?.id ?? null,
	};
}

function authenticatedRequest(
	context: IPollFunctions | ILoadOptionsFunctions,
	debug = false,
	deadline?: number,
): AuthenticatedRequest {
	return async (options, readerDeadline) =>
		requestWithRetry(
			async (timeoutMs, attempt) => {
				// SAFETY: request bodies passed to this helper are n8n JSON objects.
				const body = options.body as IDataObject | undefined;

				const document =
					options.url.includes('/unifiedalerts/graphql') && typeof body?.query === 'string'
						? body.query
						: undefined;

				if (document)
					logGraphqlRequest(context.logger, debug, document, body?.variables, { attempt });
				const startedAt = Date.now();
				let received = false;

				try {
					const response = await context.helpers.httpRequestWithAuthentication.call(
						context,
						'sentinelOnePlatformApi',
						{ ...options, timeout: timeoutMs, sendCredentialsOnCrossOriginRedirect: false },
					);

					received = true;

					if (document)
						logGraphqlResult(context.logger, debug, {
							attempt,
							durationMs: Date.now() - startedAt,
							outcome: 'received',
							graphqlErrorCount: Array.isArray(response?.errors) ? response.errors.length : 0,
						});

					return response;
				} finally {
					if (document && !received)
						logGraphqlResult(context.logger, debug, {
							attempt,
							durationMs: Date.now() - startedAt,
							outcome: 'transportError',
						});
				}
			},
			{
				// Scope loading and SDL polling own their bounded retry loops.
				attempts: options.url.includes('/unifiedalerts/graphql') ? 3 : 1,
				timeoutMs: options.timeout,
				deadline:
					readerDeadline === undefined ? deadline : Math.min(deadline ?? Infinity, readerDeadline),
			},
		).then((result) => {
			if (result.ok) return result.value;

			// Poll helpers recognise this class to keep a completed prefix; poll() wraps it with node context.
			if (result.error instanceof PollBudgetError) throw result.error;
			const error = result.error;
			const status = responseStatus(error);

			const message =
				status === 401
					? 'SentinelOne authentication failed. Check the credential.'
					: status === 403
						? 'SentinelOne denied access. Check the credential permissions.'
						: status === 429
							? 'SentinelOne rate limit reached. Try again after the service delay.'
							: `SentinelOne request failed${status ? ` (HTTP ${status})` : ''}. Check service availability.`;

			const apiError = new NodeApiError(
				context.getNode(),
				{ message },
				{
					message,
					description: status ? `SentinelOne returned HTTP ${status}.` : undefined,
					httpCode: status ? String(status) : undefined,
				},
			);

			const routingTag = responseHeader(error, ACTIVITY_FEED_ROUTING_HEADER);

			throw Object.assign(apiError, {
				...(routingTag !== undefined
					? { headers: { [ACTIVITY_FEED_ROUTING_HEADER]: routingTag } }
					: {}),
				statusCode: status,
				retryable: isRetryableReadError(error),
				retryAfterMs: Math.max(retryAfterMs(error), result.retryDelayMs ?? 0),
			});
		});
}

async function scopeOptions(
	context: IPollFunctions | ILoadOptionsFunctions,
	scopeType: ScopeType,
	filters: ScopeDiscoveryFilters = {},
	deadline?: number,
): Promise<INodePropertyOptions[]> {
	const credentials = await context.getCredentials('sentinelOnePlatformApi');
	const baseUrl = normalizeBaseUrl(credentials.baseUrl);

	try {
		return await loadScopeOptions(
			authenticatedRequest(context, false, deadline),
			baseUrl,
			scopeType,
			filters,
		);
	} catch (error) {
		// A spent poll budget is not a permission problem; poll() wraps it with node context.
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
		if (error instanceof PollBudgetError) throw error;

		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
		if (error instanceof NodeApiError) throw error;
		const status = responseStatus(error);
		const message = `Unable to load SentinelOne ${scopeType.toLowerCase()} scopes. Check the credential permissions and try again.`;

		if (status === null)
			throw new NodeOperationError(context.getNode(), `${message} ${errorMessage(error)}`);
		throw new NodeApiError(
			context.getNode(),
			{ message },
			{
				message,
				description: `${errorMessage(error)} (HTTP ${status})`,
				httpCode: String(status),
			},
		);
	}
}

async function validateSelectedScopes(
	context: IPollFunctions | ILoadOptionsFunctions,
	scopeType: ScopeType,
	selectedIds: string[],
	filters: ScopeDiscoveryFilters,
	deadline?: number,
): Promise<void> {
	const options = await scopeOptions(context, scopeType, filters, deadline);
	const visibleIds = new Set(options.map((option) => String(option.value)));
	const missingIds = selectedIds.filter((id) => !visibleIds.has(id));

	if (missingIds.length === 0) return;
	throw new NodeOperationError(
		context.getNode(),
		`The selected ${scopeType.toLowerCase()} scope no longer belongs to the selected parent scope or is not visible to this credential. Reload the scope fields and try again.`,
	);
}

export class SentinelOnePlatformTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'SentinelOne Platform Trigger',
		name: 'sentinelOnePlatformTrigger',
		icon: {
			light: 'file:../../icons/sentinelone.svg',
			dark: 'file:../../icons/sentinelone.dark.svg',
		},
		group: ['trigger'],
		version: 1,
		subtitle:
			'={{$parameter["resource"] === "alertActivity" ? "Alert activity: " + (($parameter["activityTypes"] || ["any"]).map(type => ({any: "Any", "16000": "Alert Created", "16001": "Status Changed", "16002": "Analyst Verdict Changed", "16003": "Severity Changed", "16004": "Assignee Changed", "16005": "Mitigation Activity", "16007": "Note Created", "16008": "Agentic Investigation Triggered", unknown: "Other (Unrecognised Types)"}[type] || type)).join(", ")) : "Alert: " + ({new: "New", newOrUpdated: "New or updated", updated: "Updated"}[$parameter["operation"]] || "New")}}',
		description: 'Starts the workflow when selected SentinelOne Unified Alerts events are found',
		defaults: {
			name: 'SentinelOne Platform Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		polling: true,
		credentials: [
			{
				name: 'sentinelOnePlatformApi',
				required: true,
			},
		],
		properties: [
			debugSetting,
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				default: 'alert',
				options: [
					{ name: 'Alert', value: 'alert' },
					{ name: 'Alert Activity', value: 'alertActivity' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'new',
				displayOptions: { show: { resource: ['alert'] } },
				options: [
					{
						name: 'New',
						value: 'new',
						description: 'Emit an alert once when its ID is first found',
						action: 'Trigger on new alerts',
					},
					{
						name: 'New or Updated',
						value: 'newOrUpdated',
						description:
							'Emit new alerts and the latest changed state observed for existing alerts',
						action: 'Trigger on new or updated alerts',
					},
					{
						name: 'Updated',
						value: 'updated',
						description:
							'Emit the latest changed state observed when an existing alert update time advances',
						action: 'Trigger on updated alerts',
					},
				],
			},
			...activityFields,
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['alert'] } },
				options: [
					managementScopeOption(),
					additionalAlertFields('list'),
					{
						displayName: 'Advanced Filters',
						name: 'advancedFilters',
						type: 'json',
						default: '[]',
						description:
							'Add custom SentinelOne filters as JSON. Use an array to require every filter, or use or groups when any group may match. Severity, status, name, and time filters still apply. <a href="https://github.com/pemontto/n8n-nodes-sentinelone-platform/blob/main/docs/trigger.md#advanced-filters">See examples</a>.',
					},
					{
						displayName: 'Alert Name',
						name: 'alertName',
						type: 'string',
						default: '',
						placeholder: 'Suspicious process',
						description: 'Optional full-text match against the SentinelOne alert name',
					},
					{
						displayName: 'Exclude Account Name',
						name: 'excludeAccountName',
						type: 'string',
						default: '',
						placeholder: 'demo|test',
						description:
							'Case-insensitive exclusion regex. Leave empty to disable. Missing names are kept. See <a href="https://github.com/pemontto/n8n-nodes-sentinelone-platform/blob/main/docs/trigger.md#exclusions">supported syntax</a>.',
					},
					{
						displayName: 'Exclude Group Name',
						name: 'excludeGroupName',
						type: 'string',
						default: '',
						placeholder: 'demo|test',
						description:
							'Case-insensitive exclusion regex. Leave empty to disable. Missing names are kept. See <a href="https://github.com/pemontto/n8n-nodes-sentinelone-platform/blob/main/docs/trigger.md#exclusions">supported syntax</a>.',
					},
					{
						displayName: 'Exclude Site Name',
						name: 'excludeSiteName',
						type: 'string',
						default: '',
						placeholder: 'demo|test',
						description:
							'Case-insensitive exclusion regex. Leave empty to disable. Missing names are kept. See <a href="https://github.com/pemontto/n8n-nodes-sentinelone-platform/blob/main/docs/trigger.md#exclusions">supported syntax</a>.',
					},
					{
						displayName: 'Severity',
						name: 'severities',
						type: 'multiOptions',
						default: [],
						options: severityOptions,
						description: 'Limit alerts to the selected severities',
					},
					simplifyOption,
					{
						displayName: 'Status',
						name: 'statuses',
						type: 'multiOptions',
						default: [],
						options: statusOptions,
						description: 'Limit alerts to the selected statuses',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['alertActivity'] } },
				options: [
					managementScopeOption(),
					{
						displayName: 'Alert Name',
						name: 'alertName',
						type: 'string',
						default: '',
						placeholder: 'Suspicious process',
						description: 'Optional full-text match against the SentinelOne alert name',
					},
					{
						displayName: 'Current Parent Alert Severity',
						name: 'severities',
						type: 'multiOptions',
						default: [],
						options: severityOptions,
						description:
							'Only emit activities whose parent alert currently has a selected severity. This does not filter the recorded change. Leave empty for any severity.',
					},
					{
						displayName: 'Current Parent Alert Status',
						name: 'statuses',
						type: 'multiOptions',
						default: [],
						options: statusOptions,
						description:
							'Only emit activities whose parent alert currently has a selected status. This does not filter the recorded change. Leave empty for any status.',
					},
					{
						displayName: 'Custom Activity Type IDs',
						name: 'customActivityTypeIds',
						type: 'string',
						default: '',
						description:
							'Advanced: comma-separated numeric activity type IDs to include with named selections. Any Alert Activity includes these IDs already.',
					},
					{
						displayName: 'Exclude Account Name',
						name: 'excludeAccountName',
						type: 'string',
						default: '',
						placeholder: 'demo|test',
						description:
							'Case-insensitive exclusion regex. Leave empty to disable. Missing names are kept. See <a href="https://github.com/pemontto/n8n-nodes-sentinelone-platform/blob/main/docs/trigger.md#exclusions">supported syntax</a>.',
					},
					{
						displayName: 'Exclude Actor IDs',
						name: 'excludeActorIds',
						type: 'string',
						default: '',
						description:
							'Comma-separated actor IDs to exclude by exact match. Activities without an actor ID are kept.',
					},
					{
						displayName: 'Exclude Actor Name',
						name: 'excludeActorName',
						type: 'string',
						default: '',
						placeholder: 'automation|integration',
						description:
							'Case-insensitive exclusion regex for the SDL user name. Leave empty to disable. Missing names are kept. See <a href="https://github.com/pemontto/n8n-nodes-sentinelone-platform/blob/main/docs/trigger.md#exclusions">supported syntax</a>.',
					},
					{
						displayName: 'Exclude Group Name',
						name: 'excludeGroupName',
						type: 'string',
						default: '',
						placeholder: 'demo|test',
						description:
							'Case-insensitive exclusion regex. Leave empty to disable. Missing names are kept. See <a href="https://github.com/pemontto/n8n-nodes-sentinelone-platform/blob/main/docs/trigger.md#exclusions">supported syntax</a>.',
					},
					{
						displayName: 'Exclude Site Name',
						name: 'excludeSiteName',
						type: 'string',
						default: '',
						placeholder: 'demo|test',
						description:
							'Case-insensitive exclusion regex. Leave empty to disable. Missing names are kept. See <a href="https://github.com/pemontto/n8n-nodes-sentinelone-platform/blob/main/docs/trigger.md#exclusions">supported syntax</a>.',
					},
					{
						displayName: 'Include Current Alert',
						name: 'includeCurrentAlert',
						type: 'boolean',
						default: false,
						description:
							'Whether to add the raw current parent alert lookup object. Current parent summary fields are always included; recorded changes remain unchanged.',
					},
					{
						displayName: 'Include Raw Activity',
						name: 'includeRawActivity',
						type: 'boolean',
						default: false,
						description:
							'Whether to add the complete raw activity alongside the stable activity envelope',
					},
					simplifyOption,
				],
			},
		],
	};

	methods = {
		loadOptions: {
			async getAccounts(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const credentials = await this.getCredentials('sentinelOnePlatformApi');

				try {
					return await loadScopeOptions(
						authenticatedRequest(this),
						normalizeBaseUrl(credentials.baseUrl),
						'ACCOUNT',
					);
				} catch (error) {
					if (isScopePermissionError(error)) return [];
					throw new NodeOperationError(
						this.getNode(),
						'Unable to load SentinelOne accounts. Check the credential and try again.',
					);
				}
			},
			async getSites(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadListScopeOptions(this, 'SITE');
			},
			async getGroups(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const accountIds = readStringArray(this, 'accountIds');
				const siteIds = readStringArray(this, 'siteIds');

				if (siteIds.length === 0) return scopeParentPlaceholder('GROUP');

				return await scopeOptions(this, 'GROUP', { accountIds, siteIds });
			},
		},
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const node = this.getNode();
		const pollKey = `${this.getWorkflow().id}:${node.id}`;

		if (activePollKeys.has(pollKey)) {
			this.logger.warn('[SentinelOne Platform Trigger] Skipping overlapping poll');

			return null;
		}

		activePollKeys.add(pollKey);

		try {
			const deadline = pollDeadline(this);
			const credentials = await this.getCredentials('sentinelOnePlatformApi');
			const options = this.getNodeParameter('options', {}) as IDataObject;
			const nodeDebug = this.getNodeParameter('nodeDebug', false) === true;
			const request = authenticatedRequest(this, nodeDebug, deadline);
			const staticData = this.getWorkflowStaticData('node');
			// SAFETY: this node stores only TriggerState values under its sentinelOneTrigger key.
			const previousState = (staticData.sentinelOneTrigger as TriggerState | undefined) ?? {};

			try {
				const baseUrl = normalizeBaseUrl(credentials.baseUrl);
				const resource = this.getNodeParameter('resource') as 'alert' | 'alertActivity';

				const savedOperation = this.getNodeParameter(
					'operation',
					resource === 'alertActivity' ? 'occurred' : 'new',
				) as 'occurred' | 'new' | 'newOrUpdated' | 'updated';

				// n8n retains the operation selected for the other resource when the resource changes.
				const operation =
					resource === 'alertActivity'
						? 'occurred'
						: savedOperation === 'occurred'
							? 'new'
							: savedOperation;

				if (
					(resource !== 'alert' && resource !== 'alertActivity') ||
					(resource === 'alert' && !['new', 'newOrUpdated', 'updated'].includes(operation))
				) {
					throw new NodeOperationError(node, 'Unsupported trigger resource or operation.');
				}

				const events: TriggerEvent[] =
					resource === 'alertActivity'
						? ['alert.activity']
						: operation === 'newOrUpdated'
							? ['alert.new', 'alert.updated']
							: operation === 'updated'
								? ['alert.updated']
								: ['alert.new'];

				const accountIds = readStringArray(this, 'accountIds');
				const siteIds = readStringArray(this, 'siteIds');
				const groupIds = readStringArray(this, 'groupIds');

				if (groupIds.length > 0 && siteIds.length === 0) {
					throw new NodeOperationError(
						node,
						'Group selections require a site selection. Select the sites for these groups, or clear the saved group selections before polling.',
					);
				}

				const allVisibleAccounts =
					accountIds.length === 0 && siteIds.length === 0 && groupIds.length === 0;

				if (accountIds.length > 0) {
					await validateSelectedScopes(this, 'ACCOUNT', accountIds, { accountIds }, deadline);
				}

				if (siteIds.length > 0) {
					await validateSelectedScopes(this, 'SITE', siteIds, { accountIds, siteIds }, deadline);
				}

				if (groupIds.length > 0) {
					await validateSelectedScopes(
						this,
						'GROUP',
						groupIds,
						{ accountIds, siteIds, groupIds },
						deadline,
					);
				}

				let scopeType: ScopeType;
				let scopeIds: string[];

				if (groupIds.length > 0) {
					scopeType = 'GROUP';
					scopeIds = groupIds;
				} else if (siteIds.length > 0) {
					scopeType = 'SITE';
					scopeIds = siteIds;
				} else if (accountIds.length > 0) {
					scopeType = 'ACCOUNT';
					scopeIds = accountIds;
				} else {
					({ scopeType, scopeIds } = await discoverVisibleScopes(request, baseUrl, node));
				}

				if (scopeIds.length === 0) {
					throw new NodeOperationError(
						this.getNode(),
						'No credential-visible account or site scopes were found.',
					);
				}

				const config: TriggerConfig = {
					baseUrl,
					credentialIdentity: credentialIdentity(this),
					scopeType,
					scopeIds,
					activityAccountIds:
						resource === 'alertActivity'
							? await activityAccountIds(request, baseUrl, scopeType, scopeIds)
							: undefined,
					allVisibleAccounts,
					events,
					// SAFETY: both multi-select parameters contain only string option values.
					severities: (options.severities as string[] | undefined) ?? [],
					// SAFETY: both multi-select parameters contain only string option values.
					statuses: (options.statuses as string[] | undefined) ?? [],
					alertName: String(options.alertName ?? ''),
					advancedFilters: resource === 'alert' ? options.advancedFilters : undefined,
					// SAFETY: this multi-select parameter contains only the declared string field values.
					additionalAlertFields:
						resource === 'alert'
							? ((options.additionalAlertFields as string[] | undefined) ??
								DEFAULT_ADDITIONAL_ALERT_FIELDS)
							: undefined,
					excludeAccountName: String(options.excludeAccountName ?? ''),
					excludeSiteName: String(options.excludeSiteName ?? ''),
					excludeGroupName: String(options.excludeGroupName ?? ''),
					activityTypeIds:
						resource === 'alertActivity'
							? parseActivitySelection(
									this.getNodeParameter('activityTypes', ['any']),
									options.customActivityTypeIds,
								)
							: undefined,
					activityConditions:
						resource === 'alertActivity'
							? parseActivityConditions(this.getNodeParameter('activityConditions', {}))
							: [],
					conditionMatch: this.getNodeParameter('conditionMatch', 'any') === 'all' ? 'all' : 'any',
					excludeActorIds:
						resource === 'alertActivity' ? parseExactValues(options.excludeActorIds) : [],
					includeRawActivity: resource === 'alertActivity' && options.includeRawActivity === true,
					includeCurrentAlert: resource === 'alertActivity' && options.includeCurrentAlert === true,
					excludeActorName:
						resource === 'alertActivity' ? String(options.excludeActorName ?? '') : '',
					simplifyOutput: options.simplifyOutput !== false,
					debug: nodeDebug,
					warnLog: (message, details = {}) =>
						this.logger.warn(
							`[SentinelOne Platform Trigger] ${message} ${JSON.stringify(details)}`,
						),
					debugLog: nodeDebug
						? (message, details = {}) =>
								this.logger.info(
									`[SentinelOne Platform Trigger] ${message} ${JSON.stringify(details)}`,
								)
						: undefined,
					overlapSeconds: 300,
					concurrentRequests: 5,
					requestTimeoutMs: 30_000,
					alertPageSize: 200,
					maxAlertPages: 25,
					pollDeadlineMs: deadline,
				};

				const fingerprint = `${fingerprintConfig(config)}${resource === 'alertActivity' ? ':sdl-activities-v1' : ''}`;
				const scheduled = this.getMode() !== 'manual';
				const now = Date.now();

				// Sweep every expired entry so workflows deactivated before committing do not linger.
				for (const [key, entry] of pendingBaselines) {
					if (now - entry.updatedAtMs > pendingBaselineTtlMs) pendingBaselines.delete(key);
				}

				const pendingBaseline = pendingBaselines.get(pollKey);

				if (
					pendingBaseline &&
					(pendingBaseline.fingerprint !== fingerprint ||
						now - pendingBaseline.updatedAtMs > pendingBaselineTtlMs)
				) {
					pendingBaselines.delete(pollKey);
				}

				const committed =
					previousState.version === TRIGGER_STATE_VERSION &&
					previousState.initialized === true &&
					previousState.configFingerprint === fingerprint;

				if (scheduled && committed) pendingBaselines.delete(pollKey);

				const state =
					scheduled && !committed
						? (pendingBaselines.get(pollKey)?.state ?? previousState)
						: previousState;

				const result = await (resource === 'alertActivity' ? pollAlertActivities : pollSentinelOne)(
					request,
					config,
					state,
					this.getMode() === 'manual' ? 'manual' : 'scheduled',
					Date.now(),
				);

				if (result.nextState) {
					staticData.sentinelOneTrigger = result.nextState;

					// n8n may discard static data when a scheduled poll returns no items.
					// Keep only that non-emitting state until it is committed or expires.
					if (scheduled && !committed && result.items.length === 0) {
						pendingBaselines.set(pollKey, {
							fingerprint,
							state: result.nextState,
							updatedAtMs: now,
						});
					}
				}

				if (result.items.length === 0) return null;

				// eventId goes last so the readable fields lead in the editor's output view.
				return [
					this.helpers.returnJsonArray(
						result.items.map(({ eventId, ...rest }) => ({ ...rest, eventId })),
					),
				];
			} catch (error) {
				// Preserve typed n8n errors and their status, description and cause.
				// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
				if (error instanceof NodeApiError || error instanceof NodeOperationError) throw error;

				const status = responseStatus(error);

				if (status !== null) {
					const apiError = new NodeApiError(
						node,
						{ message: errorMessage(error) },
						{
							message: errorMessage(error),
							httpCode: String(status),
						},
					);

					throw Object.assign(apiError, {
						statusCode: status,
						retryable: isRetryableReadError(error),
						retryAfterMs: retryAfterMs(error),
					});
				}

				const operationError = new NodeOperationError(
					this.getNode(),
					`Unable to poll SentinelOne Unified Alerts. ${errorMessage(error)}`,
				);

				throw Object.assign(operationError, { cause: error });
			}
		} finally {
			activePollKeys.delete(pollKey);
		}
	}
}
