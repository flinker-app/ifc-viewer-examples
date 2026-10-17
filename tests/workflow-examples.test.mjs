import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { loadPublishedSpecifications } from '../scripts/published-sdk.mjs';

const { bcf } = await loadPublishedSpecifications();
function example(id) {
  const html = readFileSync(new URL(`../examples/${id}/index.html`, import.meta.url), 'utf8');
  const code = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const source = ts.createSourceFile('example.js', code, ts.ScriptTarget.Latest, true);
  const constant = name => name === 'modelFiles' ? data.assets : JSON.parse(source.statements.flatMap(node => node.declarationList?.declarations ?? [])
    .find(node => node.name.getText(source) === name).initializer.getText(source));
  const functions = names => source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name.text)).map(node => node.getText(source)).join('\n');
  const data = JSON.parse(html.match(/<script type="application\/json" id="example-data">([\s\S]*?)<\/script>/)[1]);
  return { constant, functions, data, make(names, bindings = {}) {
    return new Function(...Object.keys(bindings), functions(names) + '\nreturn {' + names.join(',') + '};')(...Object.values(bindings));
  } };
}
const child = (node, name) => node.content.find(item => item.name === name);
const camera = { cameraViewPoint: { x: 12, y: -16, z: 11 }, cameraDirection: { x: -.5252257314, y: .7003009752, z: -.4814569205 },
  cameraUpVector: { x: -.2888741523, y: .3851655364, z: .8764694976 }, viewToWorldScale: 24, aspectRatio: 1.6 };
async function roundtrip(id, state) {
  const { createExampleProject } = example(id).make(['createExampleProject']);
  const { project } = createExampleProject('Workflow review', state, ...(id === 'storey-visibility' ? [] : [camera]));
  const bytes = await bcf.save(project);
  assert.deepEqual(await bcf.validate(bytes), { valid: true, diagnostics: [] });
  const archive = await bcf.load(bytes);
  const viewpoint = Object.values(archive.entries).find(entry => entry.document?.root.name === 'VisualizationInfo').document.root;
  const components = child(viewpoint, 'Components');
  const visibility = child(components, 'Visibility');
  const hints = child(visibility, 'ViewSetupHints') ?? child(components, 'ViewSetupHints');
  assert.equal(hints.attributes.SpacesVisible, String(state.visibility?.hints?.spacesVisible ?? false));
  assert.equal(visibility.attributes.DefaultVisibility, String(state.visibility?.defaultVisibility ?? true));
  assert.deepEqual(child(visibility, 'Exceptions')?.content.map(item => item.attributes.IfcGuid) ?? [], state.visibility?.exceptions ?? []);
  const colors = child(components, 'Coloring')?.content ?? [];
  const expected = (state.coloring ?? []).filter(item => item.ids.length);
  assert.equal(colors.length, expected.length);
  for (let i = 0; i < colors.length; i++) {
    assert.equal(colors[i].attributes.Color, expected[i].color);
    assert.deepEqual(child(colors[i], 'Components').content.map(item => item.attributes.IfcGuid), expected[i].ids);
  }
  return viewpoint;
}

