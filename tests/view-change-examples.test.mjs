import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { loadPublishedSpecifications } from '../scripts/published-sdk.mjs';

function getFunction(example, name, bindings = {}) {
  const html = readFileSync(new URL(`../examples/${example}/index.html`, import.meta.url), 'utf8');
  const code = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];
  const source = ts.createSourceFile('example.js', code, ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  return new Function(...Object.keys(bindings), declaration.getText(source) + `\nreturn ${name};`)(...Object.values(bindings));
}

test('linked table uses unique selected IDs, excluding visibility and coloring', () => {
  const selectedIds = getFunction('view-table', 'selectedIds');
  const component = id => ({ name: 'Component', attributes: { IfcGuid: id } });
  const view = { root: { content: [{ name: 'Components', content: [
    { name: 'Selection', content: [component('selected'), component('selected'), component('second')] },
    { name: 'Visibility', content: [component('hidden')] },
    { name: 'Coloring', content: [component('colored')] },
  ] }] } };
  assert.deepEqual(selectedIds(view), ['selected', 'second']);
  assert.deepEqual(selectedIds({ root: { content: [] } }), []);
});

test('selected GlobalIds join host records and handle unknown and prototype names', () => {
  const records = new Map([['known', ['Duct, "round"', 'First Floor', '=unsafe']]]);
  const recordFor = getFunction('view-table', 'recordFor', { records });
  assert.deepEqual(recordFor('known'), records.get('known'));
  assert.deepEqual(recordFor('unknown'), ['Element unknown', '', '']);
  assert.deepEqual(recordFor('__proto__'), ['Element __proto__', '', '']);
});

test('share links preserve standard BCF ZIP bytes and restore the same topic ID', async () => {
  const { bcf } = await loadPublishedSpecifications();
  const view = await bcf.load('<VisualizationInfo Guid="0809848e-a33f-46d3-94f6-cd9f65015951"><Components><Selection><Component IfcGuid="3abcdefghijklmnopqrstu"/></Selection><Visibility DefaultVisibility="true"/></Components><PerspectiveCamera><CameraViewPoint><X>4</X><Y>6</Y><Z>9</Z></CameraViewPoint><CameraDirection><X>0</X><Y>0</Y><Z>-1</Z></CameraDirection><CameraUpVector><X>0</X><Y>1</Y><Z>0</Z></CameraUpVector><FieldOfView>60</FieldOfView><AspectRatio>1.6</AspectRatio></PerspectiveCamera></VisualizationInfo>', { schema: 'bcf-3.0/visinfo' });
  const id = crypto.randomUUID(), viewGuid = view.root.attributes.Guid;
  const markup = await bcf.load('<Markup><Topic Guid="' + id + '" TopicType="Coordination" TopicStatus="Open"><Title>Shared view</Title><CreationDate>2026-10-17T00:00:00Z</CreationDate><CreationAuthor>Reviewer</CreationAuthor><Viewpoints><ViewPoint Guid="' + viewGuid + '"><Viewpoint>' + viewGuid + '.bcfv</Viewpoint></ViewPoint></Viewpoints></Topic></Markup>', { schema: 'bcf-3.0/markup' });
  const metadata = markup.root.content.find(node => node.name === 'Topic');
  const archive = { kind: 'archive', specification: 'bcf-3.0', entries: {
    'bcf.version': { document: await bcf.load('<Version VersionId="3.0"/>', { schema: 'bcf-3.0/version' }) },
    'extensions.xml': { document: await bcf.load('<Extensions/>', { schema: 'bcf-3.0/extensions' }) },
    [id + '/markup.bcf']: { document: markup },
    [id + '/' + viewGuid + '.bcfv']: { document: view },
  } };
  const bytes = await bcf.save(archive), encode = getFunction('view-link', 'encodeBcf');
  const decode = getFunction('view-link', 'decodeBcf', { bcf });
  const hash = encode(bytes);
  assert.match(hash, /^#bcf=[A-Za-z0-9_-]+$/);
  const decoded = await decode(hash);
  assert.equal(decoded.topicGuid, id);
  assert.deepEqual(decoded.bytes, bytes);
  assert.deepEqual([...decoded.bytes.slice(0, 2)], [80, 75]);
  assert.equal((await bcf.validate(decoded.bytes)).valid, true);
  const calls = [];
  const restore = getFunction('view-link', 'restoreInitialLink', {
    restored: false, initialHash: hash, decodeBcf: decode,
    showBcf: result => calls.push(['shared', result]),
    viewer: { async setMessage() {}, async add(name, result) { calls.push(['import', name, result]); },
      async selectTopic(guid) { calls.push(['select', guid]); } },
  });
  await restore();
  assert.deepEqual(calls, [['import', 'shared-view.bcf', bytes], ['select', id], ['shared', bytes]]);
  await assert.rejects(decode('#view=1.invalid'), /invalid/);
  await assert.rejects(decode('#bcf=' + 'a'.repeat(25000)), /large/);
  await assert.rejects(decode('#bcf=bm90LXppcA'));
  await assert.rejects(decode(encode(await bcf.save(view))), /BCF archive/);
  assert.throws(() => encode(new Uint8Array(18001)), /large/);
  metadata.content.splice(-1, 0, { name: 'Description', namespaceURI: '', attributes: {}, content: ['x'.repeat(2100000)] });
  const huge = await bcf.save(archive);
  if (huge.length > 18000) assert.throws(() => encode(huge), /large/);
  else await assert.rejects(decode(encode(huge)));
});
