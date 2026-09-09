import type { IDataObject } from 'n8n-workflow';

export interface ExclusionPatterns {
	excludeAccountName?: string;
	excludeSiteName?: string;
	excludeGroupName?: string;
	excludeNoteAuthorName?: string;
}

/** Bound native regex work without runtime dependencies or worker processes. */
export function compileExclusion(pattern: string | undefined, label: string): RegExp | undefined {
	if (!pattern) return undefined;
	const invalid = () =>
		new Error(
			`${label}: use a valid regex of at most 256 characters, with at most one single-character quantifier (*, +, or ?). Multiple groups, group quantifiers, counted repetitions, lookarounds, and backreferences are not supported. Leave empty to disable.`,
		);
	if (pattern.length > 256) throw invalid();
	let inClass = false;
	let quantifiers = 0;
	let groups = 0;
	for (let index = 0; index < pattern.length; index++) {
		const character = pattern[index];
		if (character === '\\') {
			const escaped = pattern[++index];
			if (!escaped || /[1-9k]/.test(escaped)) throw invalid();
			continue;
		}
		if (character === '[' && !inClass) {
			inClass = true;
			continue;
		}
		if (character === ']' && inClass) {
			inClass = false;
			continue;
		}
		if (inClass) continue;
		if (character === '{' || character === '}') throw invalid();
		if (character === '(' && ++groups > 1) throw invalid();
		if (character === '(' && pattern[index + 1] === '?') {
			if (pattern[index + 2] !== ':') throw invalid();
			index += 2;
			continue;
		}
		if ('*+?'.includes(character)) {
			if (++quantifiers > 1 || pattern[index - 1] === ')') throw invalid();
		}
	}
	try {
		return new RegExp(pattern, 'i');
	} catch {
		throw invalid();
	}
}

export function matchesExclusion(pattern: RegExp | undefined, name: unknown): boolean {
	if (!pattern || typeof name !== 'string' || name.length === 0) return false;
	if (name.length > 1024)
		throw new Error(
			'SentinelOne returned a name longer than the 1024-character exclusion safety limit; state was not advanced.',
		);
	return pattern.test(name);
}

export function noteAuthorName(author: IDataObject | null | undefined): unknown {
	if (author?.__typename === 'UserNoteAuthor') return author.fullName;
	if (author?.__typename === 'RuleNoteAuthor') return author.name;
	return undefined;
}

export function compileExclusions(patterns: ExclusionPatterns) {
	return {
		account: compileExclusion(patterns.excludeAccountName, 'Exclude Account Name'),
		site: compileExclusion(patterns.excludeSiteName, 'Exclude Site Name'),
		group: compileExclusion(patterns.excludeGroupName, 'Exclude Group Name'),
		author: compileExclusion(patterns.excludeNoteAuthorName, 'Exclude Note Author Name'),
	};
}
