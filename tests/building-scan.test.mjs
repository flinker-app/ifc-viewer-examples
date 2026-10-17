import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const html = readFileSync(new URL('../examples/building-scan/index.html', import.meta.url), 'utf8');
const code = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const source = ts.createSourceFile('building-scan.js', code, ts.ScriptTarget.Latest, true);
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'verifySampleAsset');
const verify = new Function(declaration.getText(source) + '\nreturn verifySampleAsset;')();
async function assetFor(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return { name: 'source.laz', bytes: blob.size, sha256: Buffer.from(digest).toString('hex') };
}

test('the model and scan importer preserves verified source bytes and coordinates', async () => {
  const blob = new Blob(['original source coordinates']);
  assert.equal(await verify(await assetFor(blob), blob), blob);
});

test('changed or incomplete provider files cannot silently replace the verified pair', async () => {
  const original = new Blob(['original source coordinates']);
  const asset = await assetFor(original);
  await assert.rejects(verify(asset, new Blob(['short'])), /incomplete/);
  await assert.rejects(verify(asset, new Blob(['modified source coordinates'])), /differs from the verified/);
});

test('GitHub range downloads use source size without consulting gzip transfer size', async () => {
  const bytes = new Uint8Array(4 * 1024 * 1024 + 19);
  const ranges = [];
  const fetch = async (_url, options) => {
    assert.equal(options.method, undefined);
    const range = new Headers(options.headers).get('Range');
    ranges.push(range);
    const [, start, end] = range.match(/^bytes=(\d+)-(\d+)$/).map(Number);
    return new Response(bytes.slice(start, end + 1), { status: 206 });
  };
  const viewer = { async setMessage() {} };
  const download = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'loadExampleFile');
  const load = new Function('viewer', 'fetch', download.getText(source) + '\nreturn loadExampleFile;')(viewer, fetch);
  const result = await load('source.ifc', 'https://raw.githubusercontent.com/xeokit/examples/revision/source.ifc', blob => blob, bytes.length);
  assert.equal(result.size, bytes.length);
  assert.deepEqual(ranges, ['bytes=0-4194303', 'bytes=4194304-4194322']);
});
