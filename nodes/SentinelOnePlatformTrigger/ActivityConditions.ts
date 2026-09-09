import type { ActivityFeedEvent } from './ActivityFeed';
import { analystVerdictOptions, severityOptions, statusOptions } from '../shared/Descriptions';

export const mitigationActionTypes = [
	'BLOCKLIST_ADD',
	'EXCLUSION_ADD',
	'IDENTITY',
	'KILL',
	'PARTNER',
	'QUARANTINE',
	'REMEDIATE',
	'REMOVE_MACROS',
	'RESTORE_MACROS',
	'ROLLBACK',
	'UNQUARANTINE',
	'WORKFLOW',
];
export const mitigationActivityStatuses = [
	'ADDED',
	'CANCELLED',
	'FAILED',
	'PARTIAL',
	'PENDING',
	'PENDING_REBOOT',
	'RUNNING',
	'SENT',
	'SUCCESS',
];
export const mitigationActionTypeOptions = mitigationActionTypes.map((value) => ({
	name: value,
	value,
}));
export const mitigationActivityStatusOptions = mitigationActivityStatuses.map((value) => ({
	name: value,
	value,
}));
export interface ActivityCondition {
	field: 'status' | 'analystVerdict' | 'severity' | 'assignment' | 'mitigation';
	from?: string[];
	to?: string[];
	previousEmail?: string[];
	newEmail?: string[];
	destinationIds?: string[];
	actionTypes?: string[];
	activityStatuses?: string[];
}
function invalid(): never {
	throw new Error(
		'Invalid alert activity condition. Use the condition builder and supported values.',
	);
}
export function parseExactValues(value: unknown): string[] {
	if (value === undefined || value === '') return [];
	if (typeof value !== 'string') return invalid();
	const values = [
		...new Set(
			value
				.split(',')
				.map((part) => part.trim())
				.filter(Boolean),
		),
	];
	if (values.length > 100 || values.some((item) => item.length > 1024)) return invalid();
	return values;
}
export function parseActivitySelection(value: unknown, custom: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) return invalid();
	const known = ['16000', '16001', '16002', '16003', '16004', '16005', '16007'];
	if (value.some((id) => id !== 'any' && !known.includes(id))) return invalid();
	const extra = parseExactValues(custom);
	if (extra.some((id) => !/^\d{1,30}$/.test(id))) return invalid();
	if (value.includes('any')) return undefined;
	if (!value.length && !extra.length) return invalid();
	return [...new Set([...value, ...extra])].sort();
}
function selected(value: unknown, allowed: string[]): string[] {
	if (value === undefined) return [];
	if (
		!Array.isArray(value) ||
		value.some((item) => typeof item !== 'string' || !allowed.includes(item))
	)
		return invalid();
	return [...new Set(value)] as string[];
}
export function parseActivityConditions(value: unknown): ActivityCondition[] {
	if (value === undefined) return [];
	if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
	const rows = (value as { conditions?: unknown }).conditions;
	if (rows === undefined) return [];
	if (!Array.isArray(rows) || rows.length > 100) return invalid();
	return rows.map((row) => {
		if (!row || typeof row !== 'object' || Array.isArray(row)) return invalid();
		const field: unknown = row.field;
		const pairs = {
			status: ['Status', statusOptions],
			analystVerdict: ['Verdict', analystVerdictOptions],
			severity: ['Severity', severityOptions],
		} as const;
		if (field === 'status' || field === 'analystVerdict' || field === 'severity') {
			const [suffix, options] = pairs[field];
			return {
				field,
				from: selected(
					row[`from${suffix}`],
					options.map((o) => o.value),
				),
				to: selected(
					row[`to${suffix}`],
					options.map((o) => o.value),
				),
			};
		}
		if (field === 'assignment')
			return {
				field,
				previousEmail: parseExactValues(row.previousEmail),
				newEmail: parseExactValues(row.newEmail),
				destinationIds: parseExactValues(row.destinationIds),
			};
		if (field === 'mitigation')
			return {
				field,
				actionTypes: selected(row.actionTypes, mitigationActionTypes),
				activityStatuses: selected(row.activityStatuses, mitigationActivityStatuses),
			};
		return invalid();
	});
}
function valueMatches(values: string[] | undefined, value: unknown): boolean {
	return !values?.length || (typeof value === 'string' && values.includes(value));
}
export function matchesActivityConditions(
	event: ActivityFeedEvent,
	conditions: ActivityCondition[] = [],
	match: 'any' | 'all' = 'any',
): boolean {
	const conditionMatches = (condition: ActivityCondition): boolean => {
		if (condition.field === 'mitigation')
			return (
				event.mitigation !== undefined &&
				valueMatches(condition.actionTypes, event.mitigation.actionType) &&
				valueMatches(condition.activityStatuses, event.mitigation.activityStatus)
			);
		if (condition.field === 'assignment') {
			const email = event.changes.find((change) => change.field === 'assigneeEmail');
			const id = event.changes.find((change) => change.field === 'assigneeId');
			return (
				(email !== undefined || id !== undefined) &&
				valueMatches(condition.previousEmail, email?.oldValue) &&
				valueMatches(condition.newEmail, email?.newValue) &&
				valueMatches(condition.destinationIds, id?.newValue)
			);
		}
		return event.changes.some(
			(change) =>
				change.field === condition.field &&
				Object.prototype.hasOwnProperty.call(change, 'oldValue') &&
				Object.prototype.hasOwnProperty.call(change, 'newValue') &&
				change.oldValue !== change.newValue &&
				valueMatches(condition.from, change.oldValue) &&
				valueMatches(condition.to, change.newValue),
		);
	};
	return (
		conditions.length === 0 ||
		(match === 'all' ? conditions.every(conditionMatches) : conditions.some(conditionMatches))
	);
}
