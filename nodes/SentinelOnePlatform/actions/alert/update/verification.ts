import { sleep } from 'n8n-workflow';
import type { IDataObject } from 'n8n-workflow';
import { isRecord } from '../../common';

export interface VerificationRuntime {
	now(): number;
	sleep(ms: number): Promise<void>;
	random(): number;
}
const runtime: VerificationRuntime = { now: Date.now, sleep, random: Math.random };

class ExactJsonNumber {
	readonly value: string;
	constructor(source: string) {
		const [mantissa, exponent = '0'] = source.toLowerCase().split('e');
		const negative = mantissa.startsWith('-');
		const [whole, fraction = ''] = mantissa.replace(/^-/, '').split('.');
		const digits = (whole + fraction).replace(/^0+/, '');
		if (!digits) {
			this.value = '0';
			return;
		}
		const significant = digits.replace(/0+$/, '');
		const scale =
			BigInt(exponent) - BigInt(fraction.length) + BigInt(digits.length - significant.length);
		this.value = `${negative ? '-' : ''}${significant}e${scale}`;
	}
}

function parseComparisonJson(source: string): unknown {
	let missingNumberSource = false;
	const parsed: unknown = JSON.parse(
		source,
		(_key: string, value: unknown, context?: { source?: string }) => {
			if (typeof value !== 'number') return value;
			if (context?.source) return new ExactJsonNumber(context.source);
			missingNumberSource = true;
			return value;
		},
	);
	// Older JS engines cannot prove numeric equality without the original token.
	if (missingNumberSource) throw new Error('Exact numeric comparison is unavailable');
	return parsed;
}

function sameJson(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (left instanceof ExactJsonNumber || right instanceof ExactJsonNumber)
		return (
			left instanceof ExactJsonNumber &&
			right instanceof ExactJsonNumber &&
			left.value === right.value
		);
	if (Array.isArray(left) || Array.isArray(right))
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((item, index) => sameJson(item, right[index]))
		);
	if (!isRecord(left) || !isRecord(right)) return false;
	const keys = Object.keys(left);
	return (
		keys.length === Object.keys(right).length &&
		keys.every(
			(key) => Object.prototype.hasOwnProperty.call(right, key) && sameJson(left[key], right[key]),
		)
	);
}

export function valuesEqual(field: string, requested: string, observed: unknown): boolean {
	if (field === 'ticketId' && typeof observed === 'string') {
		try {
			return sameJson(parseComparisonJson(requested), parseComparisonJson(observed));
		} catch {
			/* Ordinary ticket strings use exact comparison. */
		}
	}
	return requested === observed;
}

export function unavailableVerification(requested: Record<string, string>): IDataObject {
	return Object.fromEntries(
		Object.entries(requested).map(([field, value]) => [
			field,
			{ requested: value, observed: null, verified: null },
		]),
	);
}

export interface VerificationResult {
	verification: IDataObject;
	verificationStatus: 'verified' | 'mismatch' | 'unavailable';
	alert?: IDataObject;
	verificationAttempts: number;
}

/** The read callback must make exactly one request, with the supplied timeout. */
export async function verifyUpdate(
	requested: Record<string, string>,
	read: (timeoutMs: number) => Promise<IDataObject>,
	clock: VerificationRuntime = runtime,
): Promise<VerificationResult> {
	const deadline = clock.now() + 30_000;
	let attempts = 0;
	let result: VerificationResult = {
		verification: unavailableVerification(requested),
		verificationStatus: 'unavailable',
		verificationAttempts: 0,
	};
	let retryAfter = 0;
	while (attempts < 3) {
		if (attempts > 0) {
			const delay = Math.max(
				(attempts === 1 ? 1000 : 2000) + Math.floor(clock.random() * 200),
				retryAfter,
			);
			if (delay >= deadline - clock.now()) break;
			await clock.sleep(delay);
		}
		const remaining = deadline - clock.now();
		if (remaining <= 0) break;
		attempts++;
		try {
			const alert = await read(remaining);
			const verification: IDataObject = Object.fromEntries(
				Object.entries(requested).map(([field, value]) => [
					field,
					{
						requested: value,
						observed: alert[field] ?? null,
						verified:
							Object.prototype.hasOwnProperty.call(alert, field) &&
							(typeof alert[field] === 'string' || (field === 'ticketId' && alert[field] === null))
								? valuesEqual(field, value, alert[field])
								: null,
					},
				]),
			);
			const verified = Object.values(verification).every(
				(value) => isRecord(value) && value.verified === true,
			);
			const unavailable = Object.values(verification).some(
				(value) => isRecord(value) && value.verified === null,
			);
			result = {
				verification,
				verificationStatus: unavailable ? 'unavailable' : verified ? 'verified' : 'mismatch',
				alert,
				verificationAttempts: attempts,
			};
			if (verified || unavailable) return result;
			retryAfter = 0;
		} catch (error) {
			result = {
				verification: unavailableVerification(requested),
				verificationStatus: 'unavailable',
				verificationAttempts: attempts,
			};
			if (!isRecord(error) || error.retryable !== true) break;
			retryAfter =
				typeof error.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs)
					? Math.max(0, error.retryAfterMs)
					: 0;
		}
	}
	return { ...result, verificationAttempts: attempts };
}
