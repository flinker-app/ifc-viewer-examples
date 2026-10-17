import { after } from 'node:test';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';

const sdkUrl = JSON.parse(readFileSync(new URL('../viewer-sdk.config.json', import.meta.url), 'utf8')).url;
let browser;
let documentServer;
let specifications;
after(async () => {
  await browser?.close();
  if (documentServer) await new Promise(resolve => documentServer.close(resolve));
});

async function encode(value) {
  if (value instanceof Blob) return { __sdkTransfer: 'blob', bytes: [...new Uint8Array(await value.arrayBuffer())], type: value.type };
  if (value instanceof Uint8Array) return { __sdkTransfer: 'bytes', bytes: [...value] };
  if (value instanceof ArrayBuffer) return { __sdkTransfer: 'buffer', bytes: [...new Uint8Array(value)] };
  if (Array.isArray(value)) return Promise.all(value.map(encode));
  if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await encode(item)])));
  return value;
}
function decode(value) {
  if (value?.__sdkTransfer === 'blob') return new Blob([new Uint8Array(value.bytes)], { type: value.type });
  if (value?.__sdkTransfer === 'bytes') return new Uint8Array(value.bytes);
  if (value?.__sdkTransfer === 'buffer') return new Uint8Array(value.bytes).buffer;
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  return value;
}

// Exercise document operations from the actual published browser SDK, without a private checkout.
export async function loadPublishedSpecifications() {
  return specifications ??= (async () => {
    browser = await chromium.launch({ ...(process.platform === 'win32' ? { channel: 'chrome' } : {}), headless: true });
    // Browser crypto APIs used by the SDK require a secure context.
    documentServer = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Published SDK document tests</title><bim-grid id="ifc-viewer"></bim-grid>');
    });
    await new Promise(resolve => documentServer.listen(0, '127.0.0.1', resolve));
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${documentServer.address().port}/`);
    await page.evaluate(async url => {
      window.publishedSdk = await import(url);
      for (const name of ['bcf', 'ids']) for (const operation of ['load', 'save', 'validate']) {
        if (typeof window.publishedSdk[name]?.[operation] !== 'function') throw new Error('Published SDK lacks ' + name + '.' + operation);
      }
    }, sdkUrl);
    const call = async (namespace, operation, args) => decode(await page.evaluate(async ({ namespace, operation, args }) => {
      function decode(value) {
        if (value?.__sdkTransfer === 'blob') return new Blob([new Uint8Array(value.bytes)], { type: value.type });
        if (value?.__sdkTransfer === 'bytes') return new Uint8Array(value.bytes);
        if (value?.__sdkTransfer === 'buffer') return new Uint8Array(value.bytes).buffer;
        if (Array.isArray(value)) return value.map(decode);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
        return value;
      }
      async function encode(value) {
        if (value instanceof Blob) return { __sdkTransfer: 'blob', bytes: [...new Uint8Array(await value.arrayBuffer())], type: value.type };
        if (value instanceof Uint8Array) return { __sdkTransfer: 'bytes', bytes: [...value] };
        if (value instanceof ArrayBuffer) return { __sdkTransfer: 'buffer', bytes: [...new Uint8Array(value)] };
        if (Array.isArray(value)) return Promise.all(value.map(encode));
        if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await encode(item)])));
        return value;
      }
      return encode(await window.publishedSdk[namespace][operation](...decode(args)));
    }, { namespace, operation, args: await encode(args) }));
    return Object.fromEntries(['bcf', 'ids'].map(namespace => [namespace,
      Object.fromEntries(['load', 'save', 'validate'].map(operation => [operation, (...args) => call(namespace, operation, args)])),
    ]));
  })();
}
