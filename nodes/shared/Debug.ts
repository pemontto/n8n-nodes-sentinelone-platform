import type { INodeProperties, Logger, LogMetadata } from 'n8n-workflow';

export const debugSetting: INodeProperties = {
	displayName: 'Debug',
	name: 'nodeDebug',
	type: 'boolean',
	default: false,
	noDataExpression: true,
	isNodeSetting: true,
	description:
		'Whether to log GraphQL requests and timing in the n8n server logs. Variable values and inline string literals are redacted.',
};

type DebugLogger = Pick<Logger, 'info'> | undefined;

interface RequestMetadata {
	operation?: string;
	attempt?: number;
	itemIndex?: number;
}

interface ResultMetadata extends RequestMetadata {
	durationMs: number;
	outcome: 'received' | 'transportError';
	statusCode?: number | null;
	graphqlErrorCount?: number;
}

function redactVariables(value: unknown, seen = new WeakSet<object>()): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value !== 'object') return '[REDACTED]';
	if (seen.has(value)) return '[CIRCULAR]';
	seen.add(value);
	if (Array.isArray(value)) return value.map((entry) => redactVariables(entry, seen));
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [key, redactVariables(entry, seen)]),
	);
}

function redactDocument(document: string): string {
	// Match strings before comments so a # inside a string cannot expose its suffix.
	return document.replace(/"""(?:\\"""|[\s\S])*?"""|"(?:\\[\s\S]|[^"\\])*"|#[^\r\n]*/g, (token) =>
		token.startsWith('#') ? '' : '"[REDACTED]"',
	);
}

function writeLog(logger: DebugLogger, message: string, metadata: LogMetadata): void {
	try {
		logger?.info(`${message} ${JSON.stringify(metadata)}`, metadata);
	} catch {
		// Diagnostic logging must not change a request's result or retry behavior.
	}
}

export function logGraphqlRequest(
	logger: DebugLogger,
	enabled: boolean,
	document: string,
	variables: unknown,
	metadata: RequestMetadata = {},
): void {
	if (!enabled) return;
	try {
		const query = redactDocument(document);
		writeLog(logger, 'SentinelOne GraphQL request', {
			operation: metadata.operation ?? query.match(/\b(?:query|mutation)\s+(\w+)/)?.[1],
			attempt: metadata.attempt,
			itemIndex: metadata.itemIndex,
			query,
			variables: redactVariables(variables),
		});
	} catch {
		// Never let diagnostic serialization prevent the request from being sent.
	}
}

export function logGraphqlResult(
	logger: DebugLogger,
	enabled: boolean,
	metadata: ResultMetadata,
): void {
	if (!enabled) return;
	writeLog(logger, 'SentinelOne GraphQL response', {
		operation: metadata.operation,
		attempt: metadata.attempt,
		itemIndex: metadata.itemIndex,
		durationMs: metadata.durationMs,
		outcome: metadata.outcome,
		statusCode: metadata.statusCode,
		graphqlErrorCount: metadata.graphqlErrorCount,
	});
}
