import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { checkPublicApi } from './public-api-check.mjs';
import { checkStandalone } from './standalone-check.mjs';
import { canonicalOrigin, generate } from './example-metadata.mjs';
import { syncExampleDownloads } from './example-download.mjs';
import { syncExampleIfc } from './example-ifc.mjs';

syncExampleDownloads({ check: true });
syncExampleIfc({ check: true });
const catalog = JSON.parse(readFileSync('catalog/catalog.json', 'utf8'));
const examples = generate({ check: true });
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]);
const paths = new Set(examples.map(example => example.path));
const readme = readFileSync('README.md', 'utf8');
assert.equal(paths.size, examples.length, 'Duplicate canonical examples');
for (const example of examples) {
  assert(existsSync(example.path), `Missing example: ${example.path}`);
  const thumbnail = `${dirname(example.path)}/thumbnail.webp`;
  assert(existsSync(thumbnail), `Missing example preview: ${thumbnail}. Run npm run previews -- --missing`);
  assert(readme.includes(`](${canonicalOrigin + example.href})`), `Missing public HTML link in README: ${example.path}`);
  assert(readme.includes(`src="${thumbnail}"`), `Missing preview in README: ${thumbnail}`);
  assert(['Developer integration', 'BIM workflow'].includes(example.audience), `Missing customer audience: ${example.path}`);
  assert(example.description?.trim(), `Missing example purpose: ${example.path}`);
  checkStandalone(example.path, readFileSync(example.path, 'utf8'));
}
for (const sample of catalog.samples) {
  const example = catalog.examples.find(example => example.id === sample.id);
  assert(example, `Missing sample example: ${sample.id}`);
  assert.deepEqual(sample.assetIds, example.assetIds, `Mismatched sample assets: ${sample.id}`);
}
for (const sample of catalog.examples) {
  assert(existsSync(sample.thumbnail.slice(1)), `Missing thumbnail: ${sample.thumbnail}`);
  for (const id of sample.assetIds) {
    const asset = catalog.assets.find(asset => asset.id === id);
    assert(asset, `Unknown asset: ${id}`);
    assert(asset.noticeUrl === `https://viewer.flinker.app/${examples.find(example => example.assets?.some(item => item.id === id)).path}#example-notices`, `Missing embedded source notice: ${id}`);
  }
}
for (const asset of catalog.assets) {
  assert(asset.sourceUrl && asset.license && asset.attribution && asset.noticeUrl, `Missing provenance: ${asset.id}`);
  assert(examples.some(example => asset.noticeUrl === `https://viewer.flinker.app/${example.path}#example-notices`), `Missing embedded notice: ${asset.noticeUrl}`);
}
const candidates = [...files('examples'), ...files('catalog')];
for (const path of candidates) {
  assert(!/\.(wasm|ifc|laz|las|map|dll|exe)$/.test(path), `Implementation or model binary: ${path}`);
  if (!/\.(html|js|ts|json|css|txt|ids)$/.test(path)) continue;
  const text = readFileSync(path, 'utf8');
  assert(!text.includes('flinker-app/ifc-sample-files'), `Use the original provider instead of a Flinker sample mirror: ${path}`);
  if (/\.(html|js|ts)$/.test(path)) checkPublicApi(path, text);
  assert(!/tempauth=|\beyJ[a-zA-Z0-9_-]{60}|BEGIN (?:RSA |EC )?PRIVATE KEY|(?:api[_-]?key|client[_-]?secret)\s*[:=]\s*["'][^"']{12}/i.test(text), `Possible credential: ${path}`);
  assert(!/(?:from\s*|import\s*\(|src=|href=)["'](?:\/?src\/|(?:\.\.\/)+src\/|(?:\.\.\/)+webgpu-viewer\/)/.test(text), `Private implementation import: ${path}`);
  assert(!/ifc-viewer\.es\.js/.test(path), `Vendored SDK: ${path}`);
  for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(|\bimport\s+|\bsrc=)["'](\.[^"']+)["']/g)) {
    const reference = match[1].split('?')[0];
    const resolved = resolve(dirname(path), reference);
    assert([resolved, `${resolved}.ts`, `${resolved}.js`].some(existsSync), `Unresolved local reference: ${path} -> ${reference}`);
  }
}
console.log(`Checked ${examples.length} standalone examples, public API imports, asset notices and credentials.`);
