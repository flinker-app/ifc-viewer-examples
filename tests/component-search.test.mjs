import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const html = readFileSync(new URL('../examples/component-lookup/index.html', import.meta.url), 'utf8');
const source = ts.createSourceFile('example.js', html.match(/<script type="module">([\s\S]*?)<\/script>/)[1], ts.ScriptTarget.Latest, true);
const names = ['scalarValue', 'flattenValues', 'definitionEntries', 'attributes', 'referenceIds', 'searchRecords', 'readIfcLines', 'queryType', 'rowsOfType', 'readSearchIndex', 'searchModel'];
const code = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(source)).join('\n');
const make = (bindings = {}) => new Function(...Object.keys(bindings), code + '\nreturn {' + names.join(',') + '};')(...Object.values(bindings));
const { definitionEntries, attributes, searchRecords } = make();
const value = value => ({ value });
const ref = value => ({ type: 5, value });

test('full property search retains nested, list, bounded, table, quantity and missing values without treating references as data', () => {
  const entries = definitionEntries({ Name: value('Review'), HasProperties: [
    { Name: value('Complete'), NominalValue: value(false) },
    { Name: value('Zero'), NominalValue: { _representationValue: 0 } },
    { Name: value('Missing'), NominalValue: null },
    { Name: value('Choices'), EnumerationValues: [value('A'), value('B')] },
    { Name: value('Nested'), HasProperties: [{ Name: value('Code'), NominalValue: value('<code>') }] },
    { Name: value('Range'), LowerBoundValue: value(0), UpperBoundValue: value(5) },
    { Name: value('Curve'), DefiningValues: [value(1), value(2)], DefinedValues: [value(3), value(4)] },
    { Name: value('Reference'), PropertyReference: ref(12345) },
  ] });
  const properties = new Map(entries);
  assert.equal(properties.get('Review.Complete'), 'false');
  assert.equal(properties.get('Review.Zero'), '0');
  assert.equal(properties.get('Review.Missing'), '(not set)');
  assert.equal(properties.get('Review.Choices.EnumerationValues'), 'A; B');
  assert.equal(properties.get('Review.Nested.Code'), '<code>');
  assert.equal(properties.get('Review.Range.LowerBoundValue'), '0');
  assert.equal(properties.get('Review.Range.UpperBoundValue'), '5');
  assert.equal(properties.get('Review.Curve.DefinedValues'), '3; 4');
  assert(!entries.some(([, text]) => text.includes('12345')));
  assert.deepEqual(definitionEntries({ Name: value('Qto_Beam'), Quantities: [{ Name: value('Length'), LengthValue: { _representationValue: 12.5 } }] }), [['Qto_Beam.Length', '12.5']]);
  assert.deepEqual(attributes({ type: 100, expressID: 1, GlobalId: value('abc'), OwnerHistory: ref(54321), Name: value('Beam') }, 'Element'), [['Element.GlobalId', 'abc'], ['Element.Name', 'Beam']]);
});

test('search combines words across property names and values and keeps GlobalIds searchable', () => {
  const record = (guid, type, entries) => ({ guid, type, entries, searchText: [guid, type, ...entries.map(entry => entry.join(' '))].join('\n').toLocaleLowerCase() });
  const door = record('Abc_GUID', 'IFCDOOR', [['Element.Name', 'Lobby door'], ['Pset_DoorCommon.FireRating', '2 HR']]);
  const beam = record('Beam_GUID', 'IFCBEAM', [['Element.Name', 'Lobby beam'], ['Material.Name', 'Steel']]);
  const records = [door, beam];
  assert.deepEqual(searchRecords(records, '  FIRErating 2 hr  '), [door]);
  assert.deepEqual(searchRecords(records, 'lobby steel'), [beam]);
  assert.deepEqual(searchRecords(records, 'abc_guid'), [door]);
  assert.deepEqual(searchRecords(records, ''), records);
  assert.deepEqual(searchRecords(records, 'unknown'), []);
});

