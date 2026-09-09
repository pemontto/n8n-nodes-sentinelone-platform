import type { IDataObject } from 'n8n-workflow';

export function asRecord(value: unknown): IDataObject | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as IDataObject)
		: undefined;
}

export function safeError(message: string): Error {
	return new Error(`SentinelOne SDL query ${message}`);
}

export function requireString(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim()) throw safeError(`requires ${label}`);
	return value.trim();
}

export function validateNoQueryErrors(payload: IDataObject): void {
	for (const source of [payload, asRecord(payload.data)]) {
		if (!source) continue;
		const errors = source.errors;
		if (errors !== undefined && errors !== null && (!Array.isArray(errors) || errors.length > 0))
			throw safeError('received query errors');
	}
}

export function jsonBytes(value: unknown): number {
	let encoded: string | undefined;
	try {
		encoded = JSON.stringify(value);
	} catch {
		throw safeError('received data that cannot be represented as JSON');
	}
	if (encoded === undefined) throw safeError('received data that cannot be represented as JSON');
	return Buffer.byteLength(encoded, 'utf8');
}
