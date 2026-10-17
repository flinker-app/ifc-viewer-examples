import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { loadExampleFile } from '../scripts/example-download.mjs';

const pattern = /async function loadExampleFile[^\n]+\{\r?\n[\s\S]*?\r?\n\}/;
const helper = loadExampleFile.toString();
const name = 'clinic.ifc', url = 'https://samples.example.com/clinic.ifc';
const file = new Blob(['IFC sample']), chunkSize = 4 * 1024 * 1024;
const firstChunk = new Blob([new Uint8Array(chunkSize).fill(65)]), lastChunk = new Blob(['BCD']);
const complete = new Blob([firstChunk, lastChunk]);
const response = (blob = file, status = 200, headers = {}) => new Response(blob, { status, headers });

function loader(fetch, add = async () => {}) {
  const opened = [], delays = [];
  const viewer = {
    setMessage: async () => {},
    add: async (...args) => { opened.push(args); return add(...args); },
  };
  const timer = (callback, delay) => { delays.push(delay); callback(); };
  return { opened, delays, load: new Function('viewer', 'fetch', 'setTimeout', helper + '\nreturn loadExampleFile;')(viewer, fetch, timer) };
}

test('every standalone downloader stays synchronized with the maintenance source', () => {
  let count = 0;
  for (const entry of readdirSync(new URL('../examples/', import.meta.url), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const code = readFileSync(new URL(`../examples/${entry.name}/index.html`, import.meta.url), 'utf8').match(pattern)?.[0];
    if (code) { assert.equal(code.replaceAll('\r\n', '\n'), loadExampleFile.toString(), entry.name); count++; }
  }
  assert.ok(count > 0);
});

for (const failure of ['request', 'body', 'timeout']) {
  test(`retries an interrupted ${failure} before importing any bytes`, async () => {
    const requests = [];
    const { load, opened, delays } = loader(async (source, options) => {
      requests.push({ source, options });
      if (requests.length === 1) {
        if (failure === 'request') throw new TypeError('Failed to fetch');
        if (failure === 'timeout') throw new DOMException('Timed out', 'TimeoutError');
        return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => { throw new TypeError('Failed to fetch'); } };
      }
      return response();
    });
    await load(name, url);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(r => r.source === url && r.options.cache === 'no-store' && r.options.signal instanceof AbortSignal));
    assert.deepEqual(delays, [500]);
    assert.equal(await opened[0][1].text(), await file.text());
  });
}

test('persistent failures stop after three attempts and identify the source', async () => {
  let requests = 0;
  const { load, opened, delays } = loader(async () => { requests++; throw new TypeError('Failed to fetch'); });
  await assert.rejects(load(name, url), e => e.message.includes(url) && e.message.includes('Could not download ' + name) && e.cause instanceof TypeError);
  assert.equal(requests, 3);
  assert.deepEqual(delays, [500, 1000]);
  assert.deepEqual(opened, []);
});

for (const status of [408, 429, 503, 404]) {
  test(`HTTP ${status} ${status === 404 ? 'fails immediately' : 'recovers after retry'}`, async () => {
    let requests = 0;
    const { load, opened } = loader(async () => ++requests === 1 ? response('error', status) : response());
    if (status === 404) await assert.rejects(load(name, url), /HTTP 404/);
    else await load(name, url);
    assert.equal(requests, status === 404 ? 1 : 2);
    assert.equal(opened.length, status === 404 ? 0 : 1);
  });
}

for (const host of ['raw.githubusercontent.com', 'media.githubusercontent.com']) {
  for (const failure of ['interrupted body', 'short response']) {
    test(`${host} retries a ${failure} without repeating completed ranges or using HEAD`, async () => {
      const requests = [];
      let attempts = 0;
      const { load, opened } = loader(async (_url, options) => {
        assert.equal(options.method, undefined);
        const range = new Headers(options.headers).get('Range'); requests.push(range);
        assert.equal(opened.length, 0);
        if (range === `bytes=0-${chunkSize - 1}`) return response(firstChunk, 206);
        assert.equal(range, `bytes=${chunkSize}-${complete.size - 1}`);
        if (++attempts === 1) {
          if (failure === 'short response') return response(new Blob(['B']), 206);
          return { ok: true, status: 206, headers: new Headers(), arrayBuffer: async () => { throw new TypeError('Failed to fetch'); } };
        }
        return response(lastChunk, 206);
      });
      await load(name, `https://${host}/example/model.ifc`, undefined, complete.size);
      assert.equal(opened[0][1].size, complete.size);
      assert.equal(await opened[0][1].slice(chunkSize).text(), 'BCD');
      assert.deepEqual(requests, [`bytes=0-${chunkSize - 1}`, `bytes=${chunkSize}-${complete.size - 1}`, `bytes=${chunkSize}-${complete.size - 1}`]);
    });
  }
}

