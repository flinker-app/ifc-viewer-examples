import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { createCatalog, generate, readExample, readExamples, repository, syncPage } from '../scripts/example-metadata.mjs';

const page = (title = 'Review a model', description = 'Inspect a model and its properties.') => `<!doctype html><html><head>
<title>${title}</title><meta content="${description}" name="description">
<!-- generated:example-seo:start --><!-- generated:example-seo:end -->
<script id="example-data" type="application/json">{"category":"Buildings","formats":["IFC"],"capabilities":["Properties"],"audience":"BIM workflow"}</script>
</head><body><template id="example-guide"><h1 data-example-title></h1><p data-example-description></p><p>Choose a <strong>wall</strong>.</p></template><template id="example-notices"><p>Model credit <a href="https://example.com/license">License</a></p></template></body></html>`;

test('one HTML edit updates the catalog, README table, SEO and extracted documentation without a root HTML page', t => {
  const prefix = join(tmpdir(), 'ifc-example-metadata-');
  const root = mkdtempSync(prefix);
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(prefix)) && resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true });
  });
  mkdirSync(join(root, 'examples', 'model'), { recursive: true });
  mkdirSync(join(root, 'catalog'));
  const source = join(root, 'examples/model/index.html');
  writeFileSync(source, page());
  writeFileSync(join(root, 'README.md'), '<!-- generated:examples:start --><!-- generated:examples:end -->');
  generate({ root });
  writeFileSync(source, readFileSync(source, 'utf8').replace('<title>Review a model</title>', '<title>Review walls &amp; slabs</title>')
    .replace('content="Inspect a model and its properties." name="description"', 'content="Inspect &quot;wall&quot; properties." name="description"'));
  assert.throws(() => generate({ root, check: true }), /out of date/);
  generate({ root });
  assert.doesNotThrow(() => generate({ root, check: true }));
  const html = readFileSync(source, 'utf8');
  const catalog = JSON.parse(readFileSync(join(root, 'catalog/catalog.json'), 'utf8'));
  assert.equal(catalog.examples[0].title, 'Review walls & slabs');
  assert.equal(catalog.examples[0].description, 'Inspect "wall" properties.');
  assert.match(html, /<h1 data-example-title>Review walls &amp; slabs<\/h1>/);
  assert.match(catalog.examples[0].guideHtml, /Choose a <strong>wall<\/strong>/);
  assert.match(catalog.examples[0].guideHtml, /Review walls &amp; slabs/);
  assert.match(catalog.examples[0].noticesHtml, /https:\/\/example.com\/license/);
  assert.match(html, /property="og:title" content="Review walls &amp; slabs"/);
  assert.match(html, /rel="canonical" href="https:\/\/viewer.flinker.app\/examples\/model\/index.html"/);
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  assert.ok(readme.includes('| Preview | Example | Description |'));
  assert.ok(readme.includes('[Review walls &amp; slabs](https://viewer.flinker.app/examples/model/index.html)'));
  assert.ok(readme.includes('[<img src="examples/model/thumbnail.webp" alt="Preview of Review walls &amp; slabs" width="480">](https://viewer.flinker.app/examples/model/index.html)'));
  assert.ok(readme.includes('[Source](examples/model/index.html)'));
  assert.ok(readme.includes('Inspect &quot;wall&quot; properties.'));
  assert.equal(existsSync(join(root, 'index.html')), false);
});

test('rejects duplicated authored metadata and ambiguous meta descriptions', () => {
  assert.throws(() => readExample(page().replace('"category":', '"title":"duplicate","category":'), 'examples/test/index.html'), /HTML tags only/);
  assert.throws(() => readExample(page().replace('</head>', '<meta name="description" content="duplicate"></head>'), 'examples/test/index.html'), /one meta description/);
});

test('sample settings reference canonical examples without duplicating documentation', () => {
  const catalog = createCatalog(readExamples());
  for (const settings of catalog.samples) {
    assert.ok(catalog.examples.some(example => example.id === settings.id));
    for (const key of ['title', 'description', 'guideHtml', 'noticesHtml', 'thumbnail', 'href']) {
      assert.equal(Object.hasOwn(settings, key), false, `${settings.id}: duplicated ${key}`);
    }
  }
});

test('every public example provides its own complete metadata, documentation and notices', () => {
  const examples = readExamples();
  const catalog = createCatalog(examples);
  assert.equal(catalog.examples.length, examples.length);
  for (const example of examples) {
    const html = readFileSync(resolve(repository, example.path), 'utf8');
    assert.equal(syncPage(html, example).replaceAll('\r\n', '\n'), html.replaceAll('\r\n', '\n'), example.path);
    assert.match(html, /<template id="example-guide">/);
    assert.match(html, /<template id="example-notices">/);
    assert.ok(example.guideHtml && example.noticesHtml, example.path);
    assert.equal(readdirSync(resolve(repository, 'examples', example.id), { withFileTypes: true })
      .filter(entry => entry.isFile()).some(entry => /\.(md|ids|json|txt|mjs)$/.test(entry.name)), false, example.path);
    const article = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1]);
    assert.equal(article.headline, example.title);
    assert.equal(article.description, example.description);
    assert.ok(html.includes('data-example-title'));
  }
});
