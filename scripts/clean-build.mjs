import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (manifest.name !== 'n8n-nodes-sentinelone-platform') throw new Error('Unexpected build root.');
rmSync(join(root, 'dist'), { recursive: true, force: true });
