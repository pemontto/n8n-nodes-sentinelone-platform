import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectText, reportFindings } from './privacy-check.mjs';

export function allowedPackageFile(name) {
	if (name.split('/').some((part) => part === '..' || part === '.')) return false;
	return (
		/^(?:package\.json|README\.md|LICENSE\.md|CHANGELOG\.md)$/.test(name) ||
		/^dist\/(?:nodes|credentials)\/.+\.(?:js|js\.map|d\.ts|json|svg|png)$/.test(name)
	);
}

export function checkPackage(directory, output) {
	const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
	if (
		JSON.stringify(manifest.files) !==
		JSON.stringify(['dist/nodes', 'dist/credentials', 'CHANGELOG.md'])
	) {
		throw new Error(
			'Keep the explicit package files whitelist: dist/nodes, dist/credentials, CHANGELOG.md.',
		);
	}
	const target = output ? resolve(output) : mkdtempSync(join(tmpdir(), 'sentinelone-package-'));
	mkdirSync(target, { recursive: true });
	try {
		const packed = JSON.parse(
			execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', target], {
				cwd: directory,
				encoding: 'utf8',
			}),
		);
		if (packed.length !== 1) throw new Error('Expected one package artifact.');
		const archive = join(target, packed[0].filename);
		const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
		const findings = [];
		for (const archiveName of names) {
			const name = archiveName.replace(/^package\//, '');
			if (!archiveName.startsWith('package/') || !allowedPackageFile(name)) {
				findings.push({ file: name, reason: 'unexpected package file' });
				continue;
			}
			const content = execFileSync('tar', ['-xOzf', archive, archiveName], {
				encoding: 'utf8',
				maxBuffer: 10 * 1024 * 1024,
			});
			for (const reason of inspectText(content, name)) findings.push({ file: name, reason });
		}
		for (const entry of [...manifest.n8n.nodes, ...manifest.n8n.credentials]) {
			if (!names.includes(`package/${entry}`) || !existsSync(join(directory, entry)))
				findings.push({ file: entry, reason: 'missing n8n package entry point' });
		}
		reportFindings(findings);
		if (findings.length) throw new Error(`Package check failed with ${findings.length} findings.`);
		console.log(
			`Package check: ${names.length} allowed files, no privacy findings. SHA-512 integrity: ${packed[0].integrity}`,
		);
		if (output) console.log(`Checked artifact: ${archive}`);
		return { filename: packed[0].filename, integrity: packed[0].integrity, files: names.length };
	} finally {
		if (!output) rmSync(target, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	if (args.length && (args.length !== 2 || args[0] !== '--output'))
		throw new Error('Usage: node scripts/package-check.mjs [--output directory]');
	checkPackage(process.cwd(), args[1]);
}
