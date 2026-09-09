/** Redact common sensitive shapes in bounded service explanations. Never pass request bodies here. */
export function sanitizeReason(value: string, sensitiveValues: string[] = []): string {
	const redactions = new Set(sensitiveValues.filter(Boolean));
	for (const source of sensitiveValues) {
		try {
			const pending: unknown[] = [JSON.parse(source)];
			for (const token of source.match(
				/"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
			) ?? []) {
				if (!token.startsWith('"')) redactions.add(token);
			}
			while (pending.length) {
				const next = pending.pop();
				if (Array.isArray(next)) pending.push(...next);
				else if (next !== null && typeof next === 'object') {
					for (const [key, member] of Object.entries(next)) {
						redactions.add(key);
						pending.push(member);
					}
				} else if (next !== null && next !== '') redactions.add(String(next));
			}
		} catch {
			// Ordinary ticket text is already included verbatim in the redactions.
		}
	}
	for (const sensitive of [...redactions].sort((a, b) => b.length - a.length)) {
		value = value
			.split(sensitive)
			.join('[value]')
			.split(JSON.stringify(sensitive).slice(1, -1))
			.join('[value]');
	}
	return value
		.replace(/https?:\/\/\S+/gi, '[URL]')
		.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
		.replace(/(?:Bearer|ApiToken)\s+\S+/gi, '[credential]')
		.replace(/["'`][^"'`]*["'`]/g, '[value]')
		.replace(/[\r\n\t]+/g, ' ')
		.slice(0, 400);
}
