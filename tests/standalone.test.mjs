import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStandalone } from '../scripts/standalone-check.mjs';
import configuration from '../viewer-sdk.config.json' with { type: 'json' };

const page = body => `<script type="module">import { Viewer } from '${configuration.url}'; ${body}</script>`;
test('allows inline code, embedded IDS and pinned CDN dependencies', () => {
  assert.doesNotThrow(() => checkStandalone('example.html', page("await fetch('data:application/xml,<ids/>');")));
});

test('rejects unused helpers, including helpers called only by other unused functions', () => {
  assert.throws(() => checkStandalone('example.html', page('function scalar(value) { return value; } function unused() { return scalar(1); }')), /unused example helpers: scalar, unused/);
  assert.doesNotThrow(() => checkStandalone('example.html', page('function scalar(value) { return value; } async function load() { return scalar(1); } await load();')));
});
test('rejects local helpers and styles even when the files exist in the repo', () => {
  assert.throws(() => checkStandalone('example.html', page("import { helper } from './shared/helper.js';")), /local modules/);
  assert.throws(() => checkStandalone('example.html', '<link rel="stylesheet" href="../shared/style.css">' + page('')), /local files/);
});
test('rejects local sample requests and mismatched SDK versions', () => {
  assert.throws(() => checkStandalone('example.html', page("await fetch('/examples/s1-ids/s1-information-quality.ids');")), /repository files/);
  assert.throws(() => checkStandalone('example.html', page('').replace(configuration.url, 'https://cdn.flinker.app/ifc-viewer/v3.0.0/ifc-viewer.es.js')), /does not match/);
});
