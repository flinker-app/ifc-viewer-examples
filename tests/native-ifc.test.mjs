import test from 'node:test';
import assert from 'node:assert/strict';
import { withIfcModel, queryType, dms, correctSampleGeoreference, correctSampleCrs } from '../scripts/example-ifc.mjs';
import { createHash } from 'node:crypto';
import { readNativeEntities } from '../scripts/native-ifc-probe.mjs';

test('browser probes close their own model and preserve an initialized host API', async () => {
  for (const hostInitialized of [false, true]) for (const fails of [false, true]) {
    let initialized = hostInitialized;
    const calls = [], openModels = new Set(hostInitialized ? [7] : []);
    const api = {
      GetVersion() { if (!initialized) throw new Error('Not initialized'); return 'test'; },
      async Init() { initialized = true; calls.push('init'); },
      OpenModel() { openModels.add(17); return 17; },
      GetTypeCodeFromName: name => name,
      GetLineIDsWithType: () => ({ size: () => 2, get: index => 100 + index, delete() { calls.push('vector'); } }),
      GetLines(_id, ids) { if (fails) throw new Error('Query failed'); return ids.map(expressID => ({ expressID })); },
      CloseModel(id) { openModels.delete(id); calls.push('close'); },
      Dispose() { openModels.clear(); initialized = false; calls.push('dispose'); },
    };
    const document = { getElementById: () => ({ textContent: JSON.stringify({ assets: [{ format: 'IFC', url: 'https://example.com/source.ifc' }] }) }) };
    const page = { evaluate(fn, args) {
      return new Function('window', 'document', 'fetch', 'args', `return (${fn.toString()})(args);`)(
        { exampleViewer: { IfcAPI: api } }, document, async () => new Response(new Uint8Array([1, 2])), args);
    } };
    const pending = readNativeEntities(page, 'IFCWALL', 1);
    if (fails) await assert.rejects(pending, /Query failed/);
    else assert.deepEqual(await pending, { total: 2, rows: [{ expressID: 100 }] });
    assert.deepEqual([...openModels], hostInitialized ? [7] : []);
    assert.equal(initialized, hostInitialized);
    assert.deepEqual(calls, hostInitialized ? ['vector', 'close'] : ['init', 'vector', 'close', 'dispose']);
  }
});

test('native example reads own their model and dispose on success and query failure', async () => {
  for (const fails of [false, true]) {
    const calls = [];
    const api = {
      async Init() { calls.push('init'); },
      OpenModel(bytes) { assert.deepEqual([...bytes], [1, 2]); calls.push('open'); return 0; },
      CloseModel(id) { assert.equal(id, 0); calls.push('close'); },
      Dispose() { calls.push('dispose'); },
    };
    const read = new Function('viewer', `return ${withIfcModel.toString()};`)({ IfcAPI: Promise.resolve(api) });
    const pending = read(new Blob([new Uint8Array([1, 2])]), (native, id) => {
      assert.equal(native, api); assert.equal(id, 0); calls.push('read');
      if (fails) throw new Error('Query failed');
      return 'data';
    });
    if (fails) await assert.rejects(pending, /Query failed/);
    else assert.equal(await pending, 'data');
    assert.deepEqual(calls, ['init', 'open', 'read', 'close', 'dispose']);
  }
});

test('native example queries release vectors even when entity decoding fails', async () => {
  for (const fails of [false, true]) {
    let freed = false;
    const api = {
      GetTypeCodeFromName: name => name,
      GetLineIDsWithType: () => ({ size: () => 2, get: index => index + 10, delete() { freed = true; } }),
      GetLines(modelID, ids) { if (fails) throw new Error('Decode failed'); return ids.map(expressID => ({ expressID })); },
    };
    const pending = queryType(api, 0, 'IFCWALL');
    if (fails) await assert.rejects(pending, /Decode failed/);
    else assert.deepEqual(await pending, [{ expressID: 10 }, { expressID: 11 }]);
    assert.equal(freed, true);
  }
});

