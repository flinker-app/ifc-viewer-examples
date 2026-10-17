import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { generate } from './example-metadata.mjs';

const examples = generate();

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(repository, 'dist');
assert.equal(dirname(output), repository, 'Build output must remain inside the repository');
if (existsSync(output)) rmSync(output, { recursive: true });
mkdirSync(output, { recursive: true });
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  cpSync(resolve(repository, file), resolve(output, file));
}
// Copy standalone pages and previews without introducing shared chunks.
cpSync(resolve(repository, 'examples'), resolve(output, 'examples'), { recursive: true, filter: source => !source.endsWith('.mjs') });
console.log(`Copied ${examples.length} standalone HTML examples without bundling or shared chunks.`);
