import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const canonicalOrigin = 'https://viewer.flinker.app';
export const escapeHtml = value => String(value).replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
export const decodeHtml = value => value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code) => {
  if (code[0] === '#') return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
  return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[code.toLowerCase()] ?? entity;
});
export function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map(([, name, double, single]) => [name.toLowerCase(), decodeHtml(double ?? single)]));
}
// Documentation stays authored beside the runnable demo, without occupying its UI.
// Consumers can render these HTML fragments around an iframe of example.href.
export function readDocumentation(html, id) {
  return new RegExp(`<template\\b(?=[^>]*\\bid=["']${id}["'])[^>]*>([\\s\\S]*?)<\\/template>`, 'i')
    .exec(html)?.[1].trim() ?? '';
}
export function readExample(html, path) {
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? '';
  const title = decodeHtml(/<title\b[^>]*>([^<]*)<\/title>/i.exec(head)?.[1] ?? '').trim();
  const descriptions = [...head.matchAll(/<meta\b[^>]*>/gi)].map(match => attributes(match[0])).filter(meta => meta.name === 'description');
  if (!title || descriptions.length !== 1 || !descriptions[0].content?.trim()) throw new Error(`${path}: provide one title and one meta description`);
  const block = /<script\b(?=[^>]*\bid=["']example-data["'])[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!block) throw new Error(`${path}: missing inline example-data`);
  const data = JSON.parse(block[1]);
  if (Object.hasOwn(data, 'title') || Object.hasOwn(data, 'description')) throw new Error(`${path}: title and description belong in HTML tags only`);
  if (!data.category || !Array.isArray(data.formats) || !Array.isArray(data.capabilities) || !['Developer integration', 'BIM workflow'].includes(data.audience)) {
    throw new Error(`${path}: missing category, formats, capabilities or audience`);
  }
  return { ...data, id: path.split('/')[1], path, title, description: descriptions[0].content.trim(),
    guideHtml: readDocumentation(html, 'example-guide'), noticesHtml: readDocumentation(html, 'example-notices'),
    thumbnail: `/${dirname(path).replaceAll('\\', '/')}/thumbnail.webp`, href: `/${path}` };
}
export function readExamples(root = repository) {
  return readdirSync(resolve(root, 'examples'), { withFileTypes: true }).filter(entry => entry.isDirectory())
    .map(entry => {
      const path = `examples/${entry.name}/index.html`;
      return readExample(readFileSync(resolve(root, path), 'utf8'), path);
    }).sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.id.localeCompare(b.id));
}
export function renderSeo(example) {
  const url = canonicalOrigin + example.href;
  const image = canonicalOrigin + example.thumbnail;
  const article = { '@context': 'https://schema.org', '@type': 'TechArticle', headline: example.title,
    description: example.description, url, mainEntityOfPage: url, image, inLanguage: 'en',
    author: { '@type': 'Organization', name: 'Flinker', url: 'https://www.flinker.app/' } };
  return `<!-- generated:example-seo:start -->
  <link rel="canonical" href="${escapeHtml(url)}">
  <meta name="robots" content="index,follow">
  <meta property="og:title" content="${escapeHtml(example.title)}">
  <meta property="og:description" content="${escapeHtml(example.description)}">
  <meta property="og:url" content="${escapeHtml(url)}"><meta property="og:type" content="article">
  <meta property="og:site_name" content="Flinker IFC Viewer"><meta property="og:image" content="${escapeHtml(image)}">
  <meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(example.title)}">
  <meta name="twitter:description" content="${escapeHtml(example.description)}"><meta name="twitter:image" content="${escapeHtml(image)}">
  <script type="application/ld+json">${JSON.stringify(article).replaceAll('<', '\\u003c')}</script>
  <!-- generated:example-seo:end -->`;
}
export function syncPage(html, example) {
  const block = /<!-- generated:example-seo:start -->[\s\S]*?<!-- generated:example-seo:end -->/;
  if (!block.test(html)) throw new Error(`${example.path}: missing generated SEO region`);
  return html.replace(block, renderSeo(example))
    .replace(/(<([\w-]+)\b[^>]*\bdata-example-title(?:=["'][^"']*["'])?[^>]*>)[\s\S]*?(<\/\2>)/g,
      (_match, open, _tag, close) => open + escapeHtml(example.title) + close)
    .replace(/(<p\b[^>]*\bdata-example-description(?:=["'][^"']*["'])?[^>]*>)[\s\S]*?(<\/p>)/g,
      (_match, open, close) => open + escapeHtml(example.description) + close);
}
export function createCatalog(examples) {
  const assets = new Map();
  for (const example of examples) for (const asset of example.assets ?? []) {
    const stored = assets.get(asset.id);
    // Shared source bytes must agree; source-page notice anchors may differ.
    if (stored && (stored.url !== asset.url || stored.bytes !== asset.bytes)) throw new Error(`Conflicting embedded asset: ${asset.id}`);
    if (!stored) assets.set(asset.id, asset);
  }
  const cards = examples.map(example => ({ id: example.id, path: example.path, href: example.href, title: example.title,
    category: example.category, description: example.description, capabilities: example.capabilities,
    formats: example.formats, assetIds: example.viewer?.assetIds ?? [], steps: example.viewer?.steps ?? [],
    thumbnail: example.thumbnail, audience: example.audience, guideHtml: example.guideHtml, noticesHtml: example.noticesHtml }));
  const samples = examples.filter(example => example.viewer).map(example => ({ id: example.id, ...example.viewer }));
  return { _generated: 'Generated from examples/*/index.html by npm run generate. Do not edit.', assets: [...assets.values()], samples, examples: cards };
}
export function renderReadmeTable(examples) {
  const text = value => escapeHtml(value).replace(/([\\`*_[\]|])/g, '\\$1').replace(/[\r\n]+/g, ' ');
  const rows = examples.map(example => {
    const url = canonicalOrigin + example.href;
    const preview = `<img src="${example.thumbnail.slice(1)}" alt="Preview of ${escapeHtml(example.title).replaceAll('|', '&#124;').replace(/[\r\n]+/g, ' ')}" width="480">`;
    const labels = [...new Set([example.category, ...example.formats, ...example.capabilities])].map(text).join(', ');
    return `| [${preview}](${url}) | [${text(example.title)}](${url})<br>[Source](${example.path})<br>${labels}<br>${text(example.audience)} | ${text(example.description)} |`;
  });
  return ['| Preview | Example | Description |', '| --- | --- | --- |', ...rows].join('\n');
}
export function generate({ root = repository, check = false } = {}) {
  const examples = readExamples(root);
  const stale = [];
  function update(path, text) {
    const file = resolve(root, path);
    let current;
    try { current = readFileSync(file, 'utf8').replaceAll('\r\n', '\n'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    text = text.replaceAll('\r\n', '\n');
    if (current === text) return;
    if (check) stale.push(path);
    else writeFileSync(file, text);
  }
  for (const example of examples) {
    const html = syncPage(readFileSync(resolve(root, example.path), 'utf8'), example);
    update(example.path, html);
    example.guideHtml = readDocumentation(html, 'example-guide');
    example.noticesHtml = readDocumentation(html, 'example-notices');
  }
  update('catalog/catalog.json', JSON.stringify(createCatalog(examples), null, 2) + '\n');
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
  update('README.md', readme.replace(/<!-- generated:examples:start -->[\s\S]*?<!-- generated:examples:end -->/,
    `<!-- generated:examples:start -->\n\n${renderReadmeTable(examples)}\n\n<!-- generated:examples:end -->`));
  if (stale.length) throw new Error(`Generated metadata is out of date: ${stale.join(', ')}. Run npm run generate.`);
  return examples;
}
