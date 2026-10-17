import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkPublicApi } from '../scripts/public-api-check.mjs';
import { checkStandalone } from '../scripts/standalone-check.mjs';

test('documented SDK workflows have canonical standalone public-API examples', () => {
  const targets = ['bcf', 'bcf-annotations', 'selection', 'bcf-coloring', 'bcf-visibility', 'bcf-clipping', 's1-ids']
    .map(id => `examples/${id}/index.html`);
  for (const path of targets) {
    const html = readFileSync(new URL('../' + path, import.meta.url), 'utf8');
    checkStandalone(path, html);
    checkPublicApi(path, html);
    assert.doesNotMatch(html, /githubusercontent\.com\/(?:media\/)?flinker-app\//);
  }
});
