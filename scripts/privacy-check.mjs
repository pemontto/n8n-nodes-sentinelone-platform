import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ignoredDirectories = new Set([
	'.git',
	'node_modules',
	'dist',
	'.agents',
	'.vscode',
	'coverage',
]);
const ignoredFiles = /(?:\.tgz|\.tsbuildinfo)$|^\.DS_Store$/;
const patterns = [
	[
		'private filesystem path',
		/(?:\/Users\/|\/home\/)[a-z][a-z0-9._-]+\/|[A-Z]:\\Users\\[^\\\s]+\\/i,
	],
	[
		'copied numeric record identifier',
		/["']?(?:alertId|accountId|siteId|groupId)["']?\s*[:=]\s*["']\d{15,}["']/i,
	],
	['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
	[
		'embedded access token',
		/\b(?:npm_[a-z0-9]{30,}|gh[pousr]_[a-z0-9]{30,}|github_pat_[a-z0-9_]{40,})\b/i,
	],
	['copied workflow instance identifier', /["']instanceId["']\s*:\s*["'][0-9a-f]{32,}["']/i],
];

const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
// Obvious fixtures (a repeated first block such as 00000000-... or 11111111-...) and the
// example value printed in SentinelOne's own GraphQL schema documentation.
const documentedExampleUuids = new Set(['abc000e0-9c3e-432b-8654-0360b10800cb']);

function isPlaceholderUuid(uuid) {
	const lower = uuid.toLowerCase();
	return /^([0-9a-f])\1{7}-/.test(lower) || documentedExampleUuids.has(lower);
}

function findCredentialReferences(value) {
	if (!value || typeof value !== 'object') return false;
	if (Array.isArray(value)) return value.some(findCredentialReferences);
	if (
		value.credentials &&
		typeof value.credentials === 'object' &&
		!Array.isArray(value.credentials)
	) {
		for (const credential of Object.values(value.credentials)) {
			if (
				credential &&
				typeof credential === 'object' &&
				('id' in credential || 'name' in credential)
			)
				return true;
		}
	}
	return Object.values(value).some(findCredentialReferences);
}

// Return categories only. Failure output must not repeat the value being removed.
export function inspectText(text, filename = '') {
	const findings = patterns.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
	const uuids = text.match(uuidPattern) ?? [];
	if (uuids.some((uuid) => !isPlaceholderUuid(uuid))) findings.push('UUID record identifier');
	const hosts = text.match(/(?:https?:\/\/)?(?:[a-z0-9-]+\.)+sentinelone\.(?:net|com)\b/gi) ?? [];
	for (const host of hosts) {
		const hostname = host.replace(/^https?:\/\//i, '').toLowerCase();
		if (
			!/^(?:www|docs|support|your-tenant|example|example-tenant|test|test-tenant)\.sentinelone\.(?:net|com)$/.test(
				hostname,
			)
		) {
			findings.push('non-example SentinelOne tenant hostname');
			break;
		}
	}
	if (filename.endsWith('.json')) {
		try {
			if (findCredentialReferences(JSON.parse(text)))
				findings.push('embedded workflow credential reference');
		} catch {
			// Syntax validation belongs to the format-specific checks.
		}
	}
	return findings;
}

export function scanDirectory(root) {
	const findings = [];
	let files = 0;
	function walk(directory) {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (ignoredDirectories.has(entry.name) || entry.name === '.git') continue;
			if (ignoredFiles.test(entry.name)) continue;
			const path = join(directory, entry.name);
			const name = relative(root, path);
			if (/^(?:\.env(?:\..+)?|\.npmrc)$/.test(entry.name) && entry.name !== '.env.example') {
				findings.push({ file: name, reason: 'private local configuration file' });
			}
			if (lstatSync(path).isSymbolicLink()) {
				findings.push({ file: name, reason: 'unreviewed symbolic link' });
			} else if (entry.isDirectory()) {
				walk(path);
			} else {
				files += 1;
				for (const reason of inspectText(readFileSync(path, 'utf8'), name))
					findings.push({ file: name, reason });
				for (const reason of inspectText(name)) findings.push({ file: name, reason });
			}
		}
	}
	walk(root);
	return { files, findings };
}

export function reportFindings(findings) {
	for (const finding of findings) console.error(`${finding.file}: ${finding.reason}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { files, findings } = scanDirectory(resolve(process.argv[2] ?? '.'));
	reportFindings(findings);
	console.log(
		`Privacy check: ${files} files, ${findings.length} findings. Images still require visual review.`,
	);
	if (findings.length) process.exitCode = 1;
}
