import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

for (const id of ['rotterdam-bridge', 's1-context', 's1-ids', 's1-structure', 'sixty5']) {
  test(`${id} imports its actual formats directly through the SDK`, async () => {
    const html = readFileSync(new URL(`../examples/${id}/index.html`, import.meta.url), 'utf8');
    const data = JSON.parse(html.match(/id="example-data">([\s\S]*?)<\/script>/)[1]);
    const code = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
    const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'load');
    const assets = data.assets;
    const opened = [], corrections = [], messages = [], maps = [], imported = new Set();
    const document = { body: { dataset: {} } }, retry = {};
    const viewer = {
      ready: Promise.resolve(), async add(name, bytes) { opened.push([name, bytes]); },
      async setMessage(message, options) { if (options?.type === 'error') messages.push(message); },
      async toggleMap(enabled) { maps.push(enabled); },
    };
    const correct = async (file, metadata) => { corrections.push(metadata); return new File(['prepared'], file.name); };
    const bindings = { assets, imported, document, retry, viewer, running: false,
      correctSampleCrs: correct, correctSampleGeoreference: correct,
      async loadExampleFile(name, url, open, size) {
        assert(assets.some(asset => asset.name === name && asset.url === url && asset.bytes === size));
        return open(new Blob(['original']), async () => {});
      },
    };
    const load = new Function(...Object.keys(bindings), declaration.getText(source) + '\nreturn load;')(...Object.values(bindings));
    await load();
    assert.equal(document.body.dataset.exampleState, 'loaded');
    assert.deepEqual(messages, []);
    assert.deepEqual(opened.map(([name]) => name), assets.map(asset => asset.name));
    assert.deepEqual(corrections, assets.flatMap(asset => asset.georeference ?? asset.crsCorrection ?? []));
    const edits = ['s1-context', 'rotterdam-bridge'].includes(id);
    assert.deepEqual(maps, edits ? [true] : []);
    if (!edits) {
      for (const [, bytes] of opened) assert.equal(await new Blob([bytes]).text(), 'original');
      assert(!code.includes('IfcAPI'), 'unchanged imports do not load the optional native API');
      assert(!data.placementEvidence, 'unchanged imports do not retain editing inputs');
    }
    if (id === 's1-ids') assert.equal(await opened.find(([name]) => name.endsWith('.ids'))[1].text(), 'original');
    await load();
    assert.equal(opened.length, assets.length, 'completed imports are reused on retry');
  });
}
