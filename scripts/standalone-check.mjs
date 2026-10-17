import ts from 'typescript';
import configuration from '../viewer-sdk.config.json' with { type: 'json' };

export function checkStandalone(path, text) {
  for (const match of text.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
    if (!/^(?:https:\/\/|data:|#)/.test(match[1])) throw new Error(`${path}: standalone examples cannot reference local files: ${match[1]}`);
  }
  let importsSdk = false;
  for (const match of text.matchAll(/<script\b[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const source = ts.createSourceFile(path, match[1], ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (source.parseDiagnostics.length) throw new Error(`${path}: invalid inline JavaScript: ${source.parseDiagnostics[0].messageText}`);
    function inspect(node) {
      if (ts.isImportDeclaration(node)) {
        const url = node.moduleSpecifier.text;
        if (!url.startsWith('https://')) throw new Error(`${path}: standalone examples cannot import local modules: ${url}`);
        if (url.includes('/ifc-viewer.es.js')) {
          if (url !== configuration.url) throw new Error(`${path}: SDK import does not match viewer-sdk.config.json`);
          importsSdk = true;
        }
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'fetch')) {
        const argument = node.arguments[0];
        if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) && !/^(?:https:\/\/|data:)/.test(argument.text)) {
          throw new Error(`${path}: standalone examples cannot load repository files: ${argument.text}`);
        }
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword && argument && ts.isStringLiteral(argument) && argument.text.includes('/ifc-viewer.es.js')) {
          if (argument.text !== configuration.url) throw new Error(`${path}: SDK import does not match viewer-sdk.config.json`);
          importsSdk = true;
        }
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
    const functions = source.statements.filter(ts.isFunctionDeclaration);
    const names = new Set(functions.map(node => node.name?.text).filter(Boolean));
    const dependencies = new Map(), used = new Set();
    function references(node, output) {
      if (ts.isIdentifier(node) && names.has(node.text)) output.add(node.text);
      ts.forEachChild(node, child => references(child, output));
    }
    for (const node of source.statements) {
      if (ts.isFunctionDeclaration(node)) {
        const calls = new Set();
        if (node.body) references(node.body, calls);
        dependencies.set(node.name?.text, calls);
      } else references(node, used);
    }
    const pending = [...used];
    while (pending.length) for (const name of dependencies.get(pending.pop()) ?? []) {
      if (!used.has(name)) { used.add(name); pending.push(name); }
    }
    const unused = [...names].filter(name => !used.has(name));
    if (unused.length) throw new Error(`${path}: unused example helpers: ${unused.join(', ')}`);
  }
  if (!importsSdk) throw new Error(`${path}: standalone examples must import the SDK directly from its CDN`);
}