test('the building workflows use the full pinned MIT-licensed BIM Whale model', () => {
  for (const id of ['bcf-2d', 'floorplans', 'selection', 'window-width']) {
    const files = example(id).constant('modelFiles');
    assert(files.length > 0);
    for (const file of files) {
      assert.equal(file.name, 'AdvancedProject.ifc'); assert.equal(file.bytes, 44337371);
      assert.equal(file.sha256, '86b068a7ca6947e398c1daaa8bede9d31048c3990adc308429faeb56ee01db94');
      assert.equal(file.license, 'MIT'); assert.match(file.url, /595fa90e3af7120d004fcb37a79d8657f1d1c9c2/);
    }
  }
});
test('the selected workflows use only the pinned Riverside architecture with its model-specific license', () => {
  for (const id of ['storey-visibility', 'component-lookup']) {
    const files = example(id).data.assets;
    assert.equal(files.length, 1);
    const [file] = files;
    assert.equal(file.id, 'west-riverside-arc-ifc4');
    assert.equal(file.name, 'arc_ifc4.ifc'); assert.equal(file.bytes, 80937122);
    assert.equal(file.sha256, '230afa4d72a59c9ce18cdd9a7bc7c5c3e409a46078de6e14b19741b4cf92cf09');
    assert.equal(file.license, 'CC BY 3.0');
    assert.match(file.url, /1288fc91655823a36900b7bb75a671d5fa444afd/);
    assert.match(file.attribution, /Solihin/);
  }
});
test('workflows import only their unchanged source and only once', async () => {
  const required = { 'storey-visibility': ['west-riverside-arc-ifc4'], 'component-lookup': ['west-riverside-arc-ifc4'], 'window-width': ['bim-whale-advanced'] };
  for (const [id, expected] of Object.entries(required)) {
    const ex = example(id), modelFiles = ex.constant('modelFiles');
    assert.deepEqual(modelFiles.map(file => file.id), expected, id + ' imports');
    assert.deepEqual(ex.data.assets.map(file => file.id), expected, id + ' source metadata');
    assert.deepEqual(ex.data.viewer.assetIds, expected, id + ' viewer metadata');
    const downloaded = [], opened = [], loadedSources = new Set();
    const { loadModels } = ex.make(['loadModels'], {
      modelFiles, loadedSources, sourcesReady: false,
      withIfcModel: async (blob, read) => read({}, 0), readStoreys() {}, readWindows() {}, readSearchIndex() { return []; }, records: [],
      sourceBlob: async asset => { downloaded.push(asset.id); return new Blob([asset.id]); },
      viewer: { async setMessage() {}, async add(name, blob) { opened.push([name, await blob.text()]); } },
    });
    await loadModels();
    await loadModels();
    assert.deepEqual(downloaded, expected, id + ' downloads each required model once');
    assert.deepEqual(opened, modelFiles.map(file => [file.name, file.id]), id + ' opens only required models');
  }
});
test('storey visibility supports every combination, including no storeys', async () => {
  const ex = example('storey-visibility'), storeys = [0,1,2].map(index => ({ ids: [String(index) + 'aaaaaaaaaaaaaaaaaaaaa'] }));
  const { storeyState } = ex.make(['storeyState'], { storeys });
  for (let mask = 0; mask < 8; mask++) {
    const indices = [0, 1, 2].filter(index => mask & (1 << index)), state = storeyState(indices);
    assert.equal(state.visibility.exceptions.length, indices.reduce((sum, index) => sum + storeys[index].ids.length, 0));
    await roundtrip('storey-visibility', state);
  }
});
test('window widths partition correctly at threshold boundaries', async () => {
  const ex = example('window-width'), windows = [100,200,300,500].map((size,index) => ({guid: String(index) + 'aaaaaaaaaaaaaaaaaaaaa', widthMm:size}));
  const { sizeState } = ex.make(['sizeState'], { windows });
  let previous = Infinity;
  for (const threshold of [100, 200, 300, 500]) {
    const state = sizeState(threshold), [large, small] = state.coloring;
    assert.equal(large.ids.length + small.ids.length, windows.length);
    assert.equal(new Set([...large.ids, ...small.ids]).size, windows.length);
    assert(large.ids.length <= previous); previous = large.ids.length;
    assert.deepEqual(large.ids, windows.filter(item => item.widthMm >= threshold).map(item => item.guid));
    await roundtrip('window-width', state);
  }
});
test('rapid host updates finish in order and recover after a failed update', async () => {
  const messages = [], controls = { disabled: false }, retry = { hidden: true }, document = { body: { dataset: {} } };
  const viewer = { ready: Promise.resolve(), async setMessage(text) { if (text !== null) messages.push(text); } };
  const { run } = example('window-width').make(['run'], { retryTask: undefined, updates: Promise.resolve(), pendingUpdates: 0, sourcesReady: true, controls, retry, document, viewer });
  let release, active = 0, maximum = 0; const order = [];
  const first = run(async () => { active++; maximum = Math.max(maximum, active); order.push('first'); await new Promise(resolve => { release = resolve; }); active--; throw new Error('A failed view'); });
  const second = run(async () => { active++; maximum = Math.max(maximum, active); order.push('second'); active--; });
  assert.equal(controls.disabled, true); await new Promise(resolve => setTimeout(resolve, 0)); assert.deepEqual(order, ['first']); release();
  await Promise.all([first, second]); assert.equal(maximum, 1); assert.deepEqual(order, ['first', 'second']);
  assert.deepEqual(messages, ['A failed view']); assert.equal(controls.disabled, false); assert.equal(document.body.dataset.exampleState, 'loaded');
});
