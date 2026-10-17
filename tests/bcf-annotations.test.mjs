import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { loadPublishedSpecifications } from '../scripts/published-sdk.mjs';

const html = readFileSync(new URL('../examples/bcf-annotations/index.html', import.meta.url), 'utf8');
const data = JSON.parse(html.match(/id="example-data">([\s\S]*?)<\/script>/)[1]);
const blob = new Blob([Buffer.from(data.annotation.data.split(',')[1], 'base64')]);
const child = (node, name) => node.content.find(item => item.name === name);
const { bcf } = await loadPublishedSpecifications();

test('the saved annotation is a valid, restorable BCF issue with actual line markup', async () => {
  assert.deepEqual(await bcf.validate(blob), { valid: true, diagnostics: [] });
  const archive = await bcf.load(blob);
  assert.equal(archive.specification, 'bcf-3.0');
  const documents = Object.values(archive.entries).map(entry => entry.document?.root).filter(Boolean);
  const markup = documents.find(node => node.name === 'Markup');
  const topic = child(markup, 'Topic');
  assert.equal(child(topic, 'Title').content[0], 'Review stair opening protection');
  const reference = child(child(topic, 'Viewpoints'), 'ViewPoint');
  const view = archive.entries[topic.attributes.Guid + '/' + child(reference, 'Viewpoint').content[0]].document.root;
  assert.equal(view.attributes.Guid, reference.attributes.Guid);
  const strokes = child(view, 'Lines').content;
  assert.equal(strokes.length, 427, 'seven centerlines with dense parallel strokes for a bold marker');
  const lines = strokes.slice(0, 7);
  const point = (line, name) => child(line, name).content.map(axis => Number(axis.content[0]));
  for (let index = 0; index < 4; index++) {
    assert.deepEqual(point(lines[index], 'EndPoint'), point(lines[(index + 1) % 4], 'StartPoint'));
  }
  for (const line of lines) {
    const start = point(line, 'StartPoint'), end = point(line, 'EndPoint');
    assert(start.every(Number.isFinite) && end.every(Number.isFinite));
    assert(Math.hypot(...start.map((value, index) => value - end[index])) > .1);
    assert.equal(start[2], 4.9, 'authored markup sits above the stair approach');
  }
  assert.deepEqual(point(lines[4], 'EndPoint'), point(lines[5], 'EndPoint'));
  assert.deepEqual(point(lines[4], 'EndPoint'), point(lines[6], 'EndPoint'));
  const start = point(lines[0], 'StartPoint');
  const edge = point(lines[0], 'EndPoint').map((value, index) => value - start[index]);
  const offsets = strokes.slice(7, 67).map(line => {
    const offset = point(line, 'StartPoint').map((value, index) => value - start[index]);
    return (edge[0] * offset[1] - edge[1] * offset[0]) / Math.hypot(edge[0], edge[1]);
  });
  assert(Math.max(...offsets) - Math.min(...offsets) > .279, 'saved marker has a 28 cm stroke in model coordinates');
  const camera = child(view, 'OrthogonalCamera');
  assert(Number(child(child(camera, 'CameraDirection'), 'Z').content[0]) < -.5);
  assert.equal(child(camera, 'ViewToWorldScale').content[0], '20');
  assert.equal(child(view, 'ClippingPlanes').content.length, 6);
  const file = child(child(child(markup, 'Header'), 'Files'), 'File');
  assert.equal(child(file, 'Filename').content[0], data.assets[0].name);
  assert.equal(child(file, 'Reference').content[0], data.assets[0].url);
  const restored = await bcf.load(await bcf.save({ kind: 'xml', schema: 'bcf-3.0/visinfo', root: view }), { schema: 'bcf-3.0/visinfo' });
  assert.deepEqual(restored.root, view);
});

test('startup reuses imported annotations and restores the same saved topic', async () => {
  const code = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const source = ts.createSourceFile('annotations.js', code, ts.ScriptTarget.Latest, true);
  const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && ['load', 'restoreView'].includes(node.name.text))
    .map(node => node.getText(source)).join('\n');
  const imports = [], selections = [], messages = [];
  const document = { body: { dataset: {} } }, restore = {}, retry = {};
  let failed = true;
  const viewer = {
    async add(name, bytes) { imports.push(name); assert.equal(bytes.size, blob.size); },
    async selectTopic(id) { selections.push(id); if (failed) throw new Error('Interrupted view restoration'); },
    async setMessage(text, options) { if (options?.type === 'error') messages.push(text); },
  };
  const load = new Function('viewer', 'bcf', 'model', 'annotation', 'document', 'restore', 'retry', 'loadExampleFile',
    `let modelLoaded = false, topicId; ${functions}; return load;`)(viewer, bcf, data.assets[0], data.annotation,
    document, restore, retry, async name => imports.push(name));
  await load();
  assert.equal(document.body.dataset.exampleState, 'error');
  assert.equal(retry.hidden, false);
  assert.deepEqual(messages, ['Interrupted view restoration']);
  failed = false;
  await load();
  assert.equal(document.body.dataset.exampleState, 'loaded');
  assert.equal(retry.hidden, true);
  assert.equal(restore.disabled, false);
  assert.deepEqual(imports, ['AdvancedProject.ifc', 'stair-opening-review.bcf']);
  assert.equal(selections.length, 2);
  assert.equal(selections[0], selections[1]);
});
