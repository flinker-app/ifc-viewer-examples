import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const html = readFileSync(new URL('../examples/bcf/index.html', import.meta.url), 'utf8');
const code = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];
const source = ts.createSourceFile('example.js', code, ts.ScriptTarget.Latest, true);
const loadFunction = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'load').getText(source);
const files = name => JSON.parse(source.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
  .find(node => node.name.getText(source) === name).initializer.getText(source));

test('BCF explorer imports the Architectural and MEP collection and retries only failed archives', async () => {
  const modelFiles = files('modelFiles'), sampleFiles = files('sampleFiles');
  const imported = new Set(), requests = [], messages = [];
  const retry = {}, document = { body: { dataset: {} } };
  const failed = [sampleFiles[0].name, sampleFiles.at(-1).name];
  let failing = true;
  const loadExampleFile = async (name, url, _load, size) => {
    requests.push({ name, url, size });
    if (failing && failed.includes(name)) throw new Error(name + ' interrupted');
  };
  const load = new Function('imported', 'retry', 'document', 'modelFiles', 'sampleFiles', 'loadExampleFile', 'viewer',
    loadFunction + '\nreturn load;')(imported, retry, document, modelFiles, sampleFiles, loadExampleFile,
    { setMessage: async message => messages.push(message) });
  await load();
  assert.deepEqual(requests, [...modelFiles, ...sampleFiles]);
  assert.equal(imported.size, 19);
  assert.equal(document.body.dataset.exampleState, 'error');
  assert.equal(retry.hidden, false);
  assert.ok(failed.every(name => messages[0].includes(name)));
  failing = false;
  await load();
  assert.deepEqual(requests.slice(21).map(file => file.name), failed);
  assert.equal(imported.size, 21);
  assert.equal(document.body.dataset.exampleState, 'loaded');
  assert.equal(retry.hidden, true);
  await load();
  assert.equal(requests.length, 23);
});

test('BCF startup retries failed imports without reopening successful files', async () => {
  const imported = new Set(), requests = [], messages = [];
  const retry = {}, document = { body: { dataset: {} } };
  let failing = true;
  const loadExampleFile = async name => {
    requests.push(name);
    if (name === 'First.bcf' && failing) throw new Error('First.bcf download interrupted');
  };
  const load = new Function('imported', 'retry', 'document', 'modelFiles', 'sampleFiles', 'loadExampleFile', 'viewer',
    loadFunction + '\nreturn load;')(imported, retry, document, [{ name: 'Model.ifc' }],
    [{ name: 'First.bcf' }, { name: 'Second.bcf' }], loadExampleFile,
    { setMessage: async message => messages.push(message) });
  await load();
  assert.deepEqual(requests, ['Model.ifc', 'First.bcf', 'Second.bcf']);
  assert.equal(document.body.dataset.exampleState, 'error');
  assert.equal(retry.hidden, false);
  assert.match(messages[0], /First.bcf/);
  failing = false;
  await load();
  assert.deepEqual(requests, ['Model.ifc', 'First.bcf', 'Second.bcf', 'First.bcf']);
  assert.equal(document.body.dataset.exampleState, 'loaded');
  assert.equal(retry.hidden, true);
  await load();
  assert.equal(requests.length, 4);
});
