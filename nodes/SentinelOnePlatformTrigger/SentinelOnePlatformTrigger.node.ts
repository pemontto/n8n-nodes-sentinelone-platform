import { advancedAlertFilters } from '../shared/AlertFilterAdvanced';
import { alertFilterLoadOptions } from '../shared/AlertFilterOptions';
import {
	alertFilterProperties,
	loadAlertFilterMetadata,
	parseAlertFilters,
	TriggerFilterError,
	validateAlertFilters,
} from '../shared/AlertFilters';
import {
	additionalAlertFields,
	analystVerdictOptions,
	managementScopeFields,
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
	type TriggerConfig,
	type TriggerEvent,
	type TriggerState,
} from './SentinelOneTriggerHelpers';

import { DEFAULT_ADDITIONAL_ALERT_FIELDS } from '../shared/AlertFields';
import { activityAccountIds } from '../shared/Scopes';
import { pollAlertActivities } from './ActivityNotePoll';
import { authenticatedRequest } from '../shared/transport/authenticatedRequest';
import {
	parseActivitySelection,
	parseExactValues,
	parseActivityConditions,
	mitigationActionTypeOptions,
	mitigationActivityStatusOptions,
} from './ActivityConditions';
import { debugSetting } from '../shared/Debug';
import { PollBudgetError } from '../shared/transport/request';
import { responseStatus, isRetryableReadError, retryAfterMs } from '../shared/transport/retry';

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
				description: 'All activity on alerts, including unrecognised types',
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
		displayName: 'Activity Conditions',
		name: 'activityConditions',
		type: 'fixedCollection',
		default: {},
		placeholder: 'Add Condition',
		typeOptions: { multipleValues: true },
		displayOptions: { show: { resource: ['alertActivity'] } },
		description:
			'Filter one activity at a time. Previous and new values must belong to the same change. Status, verdict and severity must have changed.',
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
							{ name: 'Assignee', value: 'assignment' },
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
									displayName: endpoint === 'from' ? 'Previous Value' : 'New Value',
									name: `${endpoint}${suffix}`,
									type: 'multiOptions',
									default: [],
									options,
									displayOptions: { show: { field: [field] } },
									description:
										'Match any selected value. Leave empty for any value. Both previous and new values must be present and different.',
								}),
							);
						},
					),
					{
						displayName: 'Previous Assignee Email',
						name: 'previousEmail',
						type: 'string',
						default: '',
						displayOptions: { show: { field: ['assignment'] } },
						description:
							'Comma-separated email addresses to match exactly. Activities without a previous assignee email do not match.',
					},
					{
						displayName: 'New Assignee Email',
						name: 'newEmail',
						type: 'string',
						default: '',
						displayOptions: { show: { field: ['assignment'] } },
						description:
							'Comma-separated email addresses to match exactly. A previous assignee email is not required.',
					},
					{
						displayName: 'New Assignee ID',
						name: 'destinationIds',
						type: 'string',
						default: '',
						displayOptions: { show: { field: ['assignment'] } },
						description:
							'Comma-separated assignee IDs to match exactly. A previous assignee is not required.',
					},
					{
						displayName: 'Mitigation Action',
						name: 'actionTypes',
						type: 'multiOptions',
						default: [],
						options: mitigationActionTypeOptions,
						displayOptions: { show: { field: ['mitigation'] } },
						description: 'Match any selected mitigation action. Leave empty for any action.',
					},
					{
						displayName: 'Mitigation Status',
						name: 'activityStatuses',
						type: 'multiOptions',
						default: [],
						options: mitigationActivityStatusOptions,
						displayOptions: { show: { field: ['mitigation'] } },
						description:
							'Match any selected mitigation status. Leave empty for any status. A mitigation activity does not always mean the action succeeded.',
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
			'Choose whether one activity must match all conditions or any condition. Applies when two or more conditions are set.',
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
	return readManagementScopeIds(context, name, undefined, true);
}

