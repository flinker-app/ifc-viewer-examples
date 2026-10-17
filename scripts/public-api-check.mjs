import ts from 'typescript';
import contract from '../api-contract.json' with { type: 'json' };

export function checkPublicApi(path, text) {
  const sources = path.endsWith('.html')
    ? [...text.matchAll(/<script\b[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1])
    : [text];
  const forbidden = new Set([...contract.deprecatedExports, ...contract.unsupportedUiHelpers]);
  for (const code of sources) {
    const source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true);
    const viewerNames = new Set(['viewer']);
    const constructors = new Set(['Viewer']);
    const namespaceNames = new Map();
    const allowedMembers = new Set([...contract.instanceMethods, ...contract.instanceProperties]);
    const memberName = node => ts.isPropertyAccessExpression(node) ? node.name.text
      : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
    const isViewer = node => ts.isIdentifier(node) && viewerNames.has(node.text)
      || (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && memberName(node) === 'exampleViewer'
        && ts.isIdentifier(node.expression) && node.expression.text === 'window';
    const namespaceOf = node => ts.isIdentifier(node) ? namespaceNames.get(node.text) : undefined;
    // Track constructor/import renames and viewer aliases before checking their members.
    function collect(node) {
      if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const binding of node.importClause.namedBindings.elements) {
          if ((binding.propertyName ?? binding.name).text === 'Viewer') constructors.add(binding.name.text);
          const name = (binding.propertyName ?? binding.name).text;
          if (Object.hasOwn(contract.documentNamespaces, name)) namespaceNames.set(binding.name.text, name);
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const value = node.initializer;
        if (isViewer(value) || ts.isNewExpression(value) && ts.isIdentifier(value.expression) && constructors.has(value.expression.text)) viewerNames.add(node.name.text);
        const namespace = namespaceOf(value);
        if (namespace) namespaceNames.set(node.name.text, namespace);
      }
      ts.forEachChild(node, collect);
    }
    collect(source);
    function inspect(node) {
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const name = memberName(node);
        if (ts.isIdentifier(node.expression) && constructors.has(node.expression.text) && Object.hasOwn(contract.documentNamespaces, name))
          throw new Error(`${path}: import ${name} separately; ${node.expression.text}.${name} is outside the public document API`);

      }
      if (ts.isImportDeclaration(node) && /@ifc-lite\/bcf/.test(node.moduleSpecifier.text)) {
        throw new Error(`${path}: use the SDK bcf namespace instead of the external BCF library`);
      }
      if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isViewer(node.expression)) {
        const name = memberName(node);
        if (!allowedMembers.has(name)) throw new Error(`${path}: viewer.${name ?? '[dynamic member]'} is outside the example instance API; use BCF data or the viewer UI`);
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const namespace = namespaceOf(node.expression);
        if (namespace && !contract.documentNamespaces[namespace].includes(memberName(node))) {
          throw new Error(`${path}: ${namespace}.${memberName(node) ?? '[dynamic member]'} is outside the public document API`);
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isViewer(node.initializer)) {
        for (const binding of node.name.elements) {
          const name = (binding.propertyName ?? binding.name).text;
          if (!allowedMembers.has(name)) throw new Error(`${path}: viewer.${name} is outside the example instance API`);
        }
      }
      if (ts.isImportDeclaration(node) && /(?:^|\/)(?:sdk|ifc-viewer\.es)\.js(?:[?#].*)?$/.test(node.moduleSpecifier.text)) {
        const bindings = node.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings) || node.importClause?.name) throw new Error(`${path}: import named public SDK exports only`);
        for (const binding of bindings.elements) {
          const name = (binding.propertyName ?? binding.name).text;
          if (!contract.moduleExports.includes(name)) throw new Error(`${path}: unsupported or deprecated SDK export ${name}`);
        }
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && forbidden.has(node.expression.text)) {
        throw new Error(`${path}: deprecated or unsupported SDK call ${node.expression.text}`);
      }
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && ts.isIdentifier(node.initializer) && node.initializer.text === 'sdk') {
        for (const binding of node.name.elements) {
          const name = (binding.propertyName ?? binding.name).text;
          if (!contract.moduleExports.includes(name)) throw new Error(`${path}: unsupported SDK loader export ${name}`);
        }
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (/^[0-3][0-9A-Za-z_$]{21}$/.test(node.text)) {
          throw new Error(`${path}: query IFC identifiers from the loaded model instead of embedding workflow results`);
        }
        if (/(?:ifc-viewport|button\[name=|#toolbar|ifc-tab\[)/.test(node.text)) {
          throw new Error(`${path}: SDK toolbar/viewport selectors are not public APIs`);
        }
        if (contract.unsupportedDomEvents.includes(node.text)) {
          throw new Error(`${path}: SDK DOM event ${node.text} is unsupported in examples; use exposed services`);
        }
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
  }
}