test('S1 edits native georeferencing records and preserves quoted property values', async () => {
  const project = { expressID: 1, OwnerHistory: { type: 5, value: 2 } };
  const site = { expressID: 3, ObjectPlacement: { type: 5, value: 4 } };
  const context = { expressID: 5, type: 'IFCGEOMETRICREPRESENTATIONCONTEXT', CoordinateSpaceDimension: { value: 3 }, Precision: { value: '0.01' } };
  const subcontext = { expressID: 6, type: 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT' };
  const quoted = { expressID: 7, NominalValue: { value: "'s Gravesandestraat" } };
  const groups = { IFCPROJECT: [project], IFCSITE: [site], IFCGEOMETRICREPRESENTATIONCONTEXT: [context, subcontext], IFCPROPERTYSINGLEVALUE: [quoted] };
  const written = [], bytes = new Uint8Array([1, 2]);
  const api = {
    GetModelSchema: () => 'IFC2X3', GetTypeCodeFromName: name => name,
    CreateIfcType: (_id, name, value) => ({ name, value }),
    CreateIfcEntity: (_id, name, ...args) => ({ type: name, args }),
    CreateIFCGloballyUniqueId: () => ({ value: 'generated-guid' }),
    WriteLine: (_id, line) => written.push(line), SaveModel: () => bytes,
  };
  const correction = new Function('withIfcModel', 'queryType', 'dms', `return ${correctSampleGeoreference.toString()};`)(
    async (blob, edit) => edit(api, 0), async (_api, _model, name) => groups[name], dms);
  const geo = { latitude: 51.44647556666666, longitude: 5.460151696111112, eastings: 160071.5, northings: 384156.5,
    xAxisAbscissa: .6379617540893054, xAxisOrdinate: -.7700680491484481, scale: .001 };
  assert.equal(await correction(new Blob(), geo), bytes);
  assert.deepEqual(site.RefLatitude.map(value => value.value), [51, 26, 47, 312040]);
  assert.deepEqual(site.RefLongitude.map(value => value.value), [5, 27, 36, 546106]);
  assert.deepEqual(site.ObjectPlacement, { type: 5, value: 4 });
  assert.deepEqual(context.TrueNorth.args[0], [-geo.xAxisOrdinate, geo.xAxisAbscissa]);
  assert.equal(context.CoordinateSpaceDimension.value, 3);
  assert.equal(context.Precision.value, .01);
  assert(!written.includes(subcontext));
  assert(written.includes(quoted), 'native WriteLine avoids the upstream SaveModel apostrophe regression');
  const sets = written.filter(line => line.type === 'IFCRELDEFINESBYPROPERTIES').map(line => line.args[5]);
  const conversion = sets.find(set => set.args[2].value === 'ePSet_MapConversion');
  assert.deepEqual(Object.fromEntries(conversion.args[4].map(property => [property.args[0].value, property.args[2].value])), {
    Eastings: geo.eastings, Northings: geo.northings, OrthogonalHeight: 0,
    XAxisAbscissa: geo.xAxisAbscissa, XAxisOrdinate: geo.xAxisOrdinate, Scale: geo.scale,
  });
  assert.equal(sets.find(set => set.args[2].value === 'ePSet_ProjectedCRS').args[4].find(property => property.args[0].value === 'VerticalDatum').args[2].value, 'LOCAL');
});

test('the bridge validates its source and changes only the native CRS vertical datum', async () => {
  const file = new Blob(['verified source']), bytes = new Uint8Array([1, 2]);
  const correction = { sha256: createHash('sha256').update('verified source').digest('hex'), expectedName: 'EPSG:28992', verticalDatum: 'NAP' };
  const crs = { expressID: 6789, Name: { value: correction.expectedName }, VerticalDatum: null, MapUnit: { type: 5, value: 45 } };
  let opened = 0, written, freed = false;
  const api = { GetTypeCodeFromName: name => name, CreateIfcType: (_id, name, value) => ({ name, value }),
    GetLineIDsWithType(_id, name) { assert.equal(name, 'IFCPROJECTEDCRS'); return { size: () => 1, get: () => crs.expressID, delete() { freed = true; } }; },
    GetLines(_id, ids) { assert.deepEqual(ids, [6789]); return [crs]; },
    WriteLine: (_id, line) => { written = line; }, SaveModel: () => bytes };
  const correct = new Function('withIfcModel', `return ${correctSampleCrs.toString()};`)(async (blob, edit) => { opened++; return edit(api, 0); });
  await assert.rejects(correct(new Blob(['different source']), correction), /source differs/);
  assert.equal(opened, 0, 'unverified bytes never initialize a native model');
  assert.equal(await correct(file, correction), bytes);
  assert.equal(written, crs);
  assert.equal(freed, true);
  assert.equal(crs.VerticalDatum.value, 'NAP');
  assert.deepEqual(crs.MapUnit, { type: 5, value: 45 });
});
