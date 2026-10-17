import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { loadPublishedSpecifications } from '../scripts/published-sdk.mjs';

const { bcf } = await loadPublishedSpecifications();
const child = (node, name) => node?.content.find(value => value.name === name);
const number = (node, name) => Number(child(node, name).content[0]);
function example(folder, aspectRatio = 1.6, identities = new Map()) {
  const html = readFileSync(new URL(`../examples/${folder}/index.html`, import.meta.url), 'utf8');
  const code = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];
  const source = ts.createSourceFile('example.js', code, ts.ScriptTarget.Latest, true);
  const declarations = source.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []);
  const value = name => declarations.find(node => node.name.getText(source) === name).initializer.getText(source);
  const factory = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'createBcfProject');
  const { assets: [model] } = JSON.parse(html.match(/id="example-data">([\s\S]*?)<\/script>/)[1]);
  return new Function('aspectRatio', 'identities', 'model', `${factory.getText(source)}; return createBcfProject(${folder==='floorplans' ? JSON.stringify([{id:'lower',title:'Lower',description:'Queried lower storey',bottom:11.7,top:13.5},{id:'upper',title:'Upper',description:'Queried upper storey',bottom:15.7,top:17.5}]) : value('presets')}, { ...model, projectGuid:'16x45o1kv4a8k1NBGFE3$X' }, aspectRatio, identities);`)(aspectRatio, identities, model);
}

for (const folder of ['floorplans', 'bcf-2d']) test(`${folder} exports schema-valid BIM Whale viewpoints and preserves their cameras and cuts`, async () => {
  const { project, topics } = example(folder);
  const blob = await bcf.save(project);
  assert.deepEqual(await bcf.validate(blob), { valid: true, diagnostics: [] });
  const loaded = await bcf.load(blob);
  assert.equal(topics.size, folder === 'floorplans' ? 2 : 3);
  const viewpoints = [...topics.keys()].map(id => loaded.entries[topics.get(id) + '/view.bcfv'].document.root);
  const markups = [...topics.values()].map(id => loaded.entries[id + '/markup.bcf'].document.root);
  for (const markup of markups) {
    const file = child(child(child(markup, 'Header'), 'Files'), 'File');
    assert.equal(file.attributes.IfcProject, '16x45o1kv4a8k1NBGFE3$X');
    assert.equal(child(file, 'Filename').content[0], 'AdvancedProject.ifc');
  }
  if (folder === 'floorplans') {
    assert.deepEqual([...topics.keys()], ['lower', 'upper']);
    for (const [index, datum] of [12, 16].entries()) {
      const viewpoint = viewpoints[index];
      const cuts = child(viewpoint, 'ClippingPlanes').content;
      assert(Math.abs(number(child(cuts[0], 'Location'), 'Z') - (datum + 1.5)) < 1e-9);
      assert(Math.abs(number(child(cuts[1], 'Location'), 'Z') - (datum - 0.3)) < 1e-9);
      assert.deepEqual(cuts.map(cut => number(child(cut, 'Direction'), 'Z')), [1, -1]);
      assert.equal(number(child(child(viewpoint, 'OrthogonalCamera'), 'CameraDirection'), 'Z'), -1);
    }
  } else {
    for (const viewpoint of viewpoints) assert.equal(child(viewpoint, 'ClippingPlanes'), undefined);
    const camera = child(viewpoints[1], 'OrthogonalCamera');
    assert.equal(number(child(camera, 'CameraDirection'), 'Z'), -1);
    const up = child(camera, 'CameraUpVector');
    assert(Math.abs(number(up, 'X') - 0.5) < 1e-12);
    assert(Math.abs(number(up, 'Y') - Math.sqrt(3) / 2) < 1e-12);
    assert(child(viewpoints[2], 'PerspectiveCamera'));
  }
});

test('floor plans refit portrait cameras without duplicating saved topics', async () => {
  const identities = new Map();
  const landscape = example('floorplans', 1280 / 800, identities);
  const portrait = example('floorplans', 390 / 844, identities);
  assert.deepEqual(portrait.topics, landscape.topics);
  assert.equal(identities.size, 2);
  const bytes = await bcf.save(portrait.project);
  assert.deepEqual(await bcf.validate(bytes), { valid: true, diagnostics: [] });
  const archive = await bcf.load(bytes);
  for (const topic of portrait.topics.values()) {
    const camera = child(archive.entries[topic + '/view.bcfv'].document.root, 'OrthogonalCamera');
    assert(Math.abs(number(camera, 'ViewToWorldScale') - 90 / (390 / 844)) < 1e-9);
    assert.equal(number(camera, 'AspectRatio'), 390 / 844);
  }
});
