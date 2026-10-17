import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readExamples } from './example-metadata.mjs';

// Development verification only. No IFC source files or parsing code are shipped
// with the examples. Hash checks cover the original upstream bytes before import.
const ids = ['storey-visibility', 'window-width', 'component-lookup'];
const examples = readExamples().filter(example => ids.includes(example.id));
const cache = join(tmpdir(), 'ifc-workflow-verified-sources');
mkdirSync(cache, { recursive: true });
const assets = new Map(examples.flatMap(example => example.assets).map(asset => [asset.id, asset]));
for (const asset of assets.values()) {
  const path = join(cache, asset.sha256 + '.ifc');
  let bytes = existsSync(path) ? readFileSync(path) : null;
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(120000) });
    assert(response.ok, asset.url + ': HTTP ' + response.status);
    bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, asset.bytes, asset.name + ' source size');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, asset.name + ' source hash');
    writeFileSync(path, bytes);
  }
  assert.equal(bytes.length, asset.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
  console.log('Verified original bytes: ' + asset.name + ' (' + bytes.length + ')');
}
const references = new Set(examples.flatMap(example => [...example.guideHtml.matchAll(/href="(https:[^"]+)"/g)].map(match => match[1])));
for (const reference of references) {
  const url = reference.replace('https://github.com/', 'https://raw.githubusercontent.com/').replace('/blob/', '/');
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) }); assert(response.ok, reference + ': HTTP ' + response.status); await response.arrayBuffer();
}
console.log('Verified ' + references.size + ' primary-source example references. Verified pinned workflow model sources.');
