import type { INodeProperties } from 'n8n-workflow';
import {
	additionalAlertFieldOptions,
	alertDetailFieldOptions,
	type AlertProjection,
} from './AlertFields';
export const severityOptions = [
	{ name: 'Critical', value: 'CRITICAL' },
	{ name: 'High', value: 'HIGH' },
	{ name: 'Informational', value: 'INFO' },
	{ name: 'Low', value: 'LOW' },
	{ name: 'Medium', value: 'MEDIUM' },
	{ name: 'Unknown', value: 'UNKNOWN' },
];
export const statusOptions = [
	{ name: 'In Progress', value: 'IN_PROGRESS' },
	{ name: 'New', value: 'NEW' },
	{ name: 'Resolved', value: 'RESOLVED' },
];
export const analystVerdictOptions = [
	{ name: 'False Positive: Benign', value: 'FALSE_POSITIVE_BENIGN' },
	{
		name: 'False Positive: Benign but Suspicious',
		value: 'FALSE_POSITIVE_BENIGN_BUT_SUSPICIOUS',
	},
	{ name: 'False Positive: System Error', value: 'FALSE_POSITIVE_SYSTEM_ERROR' },
	{ name: 'False Positive: Undefined', value: 'FALSE_POSITIVE_UNDEFINED' },
	{ name: 'False Positive: User Error', value: 'FALSE_POSITIVE_USER_ERROR' },
	{
		name: 'True Positive: Advanced Persistent Threat',
		value: 'TRUE_POSITIVE_ADVANCED_PERSISTENT_THREAT',
	},
	{ name: 'True Positive: Benign', value: 'TRUE_POSITIVE_BENIGN' },
	{
		name: 'True Positive: Benign but Suspicious',
		value: 'TRUE_POSITIVE_BENIGN_BUT_SUSPICIOUS',
	},
	{ name: 'True Positive: Data Exfiltration', value: 'TRUE_POSITIVE_DATA_EXFILTRATION' },
	{ name: 'True Positive: Denial of Service', value: 'TRUE_POSITIVE_DENIAL_OF_SERVICE' },
	{ name: 'True Positive: Exploitation Tools', value: 'TRUE_POSITIVE_EXPLOITATION_TOOLS' },
	{ name: 'True Positive: Insider Threat', value: 'TRUE_POSITIVE_INSIDER_THREAT' },
	{ name: 'True Positive: Malware', value: 'TRUE_POSITIVE_MALWARE' },
	{ name: 'True Positive: Phishing Attack', value: 'TRUE_POSITIVE_PHISHING_ATTACK' },
	{ name: 'True Positive: Policy Violation', value: 'TRUE_POSITIVE_POLICY_VIOLATION' },
	{ name: 'True Positive: PUA/Adware', value: 'TRUE_POSITIVE_PUA_ADWARE' },
	{ name: 'True Positive: Ransomware', value: 'TRUE_POSITIVE_RANSOMWARE' },
	{ name: 'True Positive: Unauthorized Access', value: 'TRUE_POSITIVE_UNAUTHORIZED_ACCESS' },
	{ name: 'True Positive: Undefined', value: 'TRUE_POSITIVE_UNDEFINED' },
	{ name: 'Undefined', value: 'UNDEFINED' },
];
export const alertId: INodeProperties = {
	displayName: 'Alert ID',
	name: 'alertId',
	type: 'string',
	default: '',
	required: true,
	description: 'ID of the alert',
};

export function additionalAlertFields(projection: AlertProjection): INodeProperties {
	return {
		displayName: 'Additional Alert Fields',
		name: 'additionalAlertFields',
		type: 'multiOptions',
		default: [],
		options: projection === 'list' ? additionalAlertFieldOptions : alertDetailFieldOptions,
		description: 'Extra fields to query and return in addition to the standard alert fields',
	};
}

export function managementScopeFields(
	displayOptions?: INodeProperties['displayOptions'],
): INodeProperties[] {
	return [
		{
			displayName: 'Account Names or IDs',
			name: 'accountIds',
			type: 'multiOptions',
			default: [],
			hint: 'Optional. Leave empty for all credential-visible accounts.',
			typeOptions: { loadOptionsMethod: 'getAccounts' },
			...(displayOptions ? { displayOptions } : {}),
			description:
				'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
		},
		{
			displayName: 'Site Names or IDs',
			name: 'siteIds',
			type: 'multiOptions',
			default: [],
			hint: 'Optional. Leave empty to keep the account scope; otherwise choose accessible sites.',
			typeOptions: { loadOptionsMethod: 'getSites', loadOptionsDependsOn: ['accountIds'] },
			...(displayOptions ? { displayOptions } : {}),
			description:
				'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
		},
		{
			displayName: 'Group Names or IDs',
			name: 'groupIds',
			type: 'multiOptions',
			default: [],
			hint: 'Optional. Leave empty to use the selected sites.',
			typeOptions: {
				loadOptionsMethod: 'getGroups',
				loadOptionsDependsOn: ['accountIds', 'siteIds'],
			},
			displayOptions: {
				...displayOptions,
				show: { ...displayOptions?.show, siteIds: [{ _cnd: { exists: true } }] },
			},
			description:
				'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
		},
	];
}
