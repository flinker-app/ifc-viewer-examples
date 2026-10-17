import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { readNativeEntities } from './native-ifc-probe.mjs';
import { readExamples } from './example-metadata.mjs';

// Serve each HTML at an unrelated URL: the demo cannot accidentally rely on its
// repository path, a sibling page, a bundler or the local development SDK.
const cases = ['storey-visibility', 'window-width', 'component-lookup'];
const selected = process.argv.find(value => value.startsWith('--sample='))?.slice(9).split(',') ?? cases;
for (const id of selected) if (!cases.includes(id)) throw new Error('Unknown workflow: ' + id);
const examples = readExamples().filter(example => selected.includes(example.id));
const sdkUrl = JSON.parse(readFileSync('viewer-sdk.config.json', 'utf8')).url;
const cachedModels = new Map();
if (process.argv.includes('--cached-sources')) {
  for (const asset of examples.flatMap(example => example.assets)) {
    if (cachedModels.has(asset.url)) continue;
    const bytes = readFileSync(join(tmpdir(), 'ifc-workflow-verified-sources', asset.sha256 + '.ifc'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);
    expect(bytes.length).toBe(asset.bytes); cachedModels.set(asset.url, bytes);
  }
  console.log('Using original, hash-verified source bytes from verify:workflow-sources; published SDK and standalone HTML stay unchanged.');
}
const instrumentation = `<script>
window.workflowCalls = []; window.workflowMessages = [];
let instance;
Object.defineProperty(window, 'exampleViewer', { configurable: true, get: () => instance, set(viewer) {
  instance = viewer;
  for (const method of ['add', 'selectTopic', 'clear', 'setMessage']) {
    const original = viewer[method];
    viewer[method] = async function(...args) {
      const call = { method, argument: args[0] }; window.workflowCalls.push(call);
      if (method === 'setMessage') window.workflowMessages.push({ text: args[0], type: args[1]?.type });
      if (method === 'add' && /\\.bcf$/.test(args[0])) window.workflowLastBcf = args[1];
      try { call.result = await original.apply(this, args); call.complete = true; return call.result; }
      catch (error) { call.error = String(error); throw error; }
    };
  }
} });
</script>`;
const server = createServer((request, response) => {
  const id = new URL(request.url, 'http://localhost').searchParams.get('example');
  const example = examples.find(example => example.id === id);
  if (!example) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(readFileSync(example.path, 'utf8').replace('</head>', instrumentation + '</head>'));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ ...(process.platform === 'win32' ? { channel: 'chrome' } : {}), headless: true, args: ['--enable-unsafe-webgpu'] });
mkdirSync('test-results/workflows', { recursive: true });
const report = [];
try {
  for (const example of examples) for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    console.log(`Checking ${example.id} at ${viewport.width}px (published SDK, isolated HTML)`);
    const context = await browser.newContext({ viewport, acceptDownloads: true });
    for (const [source, bytes] of cachedModels) await context.route(source, route => {
      const request = route.request(), range = request.headers().range?.match(/^bytes=(\d+)-(\d+)$/);
      const start = range ? Number(range[1]) : 0, end = range ? Number(range[2]) : bytes.length - 1;
      return route.fulfill({ status: range ? 206 : 200, contentType: 'application/octet-stream',
        headers: { 'Content-Length': String(end - start + 1), 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes',
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) },
        body: request.method() === 'HEAD' ? Buffer.alloc(0) : bytes.subarray(start, end + 1) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const errors = [], modelRequests = new Set();
    page.on('request', request => {
      if (/\.ifc$/i.test(new URL(request.url()).pathname)) modelRequests.add(request.url());
    });
    page.on('pageerror', error => errors.push(error.message));
    const settled = async (expected = 'loaded') => {
      await expect.poll(async () => ['loaded', 'error'].includes(await page.locator('body').getAttribute('data-example-state')), { timeout: 180000 }).toBe(true);
      expect(await page.locator('body').getAttribute('data-example-state'), await page.locator('#result').innerText()).toBe(expected);
      if (expected === 'loaded') {
        await expect(page.locator('#task')).toHaveJSProperty('disabled', false);
        await page.getByText(/^Processing view(?:\.{3}|…)?$/).waitFor({ state: 'hidden' });
        // Model-backed BCF imports and topic selection must preserve the sidebar.
        // Never close it in the test: doing so would hide a CDN regression.
        await expect(page.getByText('Download BCF', { exact: true })).toBeHidden();
      }
      expect(errors).toEqual([]);
    };
    const state = async () => page.evaluate(async sdkUrl => {
      const { bcf } = await import(sdkUrl);
      const archive = await bcf.load(window.workflowLastBcf);
      const view = Object.values(archive.entries).find(entry => entry.document?.root.name === 'VisualizationInfo').document.root;
      const child = (node, name) => node.content.find(item => item.name === name);
      const components = child(view, 'Components'), visibility = child(components, 'Visibility');
      const colors = child(components, 'Coloring')?.content ?? [];
      return { visible: child(visibility, 'Exceptions')?.content.map(item => item.attributes.IfcGuid) ?? [],
        defaultVisibility: visibility.attributes.DefaultVisibility,
        selected: child(components, 'Selection')?.content.map(item => item.attributes.IfcGuid) ?? [],
        colors: colors.map(item => ({ color: item.attributes.Color, ids: (child(item, 'Components') ?? item).content.map(item => item.attributes.IfcGuid) })),
        camera: child(view, 'OrthogonalCamera') ?? null };
    }, sdkUrl);
    const range = async (selector, value) => {
      await page.locator(selector).fill(String(value));
      await settled();
    };
    let lastGeometryPixels = 0;
    const picture = async name => {
      await page.waitForTimeout(1100); // SDK camera damping continues after select resolves.
      const buffer = await page.screenshot({ path: `test-results/workflows/${example.id}-${viewport.width}-${name}.png` });
      const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const panels = await page.locator('.example-ui').evaluateAll(elements => elements.map(element => {
        const { left, top, right, bottom } = element.getBoundingClientRect(); return { left, top, right, bottom };
      }));
      lastGeometryPixels = 0;
      // Exclude the toolbar and host controls, so colored UI labels cannot make
      // a blank/ghosted model pass the rendering check.
      for (let y = 70; y < info.height - 24; y++) for (let x = 45; x < info.width - 12; x++) {
        if (panels.some(panel => x >= panel.left && x < panel.right && y >= panel.top && y < panel.bottom)) continue;
        const offset = (y * info.width + x) * info.channels;
        const [r, g, b] = data.subarray(offset, offset + 3);
        if (Math.min(r, g, b) < 220) lastGeometryPixels++;
      }
    };
    try {
      await page.goto(`${origin}/unrelated/standalone.html?example=${example.id}`);
      await settled();
      await picture('initial');
      expect(lastGeometryPixels, 'Model geometry renders outside the host UI').toBeGreaterThan(100);
      if (example.id === 'storey-visibility') {
        const inputs = page.locator('#task input');
        for (let i = 0; i < await inputs.count(); i++) { await inputs.nth(i).uncheck(); await settled(); }
        expect((await state()).visible).toEqual([]);
        let previous = 0;
        for (let i = 0; i < await inputs.count(); i++) {
          await inputs.nth(i).check(); await settled();
          const count = (await state()).visible.length; expect(count).toBeGreaterThan(previous); previous = count;
        }
      } else if (example.id === 'window-width') {
        const total = (await state()).visible.length; expect(total).toBeGreaterThan(0);
        let previous = Infinity;
        for (const value of [500, 1000, 1500, 2500]) {
          await range('#threshold', value);
          const current = await state(), large = current.colors.find(item => item.color === 'FFF59E0B');
          expect(current.visible.length).toBe(total);
          expect((large?.ids.length ?? 0)).toBeLessThanOrEqual(previous); previous = (large?.ids.length ?? 0);
          await expect(page.locator('#result')).toContainText('≥ ' + value + ' mm');
        }
        await page.locator('#threshold').evaluate(input => {
          for (const value of [600, 1500, 1200]) {
            input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
        await settled();
        await expect(page.locator('#result')).toContainText('≥ 1200 mm');
      } else if (example.id === 'component-lookup') {
        const input = page.locator('#search');
        const submit = page.locator('#search-form button');
        const total = (await readNativeEntities(page, 'IFCPRODUCT')).total;
        await expect(input).toHaveValue('Width');
        await expect(page.locator('#result')).toHaveText((await state()).visible.length + ' matching components');
        await expect(page.locator('#task input')).toHaveCount(1);
        await expect(page.locator('.example-controls button')).toHaveCount(1);
        await input.fill('  width  '); await submit.click(); await settled();
        const count = Number((await page.locator('#result').innerText()).split(' ')[0]);
        expect(count).toBeGreaterThan(0); expect((await state()).visible).toHaveLength(count);
        expect((await state()).defaultVisibility).toBe('false');
        expect((await state()).selected).toEqual([]);
        expect((await state()).colors).toEqual([]);
        await input.fill('no-such-property-value-xyz'); await input.press('Enter'); await settled();
        await expect(page.locator('#result')).toHaveText('0 matching components');
        expect((await state()).selected).toEqual([]);
        expect((await state()).visible).toEqual([]);
        expect((await state()).defaultVisibility).toBe('false');
        const guid = (await readNativeEntities(page, 'IFCDOOR', 1)).rows[0].GlobalId.value;
        await input.fill(guid); await submit.click(); await settled();
        await expect(page.locator('#result')).toHaveText('1 matching components');
        expect((await state()).visible).toEqual([guid]);
        expect((await state()).defaultVisibility).toBe('false');
        expect((await state()).selected).toEqual([]);
        await input.fill(''); await submit.click(); await settled();
        await expect(page.locator('#result')).toHaveText(total + ' searchable components');
        expect((await state()).selected).toEqual([]);
        expect((await state()).visible).toEqual([]);
        expect((await state()).defaultVisibility).toBe('true');
        await input.fill('Width'); await submit.click(); await settled();
        await picture('property-results');
      }

      // Check resizing the live example, including re-framing a portrait camera.
      if (viewport.width === 1280) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(350); await settled(); await expect(page.getByText('Download BCF', { exact: true })).toBeHidden();
        await picture('resized');
        expect(lastGeometryPixels, 'Model geometry remains visible after resizing').toBeGreaterThan(100);
      }
      const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth,
        panels: [...document.querySelectorAll('.example-ui')].map(element => { const b = element.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, bottom: b.bottom, overflow: element.scrollWidth > element.clientWidth + 1 }; }) }));
      expect(layout.overflow).toBe(false);
      const size = page.viewportSize();
      for (const panel of layout.panels) { expect(panel.x).toBeGreaterThanOrEqual(0); expect(panel.y).toBeGreaterThanOrEqual(0); expect(panel.right).toBeLessThanOrEqual(size.width); expect(panel.bottom).toBeLessThanOrEqual(size.height); expect(panel.overflow).toBe(false); }
      await page.getByRole('button', { name: 'Home', exact: true }).click({ trial: true });
      const failed = await page.evaluate(() => window.workflowCalls.filter(item => item.error || item.result?.isError));
      expect(failed).toEqual([]); expect(errors).toEqual([]);
      // Controls and resizing must never download or import unrelated models.
      expect([...modelRequests].sort()).toEqual(example.assets.map(asset => asset.url).sort());
      const importedModels = await page.evaluate(() => window.workflowCalls
        .filter(item => item.method === 'add' && /\.ifc$/i.test(item.argument)).map(item => item.argument));
      expect(importedModels).toEqual(example.assets.map(asset => asset.name));
      report.push({ id: example.id, width: viewport.width, result: 'passed' });
    } catch (error) {
      await page.screenshot({ path: `test-results/workflows/${example.id}-${viewport.width}-error.png` }).catch(() => {});
      console.error(await page.locator('body').innerText().catch(() => 'Page unavailable'));
      throw error;
    } finally { await context.close(); }
  }
} finally {
  writeFileSync('test-results/workflows/report.json', JSON.stringify(report, null, 2) + '\n');
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
console.log(`Passed ${report.length} isolated desktop/mobile workflows, all controls, rendered geometry and layouts.`);
