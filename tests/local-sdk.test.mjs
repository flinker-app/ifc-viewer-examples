import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { localSdk } from '../scripts/local-sdk.mjs';
import configuration from '../viewer-sdk.config.json' with { type: 'json' };

test('development uses the published CDN unless a local SDK is explicitly selected', () => {
  const plugin = localSdk({ directory: '' });
  assert.equal(plugin.name, 'published-viewer-sdk');
  assert.equal(plugin.transformIndexHtml, undefined);
});

test('development serves a local SDK and assets without changing production HTML', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ifc-examples-local-sdk-'));
  t.after(() => {
    assert.ok(directory.startsWith(join(tmpdir(), 'ifc-examples-local-sdk-')));
    rmSync(directory, { recursive: true, force: true });
  });
  mkdirSync(join(directory, 'assets'));
  writeFileSync(join(directory, 'ifc-viewer.es.js'), 'export class Viewer {}');
  writeFileSync(join(directory, 'assets', 'worker.js'), 'self.postMessage("ready");');
  const plugin = localSdk({ directory });
  const html = `<script type="module">import { Viewer } from '${configuration.url}';</script>`;
  assert.equal(plugin.transformIndexHtml.handler(html, {}), html, 'production keeps the direct CDN import');
  const server = await createServer({ configFile: false, root: directory, plugins: [plugin], server: { host: '127.0.0.1', port: 0 } });
  t.after(() => server.close());
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  const transformed = plugin.transformIndexHtml.handler(html, { server });
  assert.ok(transformed.includes(new URL('/__viewer_sdk__/ifc-viewer.es.js', origin).href));
  const sdk = await fetch(new URL('/__viewer_sdk__/ifc-viewer.es.js', origin));
  assert.equal(await sdk.text(), 'export class Viewer {}');
  assert.equal(sdk.headers.get('cache-control'), 'no-store');
  const worker = await fetch(new URL('/__viewer_sdk__/assets/worker.js', origin));
  assert.equal(await worker.text(), 'self.postMessage("ready");');
  assert.equal((await fetch(new URL('/__viewer_sdk__/..%2foutside.js', origin))).status, 404);
});

test('an explicit missing SDK build gives an actionable error', () => {
  assert.throws(() => localSdk({ directory: join(tmpdir(), 'ifc-examples-no-such-sdk-build') }), /Local SDK build is missing/);
});
