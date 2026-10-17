import { chromium, expect } from '@playwright/test';
import sharp from 'sharp';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readExamples } from './example-metadata.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  sample: { type: 'string', multiple: true },
  missing: { type: 'boolean', default: false },
  fresh: { type: 'boolean', default: false },
  mobile: { type: 'boolean', default: false },
  timeout: { type: 'string', default: '300' },
  help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
  console.log(`Capture real sample pages as 640 × 360 WebP previews.

  npm run previews                         Refresh every example
  npm run previews -- --sample bcf          Refresh one example
  npm run previews -- --sample bcf,bcf-coloring      Refresh selected examples
  npm run previews -- --missing            Generate only missing previews
  npm run previews -- --fresh              Bypass persistent browser caches
  npm run previews -- --mobile             Also save desktop/mobile QA screenshots
  npm run previews -- --timeout 600        Allow 600 seconds per example

Examples and their titles are read from the standalone HTML pages. Images stay beside each index.html as
thumbnail.webp. Chrome's download cache is reused outside the repository.
Windows uses installed Chrome; other platforms use Playwright Chromium.
Internet access is required for the published SDK and source models.`);
  process.exit(0);
}

const timeout = Number(values.timeout) * 1000;
if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('--timeout must be a positive number of seconds');
const examples = readExamples(root).map(example => ({
  ...example, id: example.path.split('/')[1], output: join(root, dirname(example.path), 'thumbnail.webp'),
}));
const selected = values.sample?.flatMap(value => value.split(','));
for (const id of selected ?? []) {
  if (!examples.some(example => example.id === id)) throw new Error(`Unknown sample: ${id}. Choose from: ${examples.map(example => example.id).join(', ')}`);
}
const queue = examples.filter(example => (!selected || selected.includes(example.id)) && (!values.missing || !existsSync(example.output)));
if (!queue.length) {
  console.log('All selected examples already have previews.');
  process.exit(0);
}
const sdkUrl = JSON.parse(readFileSync(join(root, 'viewer-sdk.config.json'), 'utf8')).url;
const sdkResponse = await fetch(sdkUrl, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
if (!sdkResponse.ok) throw new Error(`Pinned SDK is unavailable (HTTP ${sdkResponse.status}): ${sdkUrl}. No previews were changed.`);

// Keep browser caches (including CDN code and source models) outside this repository.
// Sequential pages release GPU/model memory before opening the next large project.
const cache = join(tmpdir(), 'ifc-viewer-example-previews', createHash('sha256').update(root).digest('hex').slice(0, 12));
mkdirSync(cache, { recursive: true });
const diagnostics = join(root, 'test-results', 'previews');
mkdirSync(diagnostics, { recursive: true });
const disk = statfsSync(cache);
const fresh = values.fresh || disk.bavail * disk.bsize < 3 * 1024 ** 3;
let server, context;
const profile = mkdtempSync(join(cache, 'run-'));
const results = [];
try {
  // Serve the standalone HTML unchanged; no bundling, watcher or hot reload.
  const pages = new Map(examples.map(example => ['/' + example.path, join(root, example.path)]));
  server = createServer((request, response) => {
    const file = pages.get(new URL(request.url, 'http://localhost').pathname);
    if (!file) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(readFileSync(file));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const launchOptions = {
    ...(process.platform === 'win32' ? { channel: 'chrome' } : {}),
    headless: true,
    args: ['--enable-unsafe-webgpu', ...(!fresh ? [`--disk-cache-dir=${join(cache, 'http')}`, '--disk-cache-size=536870912'] : [])],
  };
  const contextOptions = {
    viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1,
    colorScheme: 'light', locale: 'en-US', reducedMotion: 'reduce',
  };
  // Point-cloud caches need disk-backed browser storage, including fresh captures.
  context = await chromium.launchPersistentContext(profile, { ...launchOptions, ...contextOptions });
  // A previous run's local viewer preferences should not change a capture.
  await context.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    const state = window.samplePreview = { pending: 0, errors: [], imported: [], changed: Date.now() };
    let instance;
    Object.defineProperty(window, 'exampleViewer', {
      configurable: true,
      get: () => instance,
      set(viewer) {
        instance = viewer;
        viewer.onViewChange(() => { state.changed = Date.now(); });
        // Observe only the public API so on-demand UI actions can finish before capture.
        for (const method of ['add', 'selectTopic', 'setMessage']) {
          const original = viewer[method];
          viewer[method] = async function (...args) {
            state.pending++;
            if (method === 'setMessage' && args[1]?.type === 'error') state.errors.push(String(args[0]));
            try {
              const result = await original.apply(this, args);
              if (result?.isError) state.errors.push(`${method} failed: ${args[0]}`);
              else if (method === 'add') state.imported.push(args[0]);
              return result;
            } catch (error) {
              state.errors.push(String(error));
              throw error;
            } finally { state.pending--; }
          };
        }
      },
    });
  });
  for (const unused of context.pages()) await unused.close();
  const storagePage = await context.newPage();
  const storage = await context.newCDPSession(storagePage);
  console.log(`Capturing ${queue.length} example(s). ${fresh ? 'Fresh browser storage (--fresh or less than 3 GB free).' : 'Browser cache: ' + cache}`);
  for (const [index, example] of queue.entries()) {
    console.log(`[${index + 1}/${queue.length}] ${example.id}`);
    const started = Date.now();
    const page = await context.newPage();
    const errors = [];
    const failedRequests = [];
    const consoleErrors = [];
    let rejectFatal;
    const fatal = new Promise((_, reject) => { rejectFatal = reject; });
    // Observe rejection immediately, including errors before the first readiness poll.
    void fatal.catch(() => {});
    page.on('pageerror', error => { errors.push(error.message); rejectFatal(error); });
    page.on('requestfailed', request => failedRequests.push(`${request.failure()?.errorText}: ${request.url()}`));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.setDefaultTimeout(Math.min(timeout, 60000));
    const remaining = () => Math.max(1, timeout - (Date.now() - started));
    const wait = predicate => Promise.race([page.waitForFunction(predicate, undefined, { timeout: remaining() }), fatal]);
    const settled = async () => {
      await wait(() => ['loaded', 'error'].includes(document.body.dataset.exampleState));
      await wait(() => window.samplePreview.pending === 0);
      const state = await page.evaluate(() => ({ state: document.body.dataset.exampleState, errors: window.samplePreview.errors }));
      if (state.state === 'error' || state.errors.length || errors.length) {
        throw new Error([...errors, ...state.errors, ...(state.state === 'error' ? ['Example reported a loading error'] : [])].join('\n'));
      }
      await wait(() => !document.querySelector('.example-ui fieldset:disabled'));
      await page.getByRole('progressbar', { name: 'Loading progress', exact: true }).waitFor({ state: 'hidden', timeout: remaining() });
      await wait(() => Date.now() - window.samplePreview.changed > 500);
    };
    try {
      const response = await page.goto(`${origin}/${example.path}`, { waitUntil: 'domcontentloaded', timeout: remaining() });
      if (!response?.ok()) throw new Error(`HTTP ${response?.status()} for ${example.path}`);
      await settled();
      if (example.id === 'account') {
        await page.locator('#message-type input[value="Info"]').check({ timeout: remaining() });
        await page.getByRole('button', { name: 'Display message', exact: true }).click();
      } else if (example.id === 'bcf') {
        await page.getByRole('button', { name: 'Topics', exact: true }).click({ timeout: remaining() });
        await page.getByRole('gridcell', { name: 'Component Selection', exact: true }).click();
      } else if (example.id === 'autzen') {
        await page.getByRole('button', { name: 'Measure', exact: true }).click();
        await page.getByRole('button', { name: 'Add measurement', exact: true }).click();
        await settled();
        await page.mouse.click(760, 360);
        await page.getByText(/Click end point/).waitFor({ state: 'visible', timeout: remaining() });
        await page.mouse.click(840, 400);
        await expect(page.getByRole('grid', { name: 'Measurements', exact: true })).toContainText(/\d+[.,]\d+ m/, { timeout: remaining() });
        await page.keyboard.press('Escape');
      } else if (['infra', 'infra_Road'].includes(example.id)) {
        await page.getByRole('button', { name: 'Sections', exact: true }).click();
        const alignment = page.getByRole('button', { name: /^Navigate along / }).first();
        const length = Number((await alignment.locator('..').innerText()).match(/[\d,.]+$/)[0].replaceAll(',', ''));
        await alignment.click();
        const station = page.getByRole('textbox', { name: 'Station / KP (m)', exact: true });
        await station.fill(String(Math.round(length / 2)));
        await station.press('Enter');
        const section = page.getByRole('row').filter({ hasText: 'Cross-section at station' }).getByRole('checkbox').last();
        await section.check();
        await expect(section).toBeChecked();
      } else if (example.id === 's1-ids') {
        await page.getByRole('button', { name: 'IDS', exact: true }).click();
        const run = page.getByRole('button', { name: 'Run All Checks', exact: true });
        await run.click();
        await expect(run).toBeEnabled({ timeout: remaining() });
        await page.getByRole('button', { name: 'Expand Walls · fire-rating information', exact: true }).click();
        await page.getByRole('button', { name: /^Apply BCF: IDS Fail/ }).first().click();
      } else if (example.id === 'selection') {
        await page.locator('#work-packages button[data-package]:not([data-package=""])').first().click({ timeout: remaining() });
      } else if (example.id === 's1-structure') {
        await page.getByRole('button', { name: 'Files', exact: true }).click();
        await page.getByRole('grid', { name: 'Models and files', exact: true }).getByRole('row')
          .filter({ hasText: 'BIM prefab facade' }).getByRole('checkbox').uncheck();
      } else if (example.id === 'sixty5') {
        await page.mouse.click(650, 330);
        await page.getByRole('button', { name: '1 element selected', exact: true }).click();
        await page.getByRole('button', { name: 'Collapse IFC Entity', exact: true }).click();
        await page.getByRole('button', { name: 'Expand Associations', exact: true }).click();
        await page.getByRole('button', { name: 'Expand Classifications & References', exact: true }).click();
        await page.getByRole('grid', { name: 'Properties', exact: true }).getByRole('row')
          .filter({ hasText: 'IFCCLASSIFICATIONREFERENCE' }).first().getByRole('button', { name: /^Expand / }).click();
      } else if (example.id === 'view-link') {
        await page.getByRole('button', { name: 'Create link', exact: true }).click();
        await page.locator('#copy-link').waitFor({ state: 'visible' });
        await wait(() => !document.getElementById('copy-link').disabled && !document.getElementById('open-link').hidden);
      } else if (example.id === 'view-table') {
        await page.mouse.click(650, 350);
        await expect(page.locator('#selection-count')).toHaveText('1 selected', { timeout: remaining() });
      }
      await settled();
      if (example.id === 'selection') {
        await page.mouse.move(650, 320);
        await page.mouse.wheel(0, -650);
      } else if (example.id === 's1-ids') {
        await page.mouse.move(800, 350);
        await page.mouse.wheel(0, 300);
      }
      // Project-switching previews must show the default project on its map.
      if (example.id === 'dispose') {
        const count = await page.evaluate(() => window.samplePreview.imported.filter(name => /\.ifc$/i.test(name)).length);
        if (!count) throw new Error('No models loaded; refusing to replace the preview with an empty viewer');
      }
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      // Rendering continues after the import promise resolves (camera transitions/tiles).
      await page.waitForTimeout(1500);
      await page.getByText(/^Processing view(?:\.{3}|…)?$/).waitFor({ state: 'hidden', timeout: remaining() });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await settled();
      // Blur the last control, then require two matching frames after the feature finishes.
      await page.locator(':focus').evaluateAll(elements => elements.forEach(element => element.blur()));
      let capture = await page.screenshot({ animations: 'disabled', timeout: remaining() });
      for (;;) {
        await page.waitForTimeout(500);
        const next = await page.screenshot({ animations: 'disabled', timeout: remaining() });
        if (next.equals(capture)) break;
        capture = next;
        if (remaining() === 1) throw new Error('The feature did not finish rendering before capture');
      }
      if (values.mobile) {
        writeFileSync(join(diagnostics, `${example.id}-desktop.png`), capture);
        await page.setViewportSize({ width: 390, height: 844 });
        // Keep the applied feature visible beside the compact task cue on mobile.
        for (const name of ['Files', 'Topics', 'IDS', 'Sections', 'Measure']) {
          const button = page.getByRole('button', { name, exact: true });
          if (await button.getAttribute('aria-expanded') === 'true') await button.click();
        }
        // Responsive presets may reapply their camera after a short debounce.
        await page.waitForTimeout(250);
        await settled();
        await page.waitForTimeout(1500);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.getByText(/^Processing view(?:\.{3}|…)?$/).waitFor({ state: 'hidden', timeout: remaining() });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth ||
          [...document.querySelectorAll('.example-ui')].some(panel => panel.scrollWidth > panel.clientWidth + 1));
        if (overflow) throw new Error('Mobile page or host panel overflows horizontally');
        await page.screenshot({ path: join(diagnostics, `${example.id}-mobile.png`), animations: 'disabled', timeout: remaining() });
      }
      const image = await sharp(capture).resize(640, 360).webp({ quality: 82 }).toBuffer();
      const temporary = example.output + '.tmp';
      writeFileSync(temporary, image);
      renameSync(temporary, example.output);
      const seconds = Math.round((Date.now() - started) / 1000);
      results.push({ id: example.id, status: 'ok', seconds });
      console.log(`  Saved ${dirname(example.path)}/thumbnail.webp (${Math.round(image.length / 1024)} KB, ${seconds}s)`);
    } catch (error) {
      const message = [error instanceof Error ? error.message : String(error), ...consoleErrors.slice(-3), ...failedRequests.slice(-3)].join('\n');
      results.push({ id: example.id, status: 'error', error: message });
      console.error(`  FAILED: ${message}`);
      await page.screenshot({ path: join(diagnostics, `${example.id}-error.png`), timeout: 5000 }).catch(() => {});
    } finally {
      await page.close();
      // Remove SDK model/point-cloud data after releasing its workers and file handles.
      // Chromium's HTTP download cache is separate and remains available to later runs.
      await storage.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    }
  }
} finally {
  await context?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (profile) {
    if (dirname(profile) !== cache) throw new Error('Preview browser profile escaped its temporary directory');
    rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
writeFileSync(join(diagnostics, 'report.json'), JSON.stringify(results, null, 2) + '\n');
const failed = results.filter(result => result.status === 'error');
console.log(`Saved ${results.length - failed.length}/${queue.length} previews. Report: test-results/previews/report.json`);
if (failed.length) {
  console.error(`Previous previews were preserved for failed captures. Retry: npm run previews -- --sample ${failed.map(result => result.id).join(',')}`);
  process.exitCode = 1;
}
