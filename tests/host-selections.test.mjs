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
  const constant = name => JSON.parse(source.statements.flatMap(node => node.declarationList?.declarations ?? [])
    .find(node => node.name.getText(source) === name).initializer.getText(source));
  const factory = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'createExampleProject');
  return { constant, create: new Function(factory.getText(source) + '; return createExampleProject;')() };
}
const child = (node, name) => node.content.find(item => item.name === name);

test('selection writes and clears a selection without adding colors, visibility exceptions or a camera', async () => {
  const { create, constant } = example('selection');
  const groups = [['0aaaaaaaaaaaaaaaaaaaaa','1aaaaaaaaaaaaaaaaaaaaa'], ['2aaaaaaaaaaaaaaaaaaaaa']];
  const identity = { topicGuid: crypto.randomUUID(), viewpointGuid: crypto.randomUUID() };
  for (const guids of [...groups, []]) {
    assert.equal(new Set(guids).size, guids.length);
    const { project } = create('Host review selection', guids, identity);
    const bytes = await bcf.save(project);
    assert.deepEqual(await bcf.validate(bytes), { valid: true, diagnostics: [] });
    const archive = await bcf.load(bytes);
    const viewpoint = archive.entries[identity.topicGuid + '/' + identity.viewpointGuid + '.bcfv'].document.root;
    assert.deepEqual(viewpoint.content.map(item => item.name), ['Components']);
    const components = child(viewpoint, 'Components');
    assert.deepEqual(components.content.map(item => item.name), guids.length ? ['Selection', 'Visibility'] : ['Visibility']);
    assert.deepEqual(child(components, 'Visibility').attributes, { DefaultVisibility: 'true' });
    assert.deepEqual(child(components, 'Visibility').content, []);
    assert.deepEqual(child(components, 'Selection')?.content.map(item => item.attributes.IfcGuid) ?? [], guids);
  }
});
