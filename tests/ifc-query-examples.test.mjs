import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { loadPublishedSpecifications } from '../scripts/published-sdk.mjs';

function functions(id) {
  const html = readFileSync(new URL(`../examples/${id}/index.html`, import.meta.url), 'utf8');
  const code = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const source = ts.createSourceFile('example.js', code, ts.ScriptTarget.Latest, true);
  const names = ['scalar', 'spatialFloors', 'createExampleProject'];
  const declarations = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  return new Function(declarations.map(node => node.getText(source)).join('\n') + '\nreturn {' + names.filter(name => declarations.some(node => node.name?.text === name)).join(',') + '};')();
}
const takeoff = functions('ifc-quantity-takeoff');
const wrapped = value => ({ value });

test('spatial containment carries storeys through spaces and preserves unassigned objects', () => {
  const floors = takeoff.spatialFloors({ expressID: 1, type: 'IFCPROJECT', children: [
    { expressID: 2, type: 'IfcBuildingStorey', Name: wrapped('First Floor'), children: [
      { expressID: 3, type: 'IfcSpace', children: [{ expressID: 4, type: 'IfcFlowSegment' }] },
    ] }, { expressID: 5, type: 'IfcFlowSegment' },
  ] });
  assert.equal(floors.get(4), 'First Floor');
  assert.equal(floors.get(5), '');
});

test('space table selections reveal all spaces and highlight the chosen space', async () => {
  const { bcf } = await loadPublishedSpecifications();
  const guid = '0ztdC3L1HAzhbhMHypqbH5';
  const visible = [guid, '0ztdC3L1HAzhbhMHypqcY9'];
  const { project } = takeoff.createExampleProject('Check <space> & area', visible, [guid], {});
  const bytes = await bcf.save(project);
  assert.equal((await bcf.validate(bytes)).valid, true);
  const loaded = await bcf.load(bytes);
  const documents = Object.values(loaded.entries).map(entry => entry.document).filter(Boolean);
  const topic = documents.find(document => document.root.name === 'Markup').root.content.find(node => node.name === 'Topic');
  assert.equal(topic.attributes.TopicStatus, 'Open');
  assert.equal(topic.content.find(node => node.name === 'Title').content[0], 'Check <space> & area');
  const components = documents.find(document => document.root.name === 'VisualizationInfo').root.content.find(node => node.name === 'Components');
  assert.equal(components.content.find(node => node.name === 'Selection').content[0].attributes.IfcGuid, guid);
  const visibility = components.content.find(node => node.name === 'Visibility');
  assert.equal(components.content.find(node => node.name === 'ViewSetupHints').attributes.SpacesVisible, 'true');
  assert.equal(visibility.attributes.DefaultVisibility, 'false');
  assert.deepEqual(visibility.content.find(node => node.name === 'Exceptions').content.map(node => node.attributes.IfcGuid), visible);
});