function credentialIdentity(context: IPollFunctions | ILoadOptionsFunctions): IDataObject {
	// SAFETY: n8n credentials are exposed as a JSON object keyed by credential type.
	const credentials = context.getNode().credentials as IDataObject | undefined;
	// SAFETY: the selected SentinelOne API credential is a JSON object when configured.
	const selected = credentials?.sentinelOnePlatformApi as IDataObject | undefined;

	return {
		type: 'sentinelOnePlatformApi',
		id: selected?.id ?? null,
	};
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
			throw new NodeOperationError(context.getNode(), message, {
				description: errorMessage(error),
			});
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
			// Scope comes first so it sits straight after Credential and Poll Times.
			{
				displayName: 'Scope',
				name: 'scope',
				type: 'fixedCollection',
				placeholder: 'Add Scope',
				// Must stay empty: a pre-filled default makes the n8n editor fail to open the node.
				default: {},
				description:
					'Limit to accounts, sites or groups. Leave empty for everything the credential can see.',
				options: [
					{
						displayName: 'Selection',
						name: 'selection',
						values: managementScopeFields().map(
							(field): INodeProperties => ({
								...field,
								displayName:
									field.name === 'accountIds'
										? 'Accounts'
										: field.name === 'siteIds'
											? 'Sites'
											: 'Groups',
								typeOptions: {
									...field.typeOptions,
									...(field.name === 'siteIds'
										? { loadOptionsDependsOn: ['scope.selection.accountIds'] }
										: {}),
									...(field.name === 'groupIds'
										? {
												loadOptionsDependsOn: [
													'scope.selection.accountIds',
													'scope.selection.siteIds',
												],
											}
										: {}),
								},
								...(field.name === 'siteIds'
									? { displayOptions: { show: { accountIds: [{ _cnd: { exists: true } }] } } }
									: {}),
								...(field.name === 'groupIds'
									? { displayOptions: { show: { siteIds: [{ _cnd: { exists: true } }] } } }
									: {}),
							}),
						),
					},
				],
			},
			{
				...debugSetting,
				description:
					'Whether to log requests and timing in the n8n server logs. Sensitive values are hidden.',
			},
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
						description: 'Start the workflow when a new alert is found',
						action: 'Trigger on new alerts',
					},
					{
						name: 'New or Updated',
						value: 'newOrUpdated',
						description: 'Start the workflow for new alerts and updates to existing alerts',
						action: 'Trigger on new or updated alerts',
					},
					{
						name: 'Updated',
						value: 'updated',
						description: 'Start the workflow when an existing alert is updated',
						action: 'Trigger on updated alerts',
					},
				],
			},
			activityFields[0],
			...activityFields.slice(1),
			...alertFilterProperties,
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['alert'] } },
				options: [
					additionalAlertFields('list'),
					advancedAlertFilters,
					{
						displayName: 'Alert Name',
						name: 'alertName',
						type: 'string',
						default: '',
						placeholder: 'Suspicious process',
						description:
							'Shortcut for alertName contains: search the alert name for text, ignoring case',
					},
					{
						displayName: 'Alert Severity',
						name: 'severities',
						type: 'multiOptions',
						default: [],
						options: severityOptions,
						description: 'Limit alerts to the selected severities',
					},
					{
						displayName: 'Alert Status',
						name: 'statuses',
						type: 'multiOptions',
						default: [],
						options: statusOptions,
						description: 'Limit alerts to the selected statuses',
					},
					{
						displayName: 'Exclude Account Name',
						name: 'excludeAccountName',
						type: 'string',
						typeOptions: { rows: 3 },
						default: '',
						placeholder: 'demo|test',
						description:
							'Regular expressions to exclude matching names, one per line, ignoring case. Leave empty to disable. Missing names are kept. See <a href="https://github.com/pemontto/n8n-nodes-sentinelone-platform/blob/main/docs/trigger.md#exclusions">supported syntax</a>.',
					},
					{
						displayName: 'Exclude Group Name',
						name: 'excludeGroupName',
						type: 'string',
						typeOptions: { rows: 3 },
						default: '',
						placeholder: 'demo|test',
						description:
							'Regular expressions to exclude matching names, one per line, ignoring case. Leave empty to disable. Missing names are kept. See <a href="https://github.com/pemontto/n8n-nodes-sentinelone-platform/blob/main/docs/trigger.md#exclusions">supported syntax</a>.',
					},
					{
						displayName: 'Exclude Site Name',
						name: 'excludeSiteName',
						type: 'string',
						typeOptions: { rows: 3 },
						default: '',
						placeholder: 'demo|test',
						description:
							'Regular expressions to exclude matching names, one per line, ignoring case. Leave empty to disable. Missing names are kept. See <a href="https://github.com/pemontto/n8n-nodes-sentinelone-platform/blob/main/docs/trigger.md#exclusions">supported syntax</a>.',
					},
					simplifyOption,
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
					{
						displayName: 'Alert Name',
						name: 'alertName',
						type: 'string',
						default: '',
						placeholder: 'Suspicious process',
						description:
							'Shortcut for alertName contains: search the alert name for text, ignoring case',
					},
					{
						displayName: 'Alert Severity',
						name: 'severities',
						type: 'multiOptions',
						default: [],
						options: severityOptions,
						description:
							'Only activity on alerts whose severity is now one of these. Leave empty for any severity.',
					},
					{
						displayName: 'Alert Status',
						name: 'statuses',
						type: 'multiOptions',
						default: [],
						options: statusOptions,
						description:
							'Only activity on alerts whose status is now one of these. Leave empty for any status.',
					},
					{
						displayName: 'Exclude Account Name',
						name: 'excludeAccountName',
						type: 'string',
						typeOptions: { rows: 3 },
						default: '',
						placeholder: 'demo|test',
						description:
							'Regular expressions to exclude matching names, one per line, ignoring case. Leave empty to disable. Missing names are kept. See <a href="https://github.com/pemontto/n8n-nodes-sentinelone-platform/blob/main/docs/trigger.md#exclusions">supported syntax</a>.',
					},
					{
						displayName: 'Exclude Group Name',
						name: 'excludeGroupName',
						type: 'string',
						typeOptions: { rows: 3 },
						default: '',
						placeholder: 'demo|test',
						description:
							'Regular expressions to exclude matching names, one per line, ignoring case. Leave empty to disable. Missing names are kept. See <a href="https://github.com/pemontto/n8n-nodes-sentinelone-platform/blob/main/docs/trigger.md#exclusions">supported syntax</a>.',
					},
					{
						displayName: 'Exclude Site Name',
						name: 'excludeSiteName',
						type: 'string',
						typeOptions: { rows: 3 },
						default: '',
						placeholder: 'demo|test',
						description:
							'Regular expressions to exclude matching names, one per line, ignoring case. Leave empty to disable. Missing names are kept. See <a href="https://github.com/pemontto/n8n-nodes-sentinelone-platform/blob/main/docs/trigger.md#exclusions">supported syntax</a>.',
					},
					{
						displayName: 'Exclude User IDs',
						name: 'excludeActorIds',
						type: 'string',
						default: '',
						description:
							'Comma-separated IDs of people or services to exclude. Activities without an ID are kept.',
					},
					{
						displayName: 'Exclude User Name',
						name: 'excludeActorName',
						type: 'string',
						typeOptions: { rows: 3 },
						default: '',
						placeholder: 'automation|integration',
						description:
							'Regular expressions to exclude people or services by name, one per line, ignoring case. Leave empty to disable. Missing names are kept. See <a href="https://github.com/pemontto/n8n-nodes-sentinelone-platform/blob/main/docs/trigger.md#exclusions">supported syntax</a>.',
					},
					{
						displayName: 'Include Current Alert',
						name: 'includeCurrentAlert',
						type: 'boolean',
						default: false,
						description:
							'Whether to include the full alert as it is now. Alert summary fields are always included.',
					},
					{
						displayName: 'Include Raw Activity',
						name: 'includeRawActivity',
						type: 'boolean',
						default: false,
						description: 'Whether to include the full activity data alongside the summary',
					},
					simplifyOption,
				],
			},
		],
	};

	methods = {
		loadOptions: {
			...alertFilterLoadOptions,

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
				return await loadListScopeOptions(this, 'SITE', true);
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
		// Only scheduled polls share saved state, so only they need the overlap guard.
		// A manual Fetch Test Event must always run, even while an earlier one is still going.
		const guarded = this.getMode() !== 'manual';

		if (guarded && activePollKeys.has(pollKey)) {
			this.logger.warn('[SentinelOne Platform Trigger] Skipping overlapping poll');

			return null;
		}

		if (guarded) activePollKeys.add(pollKey);

		try {
			const deadline = pollDeadline(this);
			const credentials = await this.getCredentials('sentinelOnePlatformApi');
			const options = this.getNodeParameter('options', {}) as IDataObject;
			// SAFETY: saved collections contain their parameter object or an unevaluated expression.
			const rawOptions = node.parameters?.options as IDataObject | string | undefined;
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
					alertFilters:
						resource === 'alert'
							? parseAlertFilters(this.getNodeParameter('alertFilters', {}), this.getTimezone?.())
							: [],
					filterParameters: node.parameters
						? {
								alertName: typeof rawOptions === 'string' ? rawOptions : rawOptions?.alertName,
								advancedFilters:
									resource === 'alert'
										? typeof rawOptions === 'string'
											? rawOptions
											: rawOptions?.advancedFilters
										: undefined,
								alertFilters: resource === 'alert' ? node.parameters.alertFilters : undefined,
							}
						: undefined,
					alertFilterMatch:
						this.getNodeParameter('alertFilterMatch', 'all') === 'any' ? 'any' : 'all',
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
							? parseActivitySelection(this.getNodeParameter('activityTypes', ['any']))
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

				if (config.alertFilters?.length) {
					let metadata;

					try {
						metadata = await loadAlertFilterMetadata(
							request,
							baseUrl,
							String(credentialIdentity(this).id ?? ''),
						);
					} catch (error) {
						// The poll boundary preserves HTTP status while adding node context.
						// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
						if (!scheduled || [401, 403].includes(responseStatus(error) ?? 0)) throw error;
						this.logger.warn(
							`[SentinelOne Platform Trigger] Unable to validate Alert Filters against field metadata. ${errorMessage(error)}`,
						);
					}

					if (metadata) {
						try {
							validateAlertFilters(config.alertFilters, metadata);
						} catch (error) {
							throw new NodeOperationError(node, errorMessage(error), {
								description: error instanceof TriggerFilterError ? error.description : undefined,
							});
						}
					}
				}

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
							message: 'Unable to poll SentinelOne Unified Alerts.',
							description: errorMessage(error),
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
					error instanceof TriggerFilterError
						? error.message
						: 'Unable to poll SentinelOne Unified Alerts.',
					{
						description:
							error instanceof TriggerFilterError ? error.description : errorMessage(error),
					},
				);

				throw Object.assign(operationError, { cause: error });
			}
		} finally {
			if (guarded) activePollKeys.delete(pollKey);
		}
	}
}
