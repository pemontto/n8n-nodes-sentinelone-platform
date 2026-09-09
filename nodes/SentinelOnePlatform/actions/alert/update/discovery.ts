import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { apiError, idString, isRecord, localError } from '../../common';
import { FIELD_LABELS, UPDATE_DEFINITIONS } from './values';
import { sanitizeReason } from './results';
export function exactAlertFilter(alertId: string): IDataObject {
	return { or: [{ and: [{ fieldId: 'id', stringIn: { values: [alertId] } }] }] };
}

export interface DiscoveredAction {
	id: string;
	isDisabled: boolean;
	disabledReason: string;
	types: string[];
	triggeredAfter: string[];
	triggersActions: string[];
	field: string;
}

function responseStringArray(
	context: IExecuteFunctions,
	itemIndex: number,
	value: unknown,
	label: string,
	allowNull = false,
): string[] {
	if (allowNull && (value === null || value === undefined)) return [];
	if (!Array.isArray(value))
		throw apiError(context, itemIndex, `SentinelOne returned malformed ${label}.`);
	const result = value.map(idString);
	if (result.some((entry) => entry === null)) {
		throw apiError(context, itemIndex, `SentinelOne returned malformed ${label}.`);
	}
	return result as string[];
}

export function parseDiscoveredActions(
	context: IExecuteFunctions,
	itemIndex: number,
	root: unknown,
	requested: Record<string, string>,
): DiscoveredAction[] {
	if (!isRecord(root) || !Array.isArray(root.data)) {
		throw apiError(context, itemIndex, 'SentinelOne returned malformed available actions.');
	}
	if (root.errors !== undefined && root.errors !== null && !Array.isArray(root.errors)) {
		throw apiError(context, itemIndex, 'SentinelOne returned malformed available-action errors.');
	}
	if (Array.isArray(root.errors) && root.errors.length > 0) {
		throw apiError(context, itemIndex, 'SentinelOne rejected available-action discovery.');
	}
	const available: DiscoveredAction[] = [];
	const availableIds = new Set<string>();
	for (const value of root.data) {
		if (!isRecord(value))
			throw apiError(context, itemIndex, 'SentinelOne returned a malformed available action.');
		const id = idString(value.id);
		if (!id || typeof value.isDisabled !== 'boolean' || !Array.isArray(value.types)) {
			throw apiError(context, itemIndex, 'SentinelOne returned a malformed available action.');
		}
		if (availableIds.has(id))
			throw apiError(context, itemIndex, 'SentinelOne returned duplicate available actions.');
		availableIds.add(id);
		available.push({
			id,
			isDisabled: value.isDisabled,
			disabledReason:
				typeof value.disabledReason === 'string'
					? sanitizeReason(value.disabledReason, [requested.ticketId ?? ''])
					: '',
			types: responseStringArray(context, itemIndex, value.types, 'available-action types'),
			triggeredAfter: responseStringArray(
				context,
				itemIndex,
				value.triggeredAfter,
				'available-action dependencies',
				true,
			),
			triggersActions: responseStringArray(
				context,
				itemIndex,
				value.triggersActions,
				'available-action transitive actions',
			),
			field: '',
		});
	}
	const selected: DiscoveredAction[] = [];
	for (const field of Object.keys(requested)) {
		const definition = UPDATE_DEFINITIONS[field];
		const matching = available.filter((action) => action.types.includes(definition.actionType));
		const enabled = matching.filter((action) => !action.isDisabled);
		if (enabled.length === 0) {
			const label = FIELD_LABELS[field];
			const reason = matching
				.map((action) => action.disabledReason)
				.filter(Boolean)
				.join('; ');
			throw localError(
				context,
				itemIndex,
				matching.length
					? `SentinelOne disabled ${label} for this alert.${reason ? ` ${reason}` : ' No reason was supplied.'}`
					: `SentinelOne has not advertised a ${label} action for this alert.`,
			);
		}
		if (enabled.length > 1) {
			throw localError(
				context,
				itemIndex,
				`SentinelOne returned more than one enabled ${FIELD_LABELS[field]} action. Refusing an ambiguous update.`,
			);
		}
		const action = enabled[0];
		if (selected.some((entry) => entry.id === action.id)) {
			throw localError(
				context,
				itemIndex,
				'SentinelOne mapped several requested fields to the same runtime action. Refusing an ambiguous update.',
			);
		}
		selected.push({ ...action, field });
	}
	const selectedIds = new Set(selected.map((action) => action.id));
	for (const action of selected) {
		const transitiveCollision = action.triggersActions.find((id) => selectedIds.has(id));
		if (transitiveCollision) {
			throw localError(
				context,
				itemIndex,
				`SentinelOne action ${action.id} also triggers requested action ${transitiveCollision}; the update is ambiguous.`,
			);
		}
	}
	return selected;
}

export function orderActions(
	context: IExecuteFunctions,
	itemIndex: number,
	actions: DiscoveredAction[],
): DiscoveredAction[] {
	const byId = new Map(actions.map((action) => [action.id, action]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const ordered: DiscoveredAction[] = [];
	const visit = (action: DiscoveredAction): void => {
		if (visited.has(action.id)) return;
		if (visiting.has(action.id))
			throw localError(context, itemIndex, 'SentinelOne action dependencies contain a cycle.');
		visiting.add(action.id);
		for (const dependencyId of action.triggeredAfter) {
			const dependency = byId.get(dependencyId);
			if (dependency) visit(dependency);
		}
		visiting.delete(action.id);
		visited.add(action.id);
		ordered.push(action);
	};
	for (const action of actions) visit(action);
	return ordered;
}
