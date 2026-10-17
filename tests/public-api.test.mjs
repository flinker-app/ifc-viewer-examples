import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPublicApi } from '../scripts/public-api-check.mjs';

test('allows the complete native IFC API without a method allowlist', () => {
  assert.doesNotThrow(() => checkPublicApi('example.js', 'const api = await viewer.IfcAPI; await api.Init(); const modelID = api.OpenModel(bytes); api.GetGeometry(modelID, id); api.WriteLine(modelID, line); api.CloseModel(modelID); api.Dispose();'));
  assert.throws(() => checkPublicApi('example.js', 'const api = await viewer.ifcAPI;'), /outside the example instance API/);
  assert.throws(() => checkPublicApi('example.js', "const ids = ['0aaaaaaaaaaaaaaaaaaaaa'];"), /query IFC identifiers/);
});

test('allows the constructor and documented instance methods', () => {
  assert.doesNotThrow(() => checkPublicApi('example.js', "import { Viewer } from './sdk.js'; const viewer = new Viewer('#ifc-viewer'); await viewer.ready; await viewer.add('issues.bcf', blob); await viewer.selectTopic(topic.guid);"));
});

test('allows topic IDs and captures while rejecting superseded viewer methods', () => {
  assert.doesNotThrow(() => checkPublicApi('example.js', 'await viewer.selectTopic(topic.guid); await viewer.createTopic();'));
  for (const method of ['select', 'applyViewpoint', 'captureSnapshot', 'captureViewpoint'])
    assert.throws(() => checkPublicApi('example.js', `await viewer.${method}(topic.guid);`), /outside the example instance API/);
});

test('allows toggling the selected map and explicitly showing or hiding it', () => {
  assert.doesNotThrow(() => checkPublicApi('example.js', 'await viewer.toggleMap(); await viewer.toggleMap(true); await viewer.toggleMap(false);'));
});

test('allows subscribing to complete BCF view changes and removing the listener', () => {
  assert.doesNotThrow(() => checkPublicApi('example.js', 'await viewer.ready; const unsubscribe = viewer.onViewChange(view => { latestView = view; }); unsubscribe();'));
});
test('rejects deprecated exports even when renamed on import', () => {
  assert.throws(() => checkPublicApi('example.js', "import { openModel as addModel } from './sdk.js';"), /deprecated SDK export openModel/);
  assert.throws(() => checkPublicApi('example.js', "import { IfcViewer as OldViewer } from './sdk.js';"), /deprecated SDK export IfcViewer/);
});

test('checks SDK exports when the CDN URL has a pinned build identifier', () => {
  const url = 'https://cdn.flinker.app/ifc-viewer/v4.0.1/ifc-viewer.es.js?build=20261015T093139Z';
  assert.doesNotThrow(() => checkPublicApi('example.js', `import { Viewer, bcf } from '${url}';`));
  assert.throws(() => checkPublicApi('example.js', `import { getRuntime } from '${url}';`), /deprecated SDK export getRuntime/);
  assert.throws(() => checkPublicApi('example.js', `import { openTab } from '${url}';`), /SDK export openTab/);
});
test('rejects non-exported helpers and private toolbar selectors', () => {
  assert.throws(() => checkPublicApi('example.js', "import { openTab } from './sdk.js';"), /SDK export openTab/);
  assert.throws(() => checkPublicApi('example.js', 'document.querySelector("ifc-viewport");'), /not public APIs/);
});
test('audits inline modules in HTML examples', () => {
  assert.throws(() => checkPublicApi('example.html', '<script type="module">initializeViewer();</script>'), /deprecated or unsupported SDK call/);
});

test('rejects SDK DOM commands and property-loading listeners', () => {
  assert.throws(() => checkPublicApi('example.js', "window.dispatchEvent(new CustomEvent('ifcSelectionEvent', { detail: ids }));"), /SDK DOM event/);
  assert.throws(() => checkPublicApi('example.js', 'window.dispatchEvent(new CustomEvent(`ifcColorEvent`, { detail: ids }));'), /SDK DOM event/);
  assert.throws(() => checkPublicApi('example.js', "window.addEventListener('ifcPropertiesLoaded', updateStatus);"), /SDK DOM event/);
  assert.throws(() => checkPublicApi('example.js', "window.dispatchEvent(new CustomEvent('idsLoadEvent', { detail: xml }));"), /SDK DOM event/);
  assert.doesNotThrow(() => checkPublicApi('example.js', "button.addEventListener('click', () => viewer.clear());"));
});

test('rejects direct services, bracket access, destructuring and renamed viewer instances', () => {
  for (const code of [
    'viewer.runtime.bcf.export();',
    "viewer['renderer'].getSceneBoundsSource();",
    'const { models } = viewer;',
    "import { Viewer as Embedded } from './sdk.js'; const embedded = new Embedded(); embedded.runtime.camera.zoom('in');",
    'const alias = viewer; alias.models.values();',
    'window.exampleViewer.runtime.selection.clear();',
    'viewer.openTab("Topics");',
    'viewer.setPowerBIFilter(ids);',
    'viewer.components.get(viewer.OBC.BCFTopics);',
    'const { OBC, THREE, components, world } = viewer;',
    'viewer.fragments.core.models.list.values();',
    'viewer.world.camera.controls.setLookAt(0, 0, 0);',
  ]) assert.throws(() => checkPublicApi('example.js', code), /outside the example instance API/);
});

test('rejects the replaced external BCF library', () => {
  assert.throws(() => checkPublicApi('example.js', "import { writeBCF } from 'https://esm.sh/@ifc-lite/bcf@5.0.1?bundle';"), /use the SDK bcf namespace/);
});

test('allows the public BCF and IDS document operations', () => {
  assert.doesNotThrow(() => checkPublicApi('example.js', "import { bcf, ids } from './sdk.js'; await bcf.save(await bcf.load(file)); await ids.validate(file);"));
});

test('rejects non-public document namespace operations and aliases', () => {
  for (const code of [
    "import { bcf } from './sdk.js'; bcf.createTopic();",
    "import { ids as xml } from './sdk.js'; xml.testAll();",
    "Viewer.bcf.load(file);",
    "Viewer.ids.validate(file);",
  ]) assert.throws(() => checkPublicApi('example.js', code), /outside the public document API/);
  for (const code of ['viewer.bcf.load(file);', 'const xml = viewer.ids;'])
    assert.throws(() => checkPublicApi('example.js', code), /outside the example instance API/);
});
