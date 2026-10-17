import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';

function example(id, bindings = {}, state = {}) {
  const html = readFileSync(new URL(`../examples/${id}/index.html`, import.meta.url), 'utf8');
  const code = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true);
  const functions = source.statements.filter(ts.isFunctionDeclaration);
  return new Function(...Object.keys(bindings),
    Object.entries(state).map(([name, value]) => `let ${name} = ${JSON.stringify(value)};`).join('\n') +
    functions.map(node => node.getText(source)).join('\n') +
    '\nreturn {' + functions.map(node => node.name.text).join(',') +
    ', state: () => ({' + Object.keys(state).join(',') + '})};')(...Object.values(bindings));
}
const value = value => ({ value });
const ref = value => ({ type: 5, value });
const guid = index => String(index) + 'a'.repeat(21);
const element = (expressID, index, Name = 'Element') => ({ expressID, GlobalId: value(guid(index)), Name: value(Name) });
function apiFixture(rows, name = 'test.ifc', schema = 'IFC4') {
  const calls = [];
  const byID = new Map(Object.values(rows).flat().map(row => [row.expressID, row]));
  return { calls,
    GetModelSchema() { return schema; },
    GetTypeCodeFromName(name) { return name; },
    GetLineIDsWithType(modelID, type, inherited) {
      assert.equal(modelID, 42); assert.equal(inherited, true); calls.push(type);
      const ids = (rows[type] ?? []).map(row => row.expressID);
      return { size: () => ids.length, get: index => ids[index], delete() {} };
    },
    GetLines(modelID, ids) { assert.equal(modelID, 42); return ids.map(id => byID.get(id)); },
    GetLine(modelID, id) { assert.equal(modelID, 42); return byID.get(id); },
  };
}
const viewer = api => ({ IfcAPI: api, async setMessage() {} });
const controls = { replaceChildren() {} };
const document = { getElementById: () => controls, createElement: () => ({ append() {} }), createTextNode: text => text };

test('all standalone modules avoid literal IFC identifiers and cached property tables', () => {
  for (const id of readdirSync(new URL('../examples/', import.meta.url))) {
    const html = readFileSync(new URL(`../examples/${id}/index.html`, import.meta.url), 'utf8');
    assert(!html.includes('id="element-records"'), id);
    const code = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
    const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true);
    function inspect(node) {
      if (ts.isStringLiteralLike(node)) assert(!/^[0-3][0-9A-Za-z_$]{21}$/.test(node.text), `${id}: embedded IFC identifier ${node.text}`);
      ts.forEachChild(node, inspect);
    }
    inspect(source);
  }
});

test('storey visibility follows nested spatial membership and includes unassigned elements', async () => {
  const api = apiFixture({ IFCELEMENT: [element(20, 0), element(21, 1), element(22, 2)] });
  api.properties = { async getSpatialStructure() { return { type: 'IFCPROJECT', children: [
    { expressID: 10, type: 'IFCBUILDINGSTOREY', Name: value('Queried storey'), children: [
      { type: 'IFCSPACE', children: [{ expressID: 20 }, { children: [{ expressID: 21 }, { expressID: 21 }] }] },
    ] },
  ] }; } };
  const ex = example('storey-visibility', { viewer: viewer(api), modelFiles: [{ name: 'test.ifc' }], controls, document }, { storeys: [] });
  await ex.readStoreys(api, 42);
  assert.deepEqual(ex.state().storeys.map(row => [row.name, row.ids]), [['Queried storey', [guid(0), guid(1)]], ['Unassigned', [guid(2)]]]);
  assert.deepEqual(ex.storeyState([]).visibility.exceptions, []);
  assert.deepEqual(ex.storeyState([1]).visibility.exceptions, [guid(2)]);
});

test('window widths use actual occurrence dimensions and project length units', async () => {
  const metre = { Name: value('METRE'), UnitType: value('LENGTHUNIT') };
  const foot = { UnitType: value('LENGTHUNIT'), ConversionFactor: { ValueComponent: value(.3048), UnitComponent: metre } };
  const api = apiFixture({
    IFCUNITASSIGNMENT: [{ expressID: 1, Units: [foot] }],
    IFCWINDOW: [
      {...element(20, 0), OverallWidth: value(1)}, {...element(21, 1), OverallWidth: value(2)},
      element(22, 2, 'Window missing dimensions'), {...element(23, 3), OverallWidth: value(0)},
    ],
  });
  const ex = example('window-width', { viewer: viewer(api), modelFiles: [{ name: 'test.ifc' }] }, { windows: [] });
  await ex.readWindows(api, 42);
  assert.deepEqual(ex.state().windows.map(row => [row.guid, row.widthMm]), [[guid(0), 304.8], [guid(1), 609.6]]);
  assert.deepEqual(ex.sizeState(500).coloring[0].ids, [guid(1)]);
  assert.throws(() => ex.siFactor({ Name: value('FOOT') }), /Unsupported/);
});