for (const last of [new Blob([]), lastChunk]) {
  test(`hidden totals finish at EOF with ${last.size ? 'a partial final' : 'an exact-size'} chunk`, async () => {
    const bytes = new Blob([firstChunk, last]), requests = [];
    const { load, opened } = loader(async (_url, options) => {
      const range = new Headers(options.headers).get('Range'); requests.push(range);
      const [, start, end] = range.match(/^bytes=(\d+)-(\d+)$/).map(Number);
      return start >= bytes.size ? response(null, 416) : response(bytes.slice(start, end + 1), 206);
    });
    await load(name, url);
    assert.equal(opened[0][1].size, bytes.size);
    assert.equal(await opened[0][1].slice(chunkSize).text(), await last.text());
    assert.equal(requests.at(-1), `bytes=${bytes.size}-${bytes.size + chunkSize - 1}`);
  });
}

test('exposed Content-Range supplies original size without HEAD', async () => {
  let requests = 0;
  const { load, opened } = loader(async () => { requests++; return response(file, 206, { 'Content-Range': `bytes 0-${file.size - 1}/${file.size}` }); });
  await load(name, url);
  assert.equal(requests, 1);
  assert.equal(opened[0][1].size, file.size);
});

test('unexpected byte ranges cannot silently duplicate the first part', async () => {
  const { load, opened } = loader(async () => response(file, 206, { 'Content-Range': 'bytes 10-19/20' }));
  await assert.rejects(load(name, url), /Unexpected byte range/);
  assert.deepEqual(opened, []);
});

test('persistent chunk failures never redownload successful parts or import incomplete data', async () => {
  const requests = [];
  const { load, opened } = loader(async (_url, options) => {
    const range = new Headers(options.headers).get('Range'); requests.push(range);
    if (range === `bytes=0-${chunkSize - 1}`) return response(firstChunk, 206);
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(load(name, url, undefined, complete.size), /Failed to fetch/);
  assert.equal(requests.length, 4);
  assert.equal(requests.filter(r => r === `bytes=0-${chunkSize - 1}`).length, 1);
  assert.deepEqual(opened, []);
});

for (const afterChunk of [false, true]) {
  test(`a server ignoring Range ${afterChunk ? 'after a successful chunk' : 'on its first response'} returns one complete file`, async () => {
    let requests = 0;
    const { load, opened } = loader(async () => ++requests === 1 && afterChunk ? response(firstChunk, 206) : response(complete));
    await load(name, url, undefined, complete.size);
    assert.equal(opened[0][1].size, complete.size);
    assert.equal(await opened[0][1].slice(chunkSize).text(), 'BCD');
    assert.equal(requests, afterChunk ? 2 : 1);
  });
}

test('embedded data works through the same downloader', async () => {
  const { load, opened } = loader(fetch);
  await load('requirements.ids', 'data:application/xml,%3Cids/%3E');
  assert.equal(await opened[0][1].text(), '<ids/>');
});

for (const result of ['throw', 'isError']) {
  test(`SDK ${result} failures identify the import stage without downloading again`, async () => {
    let requests = 0;
    const { load } = loader(async () => { requests++; return response(); }, async () => {
      if (result === 'throw') throw new TypeError('Import failed');
      return { isError: true };
    });
    await assert.rejects(load(name, url), /Could not open clinic\.ifc:/);
    assert.equal(requests, 1);
  });
}

for (const id of ['autzen', 'zurich-district', 'west-riverside-hospital']) {
  test(`${id} retries incomplete downloads without reopening successful files`, async () => {
    const source = readFileSync(new URL(`../examples/${id}/index.html`, import.meta.url), 'utf8');
    const data = JSON.parse(source.match(/<script[^>]*id="example-data"[^>]*>([\s\S]*?)<\/script>/)[1]);
    const assets = data.assets.map(asset => ({ ...asset, bytes: file.size, url: `https://samples.example.com/${asset.id}` }));
    const startup = source.match(/async function load\(\) \{\r?\n[\s\S]*?\r?\n\}/)[0];
    const document = { body: { dataset: {} } }, retry = { hidden: true };
    const opened = [], requests = [], messages = [];
    let incomplete = true;
    const viewer = {
      ready: Promise.resolve(), setMessage: async (text, options) => { if (text !== null) messages.push({ text, ...options }); },
      add: async (...args) => { opened.push(args); }, toggleMap: async () => {},
    };
    const fetch = async url => { requests.push(url); return response(incomplete && url === assets.at(-1).url ? file.slice(0, 1) : file); };
    const load = new Function('viewer', 'assets', 'sample', 'document', 'retry', 'fetch', 'console', 'setTimeout',
      `${helper}\nconst imported = new Set(); let running = false;\n${startup}\nreturn load;`)(
      viewer, assets, data.viewer, document, retry, fetch, { error() {} }, callback => callback());
    await load();
    assert.equal(document.body.dataset.exampleState, 'error');
    assert.equal(retry.hidden, false);
    assert.deepEqual(opened.map(([name]) => name), assets.slice(0, -1).map(asset => asset.name));
    assert.match(messages.find(message => message.type === 'error').text, /incomplete/i);
    incomplete = false;
    await load();
    assert.equal(document.body.dataset.exampleState, 'loaded');
    assert.equal(retry.hidden, true);
    assert.deepEqual(opened.map(([name]) => name), assets.map(asset => asset.name));
    assert.ok(opened.every(([, blob]) => blob.size === file.size));
    assert.deepEqual(requests, [...assets.map(asset => asset.url), ...Array(3).fill(assets.at(-1).url)]);
    await load();
    assert.equal(requests.length, assets.length + 3);
    assert.equal(opened.length, assets.length);
  });
}
