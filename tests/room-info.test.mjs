import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { loadPublishedSpecifications } from '../scripts/published-sdk.mjs';

const html = readFileSync(new URL('../examples/room-info/index.html', import.meta.url), 'utf8');
const code = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const source = ts.createSourceFile('room-info.js', code, ts.ScriptTarget.Latest, true);
const modelData = JSON.parse(html.match(/id="example-data">([\s\S]*?)<\/script>/)[1]).assets[0];
const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && ['labelLines', 'createRoomProject'].includes(node.name?.text))
  .map(node => node.getText(source)).join('\n');
const { labelLines, createRoomProject } = new Function(functions + '\nreturn { labelLines, createRoomProject };')();
const rooms = [
 { guid:'0aaaaaaaaaaaaaaaaaaaaa',id:'A1',name:'A room with a longer name',area:16,position:[12,22],min:[10,20],max:[14,24],radius:2 },
 { guid:'1aaaaaaaaaaaaaaaaaaaaa',id:'B1',name:'Office',area:24,position:[17,22],min:[14,20],max:[20,24],radius:2 }
], model = { ...modelData, projectGuid:'2aaaaaaaaaaaaaaaaaaaaa' }, floor={name:'Queried floor',elevation:12};
const child = (node, name) => node?.content.find(value => value.name === name);
const value = (node, name) => child(node, name)?.content[0];
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
const labelHeight = room => (labelLines(room).length * 86 + 28) / 300 * (room.labelScale ?? 1);
const labels = new Map(rooms.map(room => [room.guid, { bytes: png, height: labelHeight(room) }]));
const identity = { topicGuid: crypto.randomUUID(), viewpointGuid: crypto.randomUUID() };
const { bcf } = await loadPublishedSpecifications();

test('labels retain queried room numbers, complete names and footprint areas', () => {
 for(const room of rooms) { const lines=labelLines(room); assert.equal(lines[0],room.id); assert.equal(lines.slice(1,-1).join(' '),room.name); assert.equal(lines.at(-1),room.area.toFixed(1)+' m²'); }
});

for (const aspectRatio of [1280 / 720, 390 / 844]) {
  test(`the floor exports all room labels at a shared scale, with a valid BCF camera and cut (${aspectRatio})`, async () => {
    const project = createRoomProject(rooms, labels, model, { ...identity, floor, aspectRatio });
    const bytes = await bcf.save(project);
    assert.deepEqual(await bcf.validate(bytes), { valid: true, diagnostics: [] });
    const loaded = await bcf.load(bytes);
    const viewpoint = loaded.entries[identity.topicGuid + '/view.bcfv'].document.root;
    const camera = child(viewpoint, 'OrthogonalCamera');
    assert.deepEqual(child(camera, 'CameraDirection').content.map(axis => Number(axis.content[0])), [0, 0, -1]);
    assert.equal(Number(value(camera, 'ViewToWorldScale')), Math.max(4, 10 / aspectRatio) * 1.1);
    const planes = child(viewpoint, 'ClippingPlanes').content;
    const [top, bottom] = planes.map(plane => Number(value(child(plane, 'Location'), 'Z')));
    assert.deepEqual([top, bottom], [13.5, 11.8]);
    const bitmaps = child(viewpoint, 'Bitmaps').content;
    assert.equal(bitmaps.length, rooms.length);
    assert.equal(Object.keys(loaded.entries).filter(path => path.endsWith('.png')).length, rooms.length);
    for (const [index, bitmap] of bitmaps.entries()) {
      const room = rooms[index];
      assert.equal(value(bitmap, 'Format'), 'png');
      assert.deepEqual(loaded.entries[identity.topicGuid + '/' + value(bitmap, 'Reference')].bytes, png);
      assert.deepEqual(child(bitmap, 'Location').content.slice(0, 2).map(axis => Number(axis.content[0])), room.position);
      const elevation = Number(value(child(bitmap, 'Location'), 'Z'));
      assert(elevation > bottom && elevation < top);
      assert.equal(Number(value(bitmap, 'Height')), labelHeight(room));
      assert.deepEqual(child(bitmap, 'Normal').content.map(axis => Number(axis.content[0])), [0, 0, -1]);
      assert.deepEqual(child(bitmap, 'Up').content.map(axis => Number(axis.content[0])), [0, 1, 0]);
    }
    const markup = loaded.entries[identity.topicGuid + '/markup.bcf'].document.root;
    assert.equal(value(child(markup, 'Topic'), 'Title'), 'Queried floor · Room labels');
    assert.equal(child(child(child(markup, 'Header'), 'Files'), 'File').attributes.IfcProject, model.projectGuid);
  });
}