test('room footprint calculations stay inside concave rooms and respect nested rotated placements', () => {
  const ex = example('room-info');
  const shape = ex.polygonInfo([[0,0],[5,0],[5,1],[1,1],[1,5],[0,5],[0,0]]);
  assert.equal(shape.area, 9);
  assert(shape.position[0] <= 1 || shape.position[1] <= 1);
  assert(shape.radius > 0);
  const placement = { RelativePlacement: { Location: { Coordinates: [value(10),value(20),value(3)] }, RefDirection: { DirectionRatios: [value(0),value(1),value(0)] } }, PlacementRelTo: { RelativePlacement: { Location: { Coordinates: [value(100),value(200),value(4)] } } } };
  assert.deepEqual(ex.placementPoint(placement, [2,3,1]), [107,222,8]);
});

test('space areas convert explicit quantity units and distinguish zero from missing', () => {
  const ex = example('ifc-quantity-takeoff');
  const sets = area => [{ Name:value('GSA Space Areas'), Quantities:[{ Name:value('GSA BIM Area'), AreaValue:value(area) }] }];
  assert.equal(ex.spaceArea(sets(10), .09290304), .9290304);
  assert.equal(ex.spaceArea(sets(0), 1), 0);
  assert.equal(ex.spaceArea(sets(null), 1), null);
});

test('floor choices use queried names and world elevations, sorted independently of entity IDs', async () => {
  const metre = { Name:value('METRE'), UnitType:value('LENGTHUNIT') };
  const api = apiFixture({
    IFCUNITASSIGNMENT: [{ expressID:1, Units:[metre] }],
    IFCBUILDINGSTOREY: [
      { expressID:20, Name:value('Upper changed name'), ObjectPlacement:ref(70) },
      { expressID:30, Name:value('Lower changed name'), ObjectPlacement:ref(71) },
    ],
    IFCLOCALPLACEMENT: [
      { expressID:70, RelativePlacement:{ Location:{ Coordinates:[value(10),value(20),value(42)] } } },
      { expressID:71, RelativePlacement:{ Location:{ Coordinates:[value(10),value(20),value(17)] } } },
    ],
  });
  const ex=example('floorplans',{viewer:viewer(api)});
  const floors=await ex.readFloorPlans(api, 42);
  assert.deepEqual(floors.map(row=>[row.id,row.name,row.bottom,row.top]), [['30','Lower changed name',16.7,18.5],['20','Upper changed name',41.7,43.5]]);
});

test('room labels read changed entity names, profiles, placements and project identifiers', async () => {
  const metre={Name:value('METRE'),UnitType:value('LENGTHUNIT')};
  const api=apiFixture({
    IFCUNITASSIGNMENT:[{expressID:1,Units:[metre]}],
    IFCPROJECT:[element(2,2)],
    IFCBUILDINGSTOREY:[{expressID:10,Name:value('First Floor'),ObjectPlacement:ref(70)}],
    IFCSPACE:[{...element(20,0,'Changed room number'),LongName:value('Changed room name'),ObjectPlacement:ref(71),Representation:ref(80)}],
    IFCLOCALPLACEMENT:[
      {expressID:70,RelativePlacement:{Location:{Coordinates:[value(0),value(0),value(12)]}}},
      {expressID:71,RelativePlacement:{Location:{Coordinates:[value(100),value(200),value(12)]}}},
    ],
    IFCPRODUCTDEFINITIONSHAPE:[{expressID:80,Representations:[{Items:[{SweptArea:{XDim:value(3),YDim:value(2)}}]}]}],
  });
  api.properties={async getSpatialStructure(){return{expressID:10,type:'IFCBUILDINGSTOREY',Name:value('First Floor'),children:[{expressID:20,type:'IFCSPACE'}]};}};
  const model={name:'test.ifc'},heading={};
  const ex=example('room-info',{viewer:viewer(api),model,document:{querySelector:()=>heading}},{rooms:[],floor:null});
  await ex.readRooms(api, 42);
  const {rooms,floor}=ex.state();
  assert.equal(model.projectGuid,guid(2));
  assert.equal(floor.elevation,12);
  assert.equal(rooms.length,1);
  assert.equal(rooms[0].id,'Changed room number');
  assert.equal(rooms[0].name,'Changed room name');
  assert.equal(rooms[0].area,6);
  assert.deepEqual(rooms[0].min,[98.5,199]);
  assert.deepEqual(rooms[0].max,[101.5,201]);
  assert.equal(heading.textContent,'First Floor · 1 rooms');
});

test('selected table records resolve through loaded models and read actual properties', async () => {
  const api=apiFixture({IFCFLOWSEGMENT:[element(20,0,'A renamed duct')]});
  api.GetExpressIdFromGuid=async(_modelID,id)=>id===guid(0)?20:undefined;
  api.properties={
    async getSpatialStructure(){return{expressID:10,type:'IFCBUILDINGSTOREY',Name:value('Queried floor'),children:[{expressID:20}]};},
    async getPropertySets(){return[{HasProperties:[{Name:value('System Classification'),NominalValue:value('Queried system')}]}];},
  };
  const ex=example('view-table',{nativeApi:api, modelID:42});
  assert.deepEqual([...await ex.readSelectedRecords([guid(0),guid(1)])],[[guid(0),['A renamed duct','Queried floor','Queried system']]]);
  api.GetLine=async()=>({...element(20,0,'Another name')});
  assert.equal((await ex.readSelectedRecords([guid(0)])).get(guid(0))[0],'Another name');
  assert.deepEqual([...await ex.readSelectedRecords([])],[]);
});
