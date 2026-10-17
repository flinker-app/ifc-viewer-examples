import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPublishedSpecifications } from '../scripts/published-sdk.mjs';

const { ids } = await loadPublishedSpecifications();
test('s1-ids embeds the current IDS source and passes published SDK load/save/validation', async () => {
  const html = readFileSync(new URL('../examples/s1-ids/index.html', import.meta.url), 'utf8');
  const urls = [...html.matchAll(/data:application\/xml;charset=utf-8,([^"\s]+)/g)];
  assert.ok(urls.length);
  const source = decodeURIComponent(urls[0][1]);
  for (const url of urls) assert.equal(decodeURIComponent(url[1]), source);
  const document = await ids.load(source);
  assert.equal(document.schema, 'ids-1.0/ids');
  const specs = document.root.content.find(child => child.name === 'specifications').content.filter(child => child.name === 'specification');
  assert.equal(specs.length, 2);
  const fireRating = specs.find(spec => spec.attributes.identifier === 'S1-WALL-FIRE-RATING');
  assert.ok(fireRating, 'Include the wall fire-rating information check');
  const property = fireRating.content.find(child => child.name === 'requirements').content.find(child => child.name === 'property');
  assert.equal(property.attributes.cardinality, 'required');
  assert.equal(property.attributes.dataType, 'IFCLABEL');
  assert.equal(property.content.find(child => child.name === 'propertySet').content[0].content[0], 'Pset_WallCommon');
  assert.equal(property.content.find(child => child.name === 'baseName').content[0].content[0], 'FireRating');
  assert.match(source, /<xs:minLength value="1"\/>/, 'Empty fire-rating values must fail');
  const output = await ids.save(document);
  assert.deepEqual(await ids.validate(output), { valid: true, diagnostics: [] });
  assert.deepEqual(await ids.load(output), document);
});
