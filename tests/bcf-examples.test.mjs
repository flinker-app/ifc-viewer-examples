import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { loadPublishedSpecifications } from '../scripts/published-sdk.mjs';

const { bcf } = await loadPublishedSpecifications();
function example(folder) {
  const html = readFileSync(new URL(`../examples/${folder}/index.html`, import.meta.url), 'utf8');
  const code = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];
  const source = ts.createSourceFile('example.js', code, ts.ScriptTarget.Latest, true);
  const constants = name => source.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .find(node => node.name.getText(source) === name).initializer.getText(source);
  const functions = names => source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
    .map(node => node.getText(source)).join('\n');
  return { constants, functions, model: folder === 'bcf' ? undefined : JSON.parse(constants('model')),
    presets: folder === 'bcf' ? {} : folder === 'bcf-coloring' ? { 'bcf-coloring': JSON.parse(constants('preset')) } : JSON.parse(constants('presetDefinitions')) };
}
const { constants } = example('bcf');
const samples = JSON.parse(constants('sampleFiles'));
const child = (node, name) => node?.content.find(value => value.name === name);
const children = (node, name) => node?.content.filter(value => value.name === name) ?? [];
const cases = [
  'bcf-coloring', 'bcf-visibility-hide-doors-windows',
  'bcf-visibility-show-doors-windows', 'bcf-visibility-hide-spaces-boundaries-openings',
  'bcf-visibility-show-spaces-only', 'bcf-clipping', 'bcf-clipping-section', 'bcf-clipping-section-box',
];

for (const name of cases) {
  test(`${name} creates schema-valid BCF 3.0 with the published SDK and imports its topic`, async () => {
    const folder = name;
    const canonical = folder.startsWith('bcf-visibility') ? 'bcf-visibility'
      : folder.startsWith('bcf-clipping') ? 'bcf-clipping' : folder;
    const { functions, presets, model } = example(canonical);
    const imports = [];
    const viewer = {
      async add(filename, blob) { imports.push({ filename, blob }); },
    };
    const { createExampleProject, addExampleProject } = new Function('bcf', 'viewer',
      functions(['createExampleProject', 'addExampleProject']) + '\nreturn { createExampleProject, addExampleProject };')(bcf, viewer);
    const preset = presets[folder];
    const api = {
      GetTypeCodeFromName(name) { return name; }, GetLineIDsWithType(_modelID,type) { return { size: () => 1, get: () => type, delete() {} }; },
      GetLines(_modelID,types) { return types.map((type,index) => ({GlobalId:{value:'0aaaaaaaaaaaaaaaaaaaaa'}})); } };
    const { modelState } = new Function('viewer', 'model', functions(['scalar','readIfcLines','queryType','modelState']) + '\nreturn { modelState };')({IfcAPI:api}, model);
    const state = await modelState(preset, api, 0);
    const { project } = createExampleProject(preset.label, state,
      { ...preset.camera, aspectRatio: 1.6 }, model);
    await addExampleProject(project, folder + '.bcf');
    assert.equal(imports.length, 1);
    assert.ok(imports[0].blob instanceof Blob, 'imports must use the generated archive bytes');
    assert.deepEqual(await bcf.validate(imports[0].blob), { valid: true, diagnostics: [] });
    const archive = await bcf.load(imports[0].blob);
    assert.equal(archive.specification, 'bcf-3.0');
    assert.ok(archive.entries['extensions.xml']);
    const documents = Object.values(archive.entries).map(entry => entry.document).filter(Boolean);
    const markup = documents.find(document => document.root.name === 'Markup').root;
    const topic = child(markup, 'Topic');
    assert.ok(topic.attributes.Guid);
    assert.equal(children(child(child(markup, 'Header'), 'Files'), 'File').length, 1);
    const viewpoint = documents.find(document => document.root.name === 'VisualizationInfo').root;
    const camera = child(viewpoint, 'PerspectiveCamera') ?? child(viewpoint, 'OrthogonalCamera');
    assert.equal(child(camera, 'AspectRatio').content[0], '1.6');
    if (folder === 'bcf-clipping-section') {
      assert.equal(camera.name, 'OrthogonalCamera');
      assert.equal(child(child(camera, 'CameraDirection'), 'Z').content[0], '-1');
    }
    if (folder === 'bcf-clipping') assert.equal(camera.name, 'OrthogonalCamera');
    function inspect(node) {
      if (node.name === 'Component') assert.match(node.attributes.IfcGuid, /^[0-3][0-9A-Za-z_$]{21}$/);
      for (const item of node.content ?? []) if (typeof item === 'object') inspect(item);
    }
    inspect(viewpoint);
    const components = child(viewpoint, 'Components');
    if (folder === 'bcf-coloring') {
      const colors = children(child(components, 'Coloring'), 'Color');
      assert.equal(colors.length, 4);
      for (const color of colors) assert.ok(children(child(color, 'Components'), 'Component').length);
    }
    if (folder.includes('show-')) assert.equal(child(components, 'Visibility').attributes.DefaultVisibility, 'false');
    if (folder === 'bcf-clipping-section-box') assert.equal(children(child(viewpoint, 'ClippingPlanes'), 'ClippingPlane').length, 6);
    else if (folder.startsWith('bcf-clipping')) assert.equal(children(child(viewpoint, 'ClippingPlanes'), 'ClippingPlane').length, 1);
  });
}

test('the explorer uses the Architectural and MEP BCF 3.0 collection with only those two models', () => {
  assert.equal(samples.length, 19);
  assert.equal(new Set(samples.map(sample => sample.name)).size, samples.length, 'same-named cases must remain distinct');
  assert.equal(new Set(samples.map(sample => sample.url)).size, samples.length);
  for (const [version, count] of [['3.0', 19]]) {
    const versionSamples = samples.filter(sample => sample.url.includes(`/v${version}/`));
    assert.equal(versionSamples.length, count, `complete BCF ${version} collection`);
    assert.ok(versionSamples.every(sample => sample.name.startsWith(`BCF ${version} - `)));
  }
  assert.ok(samples.every(sample => sample.url.startsWith('https://raw.githubusercontent.com/buildingSMART/BCF-XML/bc48611d0d7a1587f028a2b69677a1aafd5cd0a8/')));
  assert.ok(samples.every(sample => /\.(bcf|bcfzip)$/i.test(sample.url) && !sample.url.includes('/unzipped/')));
  assert.ok(samples.every(sample => Number.isInteger(sample.size) && sample.size > 0));
  assert.equal(samples.reduce((bytes, sample) => bytes + sample.size, 0), 806001);
  assert.deepEqual(JSON.parse(constants('modelFiles')).map(file => file.name), ['Architectural.ifc', 'MEP.ifc']);
});
