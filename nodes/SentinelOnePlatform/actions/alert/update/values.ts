import type { IExecuteFunctions } from 'n8n-workflow';
import { isRecord, localError } from '../../common';
import { statusOptions, analystVerdictOptions } from '../../../../shared/Descriptions';
interface UpdateDefinition {
	actionType: string;
	payloadBranch: 'status' | 'analystVerdict' | 'ticketId';
}

export const UPDATE_DEFINITIONS: Record<string, UpdateDefinition> = {
	status: {
		actionType: 'STATUS_UPDATE',
		payloadBranch: 'status',
	},
	analystVerdict: {
		actionType: 'ANALYST_VERDICT_UPDATE',
		payloadBranch: 'analystVerdict',
	},
	ticketId: {
		actionType: 'SET_TICKET_ID',
		payloadBranch: 'ticketId',
	},
};

const STATUS_VALUES = new Set(statusOptions.map((option) => option.value));
const ANALYST_VERDICT_VALUES = new Set(analystVerdictOptions.map((option) => option.value));

export const FIELD_LABELS: Record<string, string> = {
	status: 'Status',
	analystVerdict: 'Analyst Verdict',
	ticketId: 'Ticket ID',
};
function scanTopLevelJsonKeys(json: string): string[] {
	const keys: string[] = [];
	let depth = 0;
	let inString = false;
	let escaped = false;
	let start = -1;
	for (let index = 0; index < json.length; index++) {
		const character = json[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === '\\') escaped = true;
			else if (character === '"') {
				inString = false;
				if (depth === 1 && start >= 0) {
					let next = index + 1;
					while (/\s/.test(json[next] ?? '')) next++;
					if (json[next] === ':') {
						try {
							keys.push(JSON.parse(json.slice(start, index + 1)) as string);
						} catch {
							return [];
						}
					}
				}
			}
			continue;
		}
		if (character === '"') {
			inString = true;
			start = index;
		} else if (character === '{' || character === '[') depth++;
		else if (character === '}' || character === ']') depth--;
	}
	return keys;
}

export function parseUpdateObject(
	context: IExecuteFunctions,
	itemIndex: number,
	value: unknown,
	label: string,
): Record<string, unknown> {
	if (value === undefined || value === null || value === '') return {};
	let parsed: unknown = value;
	if (typeof value === 'string') {
		const keys = scanTopLevelJsonKeys(value);
		if (new Set(keys).size !== keys.length) {
			throw localError(context, itemIndex, `${label} contains a duplicate key.`);
		}
		try {
			parsed = JSON.parse(value) as unknown;
		} catch {
			throw localError(context, itemIndex, `${label} must contain valid JSON.`);
		}
	}
	if (!isRecord(parsed)) throw localError(context, itemIndex, `${label} must be a JSON object.`);
	const keys = Object.keys(parsed);
	if (keys.some((key) => ['__proto__', 'prototype', 'constructor'].includes(key))) {
		throw localError(context, itemIndex, `${label} cannot contain prototype keys.`);
	}
	const unknown = keys.filter(
		(key) => !Object.prototype.hasOwnProperty.call(UPDATE_DEFINITIONS, key),
	);
	if (unknown.length > 0)
		throw localError(
			context,
			itemIndex,
			'Unknown alert update field. Use only Status, Analyst Verdict, or Ticket ID.',
		);
	return parsed;
}

export function validateUpdateValues(
	context: IExecuteFunctions,
	itemIndex: number,
	guided: Record<string, unknown>,
	advanced: Record<string, unknown>,
): Record<string, string> {
	const collisions = Object.keys(guided).filter(
		(key) => guided[key] !== undefined && advanced[key] !== undefined,
	);
	if (collisions.length > 0) {
		throw localError(
			context,
			itemIndex,
			`Alert update fields are duplicated: ${collisions.map((field) => FIELD_LABELS[field]).join(', ')}.`,
		);
	}
	const combined = { ...guided, ...advanced };
	const result: Record<string, string> = {};
	for (const [key, inputValue] of Object.entries(combined)) {
		let rawValue = inputValue;
		if (key === 'ticketId' && rawValue !== null && typeof rawValue === 'object') {
			try {
				rawValue = JSON.stringify(rawValue, (_name, value: unknown) => {
					if (
						typeof value === 'undefined' ||
						typeof value === 'function' ||
						typeof value === 'symbol' ||
						typeof value === 'bigint' ||
						(typeof value === 'number' && !Number.isFinite(value))
					)
						throw new Error('Invalid JSON value');
					return value;
				});
			} catch {
				throw localError(
					context,
					itemIndex,
					'Ticket ID must be text or a JSON-serializable object or array.',
				);
			}
		}
		if (rawValue === undefined || rawValue === null) {
			throw localError(
				context,
				itemIndex,
				`${FIELD_LABELS[key] ?? 'Update field'} cannot be cleared.`,
			);
		}
		if (typeof rawValue !== 'string')
			throw localError(
				context,
				itemIndex,
				`${FIELD_LABELS[key] ?? 'Update field'} must be a string.`,
			);
		const value = key === 'ticketId' ? rawValue : rawValue.trim();
		if (!value.trim())
			throw localError(
				context,
				itemIndex,
				`${FIELD_LABELS[key] ?? 'Update field'} cannot be empty or cleared.`,
			);
		if (key === 'status' && !STATUS_VALUES.has(value)) {
			throw localError(
				context,
				itemIndex,
				'Unsupported Status. Choose a value from the Status list.',
			);
		}
		if (key === 'analystVerdict' && !ANALYST_VERDICT_VALUES.has(value)) {
			throw localError(
				context,
				itemIndex,
				'Unsupported Analyst Verdict. Choose a value from the Analyst Verdict list.',
			);
		}
		result[key] = value;
	}
	if (Object.keys(result).length === 0)
		throw localError(context, itemIndex, 'Select at least one alert field to update.');
	return result;
}