test('search isolates matches, hides non-matches and restores the model on an empty search without selecting components', async () => {
  const states = [], search = { value: ' FIRErating 2 hr ' }, status = {};
  const records = [{ guid: 'Door_GUID', searchText: 'lobby door pset_doorcommon.firerating 2 hr' }, { guid: 'Beam_GUID', searchText: 'lobby beam steel' }];
  const { searchModel } = make({ records, search, status, api: { async IsModelOpen() { return true; } }, modelID: 1,
    async applyState(title, state) { states.push(state); } });
  await searchModel();
  assert.deepEqual(states.at(-1), { visibility: { defaultVisibility: false, exceptions: ['Door_GUID'] } });
  assert.equal(status.textContent, '1 matching components');
  search.value = 'no-such-value';
  await searchModel();
  assert.deepEqual(states.at(-1), { visibility: { defaultVisibility: false, exceptions: [] } });
  assert.equal(status.textContent, '0 matching components');
  search.value = '  ';
  await searchModel();
  assert.deepEqual(states.at(-1), { visibility: { defaultVisibility: true, exceptions: [] } });
  assert.equal(status.textContent, '2 searchable components');
});

test('the model index includes every product and joins occurrence, inherited type, quantity, material and classification data', async () => {
  const beam = { expressID: 1, type: 100, GlobalId: value('Beam_GUID'), Name: value('Lobby beam') };
  const door = { expressID: 2, type: 101, GlobalId: value('Door_GUID'), Name: value('Lobby door') };
  const rows = [
    beam, door,
    { expressID: 3, type: 102, GlobalId: value('Space_GUID'), Name: value('Lobby space') },
    { expressID: 10, RelatedObjects: [ref(1), ref(2)], RelatingPropertyDefinition: ref(20) },
    { expressID: 11, RelatedObjects: [ref(1)], RelatingPropertyDefinition: ref(21) },
    { expressID: 12, RelatedObjects: [ref(1)], RelatingType: ref(30) },
    { expressID: 20, Name: value('Pset_Review'), HasProperties: [{ Name: value('Complete'), NominalValue: value(false) }] },
    { expressID: 21, Name: value('Qto_Beam'), Quantities: [{ Name: value('Length'), LengthValue: value(12.5) }] },
    { expressID: 30, Name: value('Steel beam type'), HasPropertySets: [ref(31)] },
    { expressID: 31, Name: value('Pset_BeamCommon'), HasProperties: [{ Name: value('FireRating'), NominalValue: value('2 HR') }] },
    { expressID: 40, RelatedObjects: [ref(30)], RelatingMaterial: ref(41) },
    { expressID: 41, Name: value('Steel') },
    { expressID: 50, RelatedObjects: [ref(1)], RelatingClassification: ref(51) },
    { expressID: 51, Identification: value('B1010') },
  ];
  const byId = new Map(rows.map(row => [row.expressID, row]));
  const ids = { IFCPRODUCT: [1, 2, 3], IFCRELDEFINESBYPROPERTIES: [10, 11], IFCRELDEFINESBYTYPE: [12],
    IFCRELASSOCIATESMATERIAL: [40], IFCRELASSOCIATESCLASSIFICATION: [50] };
  const api = {
    GetTypeCodeFromName(name) { return name; },
    GetLineIDsWithType(model, type, subtypes) { assert.equal(model, 0); assert.equal(subtypes, true); const values = ids[type] ?? []; return { size: () => values.length, get: index => values[index], delete() {} }; },
    GetLines(model, ids) { return ids.map(id => byId.get(id)); },
    async GetNameFromTypeCode(code) { return { 100: 'IFCBEAM', 101: 'IFCDOOR', 102: 'IFCSPACE' }[code]; },
  };
  const { readSearchIndex } = make({ viewer: { async setMessage() {} } });
  const records = await readSearchIndex(api, 0);
  assert.equal(records.length, 3);
  assert.equal(searchRecords(records, 'firerating 2 hr')[0].guid, 'Beam_GUID');
  assert.equal(searchRecords(records, 'steel b1010 12.5')[0].guid, 'Beam_GUID');
  assert.equal(searchRecords(records, 'complete false').length, 2);
  assert.equal(searchRecords(records, 'space')[0].guid, 'Space_GUID');
});
