import { chromium, expect } from '@playwright/test';
import { preview, createServer as createDevServer } from 'vite';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, cpSync, rmSync, createReadStream, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { readExamples } from './example-metadata.mjs';
import sharp from 'sharp';
import { readNativeEntities } from './native-ifc-probe.mjs';

const requestedCases = process.env.IFC_VIEWER_TEST_CASES?.split(',').map(value => value.split('?')[0]);
const examples = readExamples().filter(example => !requestedCases || requestedCases.includes(example.id));
const sdkUrl = JSON.parse(readFileSync('viewer-sdk.config.json', 'utf8')).url;
const contract = JSON.parse(readFileSync('api-contract.json', 'utf8'));
const bcfSamples = JSON.parse(/const sampleFiles = (\[[\s\S]*?\]);/.exec(readFileSync('examples/bcf/index.html', 'utf8'))[1]);
const modelDirectory = process.env.IFC_VIEWER_TEST_MODELS_DIR;
const modelFiles = modelDirectory ? Object.fromEntries(readdirSync(modelDirectory).filter(name => name.endsWith('.ifc')).map(name => [name, resolve(modelDirectory, name)])) : {};
const fixturePlugin = {
  name: 'browser-sample-files',
  configurePreviewServer(server) {
    server.middlewares.use((request, response, next) => {
      if (!request.url.startsWith('/__model-fixtures/')) return next();
      const filename = decodeURIComponent(new URL(request.url, 'http://localhost').pathname.slice('/__model-fixtures/'.length));
      const file = Object.hasOwn(modelFiles, filename) ? modelFiles[filename] : undefined;
      if (!file) { response.writeHead(404); response.end(); return; }
      const size = statSync(file).size;
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) { response.writeHead(416, { 'Content-Range': 'bytes */' + size }); response.end(); return; }
      response.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
      if (request.method === 'HEAD') response.end();
      else createReadStream(file, { start, end }).pipe(response);
    });
  },
};
const development = process.argv.includes('--dev');
if (development) process.env.IFC_VIEWER_SDK_DIR ||= '../ifc-viewer/dist';
const server = development
  ? await createDevServer({ plugins: [fixturePlugin], server: { host: '127.0.0.1', port: 0, open: false } })
  : await preview({ plugins: [fixturePlugin], preview: { host: '127.0.0.1', port: 0, strictPort: false } });
