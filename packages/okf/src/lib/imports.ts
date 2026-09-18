import type Parser from 'tree-sitter';

import type { ExtractedImport } from './types/interface.js';

type Node = Parser.SyntaxNode;

/** Extracts static and literal runtime imports from queried TS/JS nodes. */
export const extractImports = (nodes: readonly Node[]): ExtractedImport[] => {
  const imports: ExtractedImport[] = [];

  for (const node of nodes) {
    if (node.type === 'import_statement') {
      const source = node.childForFieldName('source');

      if (source) {
        imports.push({ source: literal(source), symbols: importSymbols(node) });
      } else {
        const requireClause = node.namedChildren.find(
          ({ type }) => type === 'import_require_clause',
        );
        const requireSource = requireClause?.childForFieldName('source');

        const name = requireClause?.namedChildren.find(
          ({ type }) => type === 'identifier',
        );

        if (requireSource) {
          imports.push({
            source: literal(requireSource),
            symbols: name ? [`default as ${name.text}`] : [],
          });
        }
      }

      continue;
    }

    if (node.type !== 'call_expression') {
      continue;
    }

    const called = node.childForFieldName('function');
    const args = node.childForFieldName('arguments');
    const source = args?.namedChildren[0];

    if (!called || !source || source.type !== 'string') {
      continue;
    }

    if (called.type !== 'import' && called.text !== 'require') {
      continue;
    }

    imports.push({
      source: literal(source),
      symbols: called.text === 'require' ? requireSymbols(node) : [],
    });
  }

  return imports;
};

const importSymbols = (statement: Node): readonly string[] => {
  const clause = statement.namedChildren.find(
    ({ type }) => type === 'import_clause',
  );

  if (!clause) {
    return [];
  }

  const symbols: string[] = [];

  const defaultImport = clause.namedChildren.find(
    ({ type }) => type === 'identifier',
  );

  if (defaultImport) {
    symbols.push(`default as ${defaultImport.text}`);
  }

  for (const namespace of descendants(clause, 'namespace_import')) {
    symbols.push(normalize(namespace.text));
  }

  for (const specifier of descendants(clause, 'import_specifier')) {
    const name = specifier.childForFieldName('name')?.text;

    if (!name) {
      continue;
    }

    const alias = specifier.childForFieldName('alias')?.text;
    const symbol = alias ? `${name} as ${alias}` : name;

    symbols.push(
      /^type\b/u.test(specifier.text.trim()) ? `type ${symbol}` : symbol,
    );
  }

  const typeOnly = /^import\s+type\b/u.test(statement.text);

  return unique(
    symbols.map((symbol) => (typeOnly ? `type ${symbol}` : symbol)),
  );
};

const requireSymbols = (call: Node): readonly string[] => {
  let current: Node | null = call;

  while (current && current.parent?.type !== 'variable_declarator') {
    current = current.parent;
  }

  const binding = current?.parent?.childForFieldName('name');

  if (!binding) {
    return [];
  }

  return binding.type === 'identifier'
    ? [`default as ${binding.text}`]
    : [normalize(binding.text)];
};

export const literal = (node: Node): string => node.text.slice(1, -1);

const descendants = (node: Node, type: string): readonly Node[] =>
  node.descendantsOfType(type);

const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim();

const unique = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].sort(compare);

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
