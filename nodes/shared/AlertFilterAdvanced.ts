import type { INodeProperties } from 'n8n-workflow';

export const advancedAlertFilters: INodeProperties = {
	displayName: 'Advanced Filters',
	name: 'advancedFilters',
	type: 'json',
	default: '[]',
	placeholder:
		'[{ "fieldId": "alertName", "match": { "operator": "contains", "values": ["CloudTrail"] }, "isNegated": true }]',
	description:
		'SentinelOne filters as JSON, always ANDed with Severity, Status, Alert Name and Alert Filters. A list [X, Y]: every filter must match. An or object {"or":[{"and":[X]},{"and":[Y]}]}: at least one group must match. Each filter has a fieldId (for example alertName, ticketId, status, severity, assetName), one comparator, and optional "isNegated": true to exclude. Comparators: match (text ignoring case; operator contains, startsWith, endsWith or exactMatch), stringIn (exact, any of values), stringEqual (exact, one value), dateTimeRange (epoch ms start/end), booleanEqual. Account, site and group are not filterable; use Scope. <a href="https://github.com/pemontto/n8n-nodes-sentinelone-platform/blob/main/docs/trigger.md#advanced-filters">Comparators, all fields and examples</a>.',
};