if (development) await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}`;
const sdkSource = development ? url + '/__viewer_sdk__/ifc-viewer.es.js' : sdkUrl;
const useChrome = process.platform === 'win32';
const browser = await chromium.launch({ ...(useChrome ? { channel: 'chrome' } : {}), headless: true, args: ['--enable-unsafe-webgpu'] });
try {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  mkdirSync('test-results', { recursive: true });
  for (const example of examples) {
    const response = await page.goto(`${url}/${example.path}`);
    expect(response.status()).toBe(200);
    await expect(page).toHaveTitle(example.title);
    // All task controls and credits float over the full-page SDK-owned viewer.
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const layout = await page.evaluate(() => {
        const bounds = element => {
          const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
          return { x, y, width, height, right, bottom };
        };
        return {
          viewer: bounds(document.getElementById('ifc-viewer')),
          corners: [...document.querySelectorAll('.example-ui')].map(bounds),
          hasResults: Boolean(document.querySelector('.example-results')),
          pageWidth: document.documentElement.scrollWidth,
        };
      });
      expect(layout.viewer, example.path).toMatchObject({ x: 0, y: 0, width: viewport.width,
        height: viewport.height });
      expect(layout.pageWidth, example.path).toBeLessThanOrEqual(viewport.width);
      for (const corner of layout.corners.filter(corner => corner.height > 0)) {
        expect(corner.x, example.path).toBeGreaterThanOrEqual(0);
        expect(corner.y, example.path).toBeGreaterThanOrEqual(0);
        expect(corner.right, example.path).toBeLessThanOrEqual(viewport.width);
        expect(corner.bottom, example.path).toBeLessThanOrEqual(viewport.height);
      }
      if (layout.hasResults) expect(await page.locator('.example-results').evaluate(element => element.scrollHeight <= element.clientHeight + 1), example.path + ' results pane fits').toBe(true);
    }
    const missing = await page.locator('a[href],img[src],link[rel="stylesheet"]').evaluateAll(elements => elements.map(element => element.href || element.src).filter(value => value.startsWith(location.origin)));
    for (const reference of missing) {
      const path = new URL(reference).pathname;
      const result = await context.request.get(reference);
      expect(result.status(), `${example.path}: ${path}`).toBe(200);
    }
    const thumbnail = await context.request.get(url + example.thumbnail);
    expect(thumbnail.status(), example.thumbnail).toBe(200);
    const dimensions = await sharp(await thumbnail.body()).metadata();
    expect(dimensions, example.thumbnail).toMatchObject({ width: 640, height: 360 });
    await expect(page.locator('.example-ui :is(details, summary)')).toHaveCount(0);
    await expect(page.locator('.example-ui select')).toHaveCount(0);
    for (const panel of await page.locator('.example-ui').all()) {
      expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), example.path).toBe(true);
    }
    if (await page.locator('#project-info').count()) {
      await expect(page.locator('#project-info > h2')).toBeVisible();
    }
  }
  await context.close();
  console.log(`Verified ${examples.length} ${development ? 'development' : 'production'} pages, local links, stylesheets, previews and desktop/mobile layouts.`);

  // Static layouts cannot prove that the pinned CDN matches the example API.
  // Probe a minimal host before downloading any of the large sample datasets.
  const sdkContext = await browser.newContext();
  try {
    const probeUrl = url + '/__sdk-contract-check';
    await sdkContext.route(probeUrl, route => route.fulfill({ contentType: 'text/html',
      body: '<!doctype html><title>Published SDK contract</title><bim-grid id="ifc-viewer"></bim-grid>' }));
    const page = await sdkContext.newPage();
    await page.goto(probeUrl);
    await page.evaluate(async ({ contract, sdkSource }) => {
      const sdk = await import(sdkSource);
      const missing = contract.moduleExports.filter(name => !(name in sdk));
      if (missing.length) throw new Error(`Pinned SDK ${sdkSource} is missing required exports: ${missing.join(', ')}. Available exports: ${Object.keys(sdk).join(', ')}`);
      const viewer = new sdk.Viewer('#ifc-viewer');
      await Promise.race([viewer.ready, new Promise((_, reject) =>
        setTimeout(() => reject(new Error('SDK initialization timed out')), 120000))]);
      for (const method of contract.instanceMethods) {
        if (typeof viewer[method] !== 'function') throw new Error('Pinned SDK is missing instance method: ' + method);
      }
      for (const property of contract.instanceProperties) {
        if (viewer[property] === undefined) throw new Error('Pinned SDK is missing instance property: ' + property);
      }
      for (const [namespace, operations] of Object.entries(contract.documentNamespaces)) {
        for (const operation of operations) {
          const expectedType = /^v\d+_/.test(operation) ? 'object' : 'function';
          if (typeof sdk[namespace]?.[operation] !== expectedType) throw new Error('Pinned SDK is missing document API: ' + namespace + '.' + operation);
        }
      }
    }, { contract, sdkSource });
    console.log(`Verified ${development ? 'local' : 'published'} SDK exports, viewer initialization and public API contract.`);
  } finally { await sdkContext.close(); }

  if (process.argv.includes('--isolated')) {
    const isolatedRoot = mkdtempSync(join(tmpdir(), 'ifc-standalone-'));
    const zip = process.env.IFC_VIEWER_TEST_ZIP_FILE;
    let activeFolder;
    const isolatedServer = createServer((request, response) => {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path === '/' || path === '/index.html') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        const html = readFileSync(join(activeFolder, 'index.html'), 'utf8');
        response.end(development ? html.replaceAll(sdkUrl, sdkSource) : html);
      } else { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => isolatedServer.listen(0, '127.0.0.1', resolve));
    const isolatedUrl = `http://127.0.0.1:${isolatedServer.address().port}`;
    const isolated = await browser.newContext();
    if (development) await isolated.route(url + '/__viewer_sdk__/**', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
    });
    if (zip && existsSync(zip)) await isolated.route('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm', route => route.fulfill({ path: zip, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' } }));
    // Initialization checks do not download the large public project datasets.
    await isolated.route(source => source.origin !== isolatedUrl
      && /\.(?:ifc|ifczip|laz|las|zip|bcf|bcfzip)$/i.test(source.pathname), route => route.abort());
    try {
      for (const example of examples) {
        activeFolder = join(isolatedRoot, dirname(example.path).split('/').pop());
        cpSync(dirname(resolve(example.path)), activeFolder, { recursive: true });
        expect(readFileSync(resolve('dist', example.path)).equals(readFileSync(example.path)), example.path + ' is copied without bundling').toBe(true);
        const page = await isolated.newPage();
        const localDependencies = [];
        const errors = [];
        let rejectInitialization;
        const initializationError = new Promise((_, reject) => { rejectInitialization = reject; });
        void initializationError.catch(() => {});
        page.on('pageerror', error => { errors.push(error.message); rejectInitialization(error); });
        page.on('request', request => {
          const url = new URL(request.url());
          if (url.origin === isolatedUrl && !['/', '/index.html', '/favicon.ico'].includes(url.pathname)) localDependencies.push(url.pathname);
        });
        await Promise.race([(async () => {
          await page.goto(`${isolatedUrl}/index.html`);
          await expect.poll(() => page.evaluate(() => Boolean(window.exampleViewer)), { timeout: 120000 }).toBe(true);
          await page.evaluate(() => Promise.race([window.exampleViewer.ready, new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Standalone SDK initialization timed out')), 120000))]));
        })(), initializationError]);
        expect(localDependencies, example.path).toEqual([]);
        expect(errors, example.path).toEqual([]);
        await page.close();
        console.log(`Verified isolated SDK initialization: ${example.path}`);
      }
    } finally {
      await isolated.close();
      await new Promise(resolve => isolatedServer.close(resolve));
      // Only remove the verified temporary directory created by this check.
      if (dirname(isolatedRoot) !== tmpdir() || !isolatedRoot.startsWith(join(tmpdir(), 'ifc-standalone-'))) throw new Error('Unexpected isolation directory');
      rmSync(isolatedRoot, { recursive: true });
    }
  }

  if (process.argv.includes('--live')) {
    // Point-cloud indexing uses disk storage that private browser contexts limit.
    const liveProfile = mkdtempSync(join(tmpdir(), 'ifc-example-live-'));
    const live = await chromium.launchPersistentContext(liveProfile, {
      ...(useChrome ? { channel: 'chrome' } : {}), headless: true, args: ['--enable-unsafe-webgpu'],
    });
    if (modelDirectory) {
      // Stream large samples from this origin; DevTools route.fulfill has a 100 MB message limit.
      await live.addInitScript(({ files, origin }) => {
        const fetchOriginal = window.fetch.bind(window);
        window.fetch = (input, options) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (/https:\/\/(?:raw|media)\.githubusercontent\.com\/.*\.ifc(?:\?.*)?$/.test(url)) {
            const source = decodeURIComponent(new URL(url).pathname.split('/').pop());
            const name = source;
            if (files.includes(name)) return fetchOriginal(origin + '/' + encodeURIComponent(name), options);
          }
          return fetchOriginal(input, options);
        };
      }, { files: Object.keys(modelFiles), origin: url + '/__model-fixtures' });
    }
    const cases = process.env.IFC_VIEWER_TEST_CASES?.split(',') ?? [
      'bcf', 'bcf-annotations', 'bcf-coloring', 'bcf-visibility', 'bcf-clipping', 'selection',
    ];
    try {
      for (const caseName of cases) {
        console.log(`Checking live SDK workflow: ${caseName}`);
        const [name, search = ''] = caseName.split('?');
        const pageUrl = `${url}/examples/${name}/index.html${search ? '?' + search : ''}`;
        const screenshotName = caseName.replace(/[^a-z0-9-]+/gi, '-');
        const page = await live.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        // Observe calls across the public boundary; do not inspect viewer internals.
        await page.route(pageUrl, async route => {
          const response = await route.fetch();
          const original = await response.text();
          const instrumentation = `<script>
            window.exampleCalls = [];
            let instance;
            Object.defineProperty(window, 'exampleViewer', {
              configurable: true, get: () => instance,
              set(viewer) {
                instance = viewer;
                for (const method of ['add', 'selectTopic', 'clear', 'toggleMap']) {
                  const original = viewer[method];
                  viewer[method] = async function (...args) {
                    const call = { method, argument: args[0] };
                    window.exampleCalls.push(call);
                    try { call.result = await original.apply(this, args); call.complete = true; return call.result; }
                    catch (error) { call.error = String(error); throw error; }
                  };
                }
              },
            });
          </script>`;
          await route.fulfill({ response, body: original.replace('</head>', instrumentation + '</head>') });
        });
        await page.goto(pageUrl);
        await expect.poll(async () => ['loaded', 'error'].includes(await page.locator('body').getAttribute('data-example-state')), { timeout: 180000 }).toBe(true);
        expect(await page.locator('body').getAttribute('data-example-state'), await page.locator('body').innerText()).toBe('loaded');
        await page.evaluate(async ({ contract, sdkSource }) => {
          const viewer = window.exampleViewer;
          await viewer.ready;
          for (const method of contract.instanceMethods) {
            if (typeof viewer[method] !== 'function') throw new Error('Missing instance method: ' + method);
          }
          for (const property of contract.instanceProperties) {
            if (viewer[property] === undefined) throw new Error('Missing instance property: ' + property);
          }
          const sdk = await import(sdkSource);
          for (const [namespace, operations] of Object.entries(contract.documentNamespaces)) {
            for (const operation of operations) {
              const expectedType = /^v\d+_/.test(operation) ? 'object' : 'function';
              if (typeof sdk[namespace]?.[operation] !== expectedType) throw new Error('Missing document API: ' + namespace + '.' + operation);
            }
          }
        }, { contract, sdkSource });
        const selected = () => page.evaluate(() => window.exampleCalls.filter(call => call.method === 'selectTopic' && call.complete).length);
        const waitForView = async () => {
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          await expect(page.getByText(/^Processing view(?:\.{3}|…)?$/)).toBeHidden({ timeout: 60000 });
        };
        await waitForView();
        // Host controls must leave the SDK's own camera controls usable.
        await page.getByRole('button', { name: 'Home', exact: true }).click({ trial: true });
        if (name === 'building-scan') {
          expect(await page.evaluate(() => window.exampleCalls.filter(call => call.method === 'add' && call.complete)
            .map(call => call.argument))).toEqual(['example-no-1.ifc', 'example-no-1.laz']);
        }
        if (name === 'account') {
          await page.locator('#message-type input[value="Warning"]').check();
          await expect(page.locator('#host-controls')).toBeEnabled();
          await expect(page.locator('#message-type input:checked')).toHaveCount(1);
          await expect(page.locator('#message-text')).toHaveValue('Please review the highlighted item.');
          await expect(page.getByText('Please review the highlighted item.', { exact: true })).toBeVisible();
          await page.locator('#message-type input[value="Hidden"]').check();
          await expect(page.getByText('Please review the highlighted item.', { exact: true })).toBeHidden();
          await page.locator('#message-type input[value="Info"]').check();
        }
        if (name === 'dispose') {
          const configuration = await page.locator('#example-data').textContent().then(JSON.parse);
          await page.evaluate(() => { window.originalExampleViewer = window.exampleViewer; });
          const project = async id => {
            const entry = configuration.projects.find(project => project.id === id);
            const asset = configuration.assets.find(asset => asset.id === entry.assetId);
            await expect(page.locator('#model-state')).toHaveText(entry.label + ' · Map enabled', { timeout: 180000 });
            await expect(page.locator('#model-controls')).toBeEnabled();
            await expect(page.locator(`[data-project="${id}"]`)).toHaveAttribute('aria-pressed', 'true');
            await expect(page.locator('[data-project][aria-pressed="true"]')).toHaveCount(1);
            expect(await page.evaluate(() => window.exampleViewer === window.originalExampleViewer)).toBe(true);
            const calls = await page.evaluate(() => window.exampleCalls.slice(-3));
            expect(calls.map(call => call.method)).toEqual(['clear', 'add', 'toggleMap']);
            expect(calls[1].argument).toBe(asset.name);
            expect(calls.every(call => call.complete && !call.error && !call.result?.isError)).toBe(true);
            expect(calls.at(-1)).toMatchObject({ argument: true, result: true });
            await waitForView();
            // Map tiles arrive after the model and camera transition complete.
            await page.waitForTimeout(2000);
            await page.screenshot({ path: `test-results/dispose-${id}-${page.viewportSize().width}.png` });
          };
          await project('zurich');
          await page.locator('[data-project="rotterdam"]').click();
          await project('rotterdam');
          await page.setViewportSize({ width: 390, height: 844 });
          await project('rotterdam');
          await page.locator('[data-project="zurich"]').click();
          await project('zurich');
          const bridge = configuration.assets.find(asset => asset.id === configuration.projects[1].assetId);
          await page.route(bridge.url, route => route.fulfill({ status: 503, body: 'Temporary sample outage' }));
          await page.locator('[data-project="rotterdam"]').click();
          await expect(page.locator('body')).toHaveAttribute('data-example-state', 'error', { timeout: 30000 });
          await expect(page.locator('#model-controls')).toBeEnabled();
          await expect(page.locator('#model-state')).toHaveText('Choose a project to retry.');
          expect(await page.evaluate(() => window.exampleCalls.at(-1))).toMatchObject({ method: 'clear', complete: true });
          await page.unroute(bridge.url);
          await page.locator('[data-project="rotterdam"]').click();
          await project('rotterdam');
        }
        if (name === 'selection') {
          await expect.poll(selected, { timeout: 60000 }).toBe(1);
          const buttons=page.locator('#work-packages button[data-package]:not([data-package=""])');
          expect(await buttons.count()).toBeGreaterThan(0);
          for(let i=0;i<Math.min(2,await buttons.count());i++) {
            const count=await selected(),button=buttons.nth(i);
            const wallCount=Number((await button.innerText()).match(/· (\d+) walls$/)[1]);
            await button.click(); await expect.poll(selected,{timeout:60000}).toBe(count+1);
            await expect(page.locator('#activity-count')).toHaveText(wallCount+' walls selected');
          }
          const count=await selected();
          await page.locator('[data-package=""]').click();
          await expect.poll(selected,{timeout:60000}).toBe(count+1);
          await expect(page.locator('#activity-count')).toHaveText('Selection cleared');
        }
        if (['bcf', 'bcf-coloring', 'bcf-visibility', 'bcf-clipping', 'bcf-2d', 'floorplans'].includes(name)) {
          const archives = await page.evaluate(() => window.exampleCalls
            .filter(call => call.method === 'add' && /\.(bcf|bcfzip)$/i.test(call.argument) && call.complete).map(call => call.argument));
          if (name === 'bcf') {
            expect(archives).toEqual(bcfSamples.map(file => file.name));
            expect(await page.evaluate(() => window.exampleCalls
              .filter(call => call.method === 'add' && /\.ifc$/i.test(call.argument)).map(call => call.argument)))
              .toEqual(['Architectural.ifc', 'MEP.ifc']);
            await page.getByRole('button', { name: 'Topics', exact: true }).click();
            const topics = page.getByRole('grid', { name: 'BCF topics', exact: true });
            await expect(topics.getByRole('gridcell', { name: 'Document Reference External', exact: true })).toBeVisible();
            await topics.getByRole('gridcell', { name: 'Component Selection', exact: true }).click();
            await expect(page.getByRole('grid', { name: 'Selected BCF topic', exact: true })
              .getByRole('button', { name: 'Component Selection', exact: true })).toBeVisible();
          } else expect(archives).toHaveLength(1);
          expect(await selected()).toBe(name === 'bcf' ? 0 : 1);
          if (await page.locator('#preset-choice').count()) {
            await page.locator('#preset-choice input:not(:checked)').first().check();
            await expect(page.locator('#preset-choice')).toBeEnabled({ timeout: 120000 });
            await expect.poll(selected, { timeout: 120000 }).toBe(2);
            await expect(page.locator('#preset-choice input:checked')).toHaveCount(1);
          }
          if (name === 'floorplans') {
            const plans = page.locator('#view-choices button');
            const expectedStoreys = (await readNativeEntities(page, 'IFCBUILDINGSTOREY')).total;
            await expect(plans).toHaveCount(expectedStoreys);
            for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
              const imports = await page.evaluate(() => window.exampleCalls.filter(call => call.method === 'add' && /\.bcf$/i.test(call.argument) && call.complete).length);
              await page.setViewportSize(viewport);
              await expect.poll(() => page.evaluate(() => window.exampleCalls.filter(call => call.method === 'add' && /\.bcf$/i.test(call.argument) && call.complete).length), { timeout: 60000 }).toBe(imports + 1);
              await expect(page.locator('body')).toHaveAttribute('data-example-state', 'loaded', { timeout: 60000 });
              for (const id of (await plans.evaluateAll(buttons=>buttons.map(button=>button.dataset.view))).slice(0,3)) {
                const count = await selected();
                const button = page.locator('#view-choices button[data-view="' + id + '"]');
                await button.click();
                await expect(page.locator('#view-choices')).toBeEnabled({ timeout: 60000 });
                await expect.poll(selected, { timeout: 60000 }).toBe(count + 1);
                await expect(page.locator('#view-choices button[aria-pressed=true]')).toHaveCount(1);
                await expect(button).toHaveAttribute('aria-pressed', 'true');
                await waitForView();
                mkdirSync('test-results/bcf', { recursive: true });
                await page.screenshot({ path: `test-results/bcf/floorplans-${id}-${viewport.width}.png` });
              }
            }
            await page.locator('#view-choices button').first().click();
            await expect(page.locator('#view-choices')).toBeEnabled({ timeout: 60000 });
            expect(await page.evaluate(() => window.exampleCalls.filter(call => call.method === 'add' && /\.ifc$/i.test(call.argument)).length)).toBe(1);
          } else if (await page.locator('#view-choices').count()) {
            await page.locator('#view-choices button').nth(1).click();
            await expect(page.locator('#view-choices')).toBeEnabled({ timeout: 60000 });
            await expect(page.locator('#view-choices button').nth(1)).toHaveAttribute('aria-pressed', 'true');
          }
        }
        if (name === 'bcf-annotations') {
          expect(await page.evaluate(() => window.exampleCalls.filter(call => call.method === 'add' && call.complete)
            .map(call => call.argument))).toEqual(['AdvancedProject.ifc', 'stair-opening-review.bcf']);
          await page.evaluate(() => {
            window.exampleViewer.onViewChange(view => { window.exampleAnnotationView = view; });
          });
          await page.getByRole('button', { name: 'Home', exact: true }).click();
          await page.getByRole('button', { name: 'Restore annotated view', exact: true }).click();
          await expect(page.locator('#restore-view')).toBeEnabled({ timeout: 60000 });
          await expect.poll(() => page.evaluate(() => window.exampleAnnotationView?.root.content
            .find(node => node.name === 'Lines')?.content.length), { timeout: 60000 }).toBe(427);
          expect(await selected()).toBe(2);
          expect(await page.evaluate(() => window.exampleCalls.filter(call => call.method === 'add' && call.complete).length)).toBe(2);
          await page.getByRole('button', { name: 'Topics', exact: true }).click();
          await expect(page.getByRole('grid', { name: 'BCF topics', exact: true })
            .getByRole('gridcell', { name: 'Review stair opening protection', exact: true })).toBeVisible();
          await page.getByRole('button', { name: 'Topics', exact: true }).click();
        }
        if (name === 'rotterdam-bridge') {
          await expect(page.locator('.example-ui button:not([hidden])')).toHaveCount(0);
        }
        if (name === 'view-link') {
          await page.getByRole('button', { name: 'Home', exact: true }).click();
          await page.getByRole('button', { name: 'Create link', exact: true }).click();
          await expect(page.locator('#copy-link')).toBeEnabled({ timeout: 60000 });
          await expect(page.locator('#view-link')).toHaveValue(/#bcf=[A-Za-z0-9_-]+$/);
          // The link and download contain the same standard BCF archive.
          await expect.poll(() => page.locator('#open-link').evaluate(link => !link.hidden
            && link.href === document.getElementById('view-link').value)).toBe(true);
          // Reload the emitted URL to exercise restoration from the published
          // BCF archive, including its import and topic selection.
          await page.reload();
          await expect(page.locator('body')).toHaveAttribute('data-example-state', 'loaded', { timeout: 180000 });
          await expect.poll(selected, { timeout: 60000 }).toBe(1);
          await expect(page.locator('#copy-link')).toBeEnabled({ timeout: 60000 });
          await expect(page.locator('#download-bcf')).toBeVisible();
        }
        if (name === 'view-table') {
          // Apply a real public BCF selection and verify the host joins its GlobalIds.
          // This exercises the same view event as picking components in the SDK UI.
          await page.evaluate(() => {
            window.exampleViewEvents = 0;
            window.stopExampleView = window.exampleViewer.onViewChange(view => {
              window.exampleViewEvents++;
              window.exampleCurrentView = view;
            });
          });
          await page.getByRole('button', { name: 'Home', exact: true }).click();
          await expect.poll(() => page.evaluate(() => Boolean(window.exampleCurrentView)), { timeout: 60000 }).toBe(true);
          const selectedGuids = (await readNativeEntities(page, 'IFCFLOWSEGMENT', 2)).rows.map(line => line.GlobalId.value);
          await page.evaluate(async ({ sdkUrl, guids }) => {
            const { bcf } = await import(sdkUrl);
            const viewer = window.exampleViewer;
            const element = (name, content = [], attributes = {}) => ({ name, namespaceURI: '', attributes, content });
            const text = (name, value) => element(name, [value]);
            const documentEntry = (schema, root) => ({ document: { kind: 'xml', schema: 'bcf-3.0/' + schema, root } });
            const topicId = crypto.randomUUID(), viewId = crypto.randomUUID();
            const view = structuredClone(window.exampleCurrentView);
            window.stopExampleView();
            window.detachedViewEvents = window.exampleViewEvents;
            const validation = await bcf.validate(view);
            if (!validation.valid) throw new Error('onViewChange returned an invalid BCF view');
            view.root.attributes.Guid = viewId;
            const components = view.root.content.find(node => node.name === 'Components');
            components.content = [
              element('Selection', guids.map(IfcGuid => element('Component', [], { IfcGuid }))),
              element('Visibility', [], { DefaultVisibility: 'true' }),
            ];
            const project = { kind: 'archive', specification: 'bcf-3.0', entries: {
              'bcf.version': documentEntry('version', element('Version', [], { VersionId: '3.0' })),
              'extensions.xml': documentEntry('extensions', element('Extensions')),
              [topicId + '/markup.bcf']: documentEntry('markup', element('Markup', [element('Topic', [
                text('Title', 'Selected components'), text('CreationDate', new Date().toISOString()), text('CreationAuthor', 'examples@example.com'),
                element('Viewpoints', [element('ViewPoint', [text('Viewpoint', viewId + '.bcfv')], { Guid: viewId })]),
              ], { Guid: topicId, TopicType: 'Coordination', TopicStatus: 'Open' })])),
              [topicId + '/' + viewId + '.bcfv']: { document: view },
            } };
            await viewer.add('selected-components.bcf', await bcf.save(project));
            await viewer.selectTopic(topicId);
          }, { sdkUrl: sdkSource, guids: selectedGuids });
          await expect(page.locator('#selection-count')).toHaveText('2 selected', { timeout: 60000 });
          await expect(page.locator('#element-rows tr[data-ifc-guid]')).toHaveCount(2);
          expect(await page.evaluate(() => window.exampleViewEvents)).toBe(await page.evaluate(() => window.detachedViewEvents));
          await expect(page.getByText('Download BCF', { exact: true })).toBeHidden();
        }
        expect(errors, name).toEqual([]);
        expect(await page.evaluate(() => window.exampleCalls.filter(call => call.error || call.result?.isError)
          .map(call => ({ method: call.method, error: call.error, result: call.result }))), name).toEqual([]);
        mkdirSync('test-results/bcf', { recursive: true });
        for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
          await page.setViewportSize(viewport);
          if (name === 'floorplans') {
            await page.waitForTimeout(250);
            await expect(page.locator('body')).toHaveAttribute('data-example-state', 'loaded', { timeout: 60000 });
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth), name).toBeLessThanOrEqual(viewport.width);
          await waitForView();
          await page.screenshot({ path: `test-results/bcf/${screenshotName}-${viewport.width}.png` });
        }
        console.log(`Verified public instance workflow and desktop/mobile layout: ${caseName}`);
        await page.close();
      }
    } finally {
      await live.close();
      if (dirname(liveProfile) !== tmpdir() || !liveProfile.startsWith(join(tmpdir(), 'ifc-example-live-'))) throw new Error('Unexpected live browser profile');
      rmSync(liveProfile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }

} finally {
  await browser.close();
  if (development) await server.close();
  else await new Promise(resolve => server.httpServer.close(resolve));
}
