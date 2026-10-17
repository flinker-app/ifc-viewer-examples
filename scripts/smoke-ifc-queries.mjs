import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import { mkdirSync } from 'node:fs';

if (process.argv.includes('--dev')) process.env.IFC_VIEWER_SDK_DIR ||= '../ifc-viewer/dist';
const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false } });
await server.listen();
const browser = await chromium.launch({ ...(process.platform === 'win32' ? { channel: 'chrome' } : {}), headless: true, args: ['--enable-unsafe-webgpu'] });
mkdirSync('test-results/ifc-queries', { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('examples/ifc-quantity-takeoff/index.html', server.resolvedUrls.local[0]).href);
  await page.waitForFunction(() => ['loaded', 'error'].includes(document.body.dataset.exampleState), undefined, { timeout: 240000 });
  expect(await page.locator('body').getAttribute('data-example-state')).toBe('loaded');
  await expect(page.locator('#spaces')).toBeEnabled();
  await expect(page.locator('.example-results').getByRole('columnheader')).toHaveText(['Name', 'Floor', 'Area']);
  await expect(page.locator('#space-list tr')).toHaveCount(269);
  await expect(page.locator('.example-results input')).toHaveCount(0);
  await expect(page.locator('.example-results button')).toHaveCount(269);
  const centralWaiting = page.locator('#space-list tr').filter({ hasText: '1AC1 · CENTRAL WAITING' });
  await expect(centralWaiting).toContainText('First Floor');
  await expect(centralWaiting).toContainText('139.8 m²');
  await centralWaiting.locator('td').nth(1).click();
  await expect(page.locator('#spaces')).toBeEnabled({ timeout: 60000 });
  await expect(centralWaiting).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#space-list tr[aria-selected=true]')).toHaveCount(1);
  const last = page.locator('#space-list tr').last();
  await last.getByRole('button').click();
  await expect(page.locator('#spaces')).toBeEnabled({ timeout: 60000 });
  await expect(last).toHaveAttribute('aria-selected', 'true');
  await expect(centralWaiting).toHaveAttribute('aria-selected', 'false');
  await page.locator('#space-list button').first().click();
  await expect(page.locator('#spaces')).toBeEnabled({ timeout: 60000 });
  for (const width of [1440, 390]) {
    const height = width === 390 ? 844 : 1000;
    await page.setViewportSize({ width, height });
    await expect(page.getByText(/^Processing view(?:\.{3}|…)?$/)).toBeHidden({ timeout: 60000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const panel = await page.locator('.example-results').boundingBox();
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(width);
    expect(panel.height).toBeLessThan(400);
    expect(await page.locator('.example-results').evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    expect(await page.locator('#example-viewer-mount').boundingBox()).toMatchObject({ width, height });
    await page.screenshot({ path: `test-results/ifc-queries/ifc-quantity-takeoff-${width}.png` });
  }
  await page.getByRole('button', { name: '1 element selected', exact: true }).click();
  await expect(page.getByRole('grid', { name: 'Properties', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  console.log('Space table: all 269 names, floors and areas, row selection, Properties and desktop/mobile layouts passed.');
} finally { await browser.close(); await server.close(); }
