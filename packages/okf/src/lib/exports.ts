import type Parser from 'tree-sitter';

import { literal } from './imports.js';
import type { ExtractedImport, ModuleExports } from './types/interface.js';

type Node = Parser.SyntaxNode;

type Category = keyof Required<ModuleExports>;

type Sets = { readonly [Key in Category]: Set<string> };

type Declaration = {
  readonly category: Exclude<Category, 'methods' | 'reexports'>;
  readonly display: string;
  readonly members?: readonly string[];
};

/** Extracts ESM and CommonJS exports from queried TS/JS nodes. */
export const extractExports = (
  root: Node,
  nodes: readonly Node[],
  imports: ExtractedImport[],
): ModuleExports | undefined => {
  const declarations = declarationIndex(root);
  const exports = emptySets();

  for (const node of nodes.filter(({ type }) => type === 'export_statement')) {
    extractExport(node, declarations, exports, imports);
  }

  for (const node of nodes.filter(
    ({ type }) => type === 'assignment_expression',
  )) {
    extractCommonJs(node, declarations, exports);
  }

  return render(exports);
};

const extractExport = (
  statement: Node,
  declarations: ReadonlyMap<string, Declaration>,
  exports: Sets,
  imports: ExtractedImport[],
): void => {
  const sourceNode = statement.childForFieldName('source');

  const clause = statement.namedChildren.find(
    ({ type }) => type === 'export_clause',
  );

  if (sourceNode) {
    const symbols = reexportSymbols(statement, clause);

    imports.push({ source: literal(sourceNode), symbols });

    symbols.forEach((symbol) => exports.reexports.add(symbol));

    return;
  }

  const declaration = statement.childForFieldName('declaration');

  if (declaration) {
    addDeclaration(declaration, exports);
  }

  if (clause) {
    addExportClause(clause, declarations, exports);
  }

  if (!declaration && !clause && /^export\s*=/u.test(statement.text)) {
    const value = statement.namedChildren.at(-1);

    if (value) {
      addValue(value, value.text, declarations, exports);
    }

    return;
  }

  if (!declaration && !clause && /\bdefault\b/u.test(statement.text)) {
    const value =
      statement.childForFieldName('value') ?? statement.namedChildren.at(-1);

    if (value) {
      addValue(value, 'default', declarations, exports);
    }
  }
};

const reexportSymbols = (statement: Node, clause?: Node): readonly string[] => {
  if (clause) {
    const statementTypeOnly = /^export\s+type\b/u.test(statement.text);

    return unique(
      descendants(clause, 'export_specifier').map((specifier) => {
        const name =
          specifier.childForFieldName('name')?.text ?? specifier.text;
        const alias = specifier.childForFieldName('alias')?.text;
        const symbol = alias ? `${name} as ${alias}` : normalize(name);

        return statementTypeOnly || /^type\b/u.test(specifier.text.trim())
          ? `type ${symbol}`
          : symbol;
      }),
    );
  }

  const namespace = statement.namedChildren.find(
    ({ type }) => type === 'namespace_export',
  );
  const symbol = namespace ? normalize(namespace.text) : '*';

  return [/^export\s+type\b/u.test(statement.text) ? `type ${symbol}` : symbol];
};

const addExportClause = (
  clause: Node,
  declarations: ReadonlyMap<string, Declaration>,
  exports: Sets,
): void => {
  for (const specifier of descendants(clause, 'export_specifier')) {
    const local = specifier.childForFieldName('name')?.text;

    if (!local) {
      continue;
    }

    const alias = specifier.childForFieldName('alias')?.text;
    const declaration = declarations.get(local);

    if (!declaration) {
      exports.variables.add(alias ?? local);

      continue;
    }

    exports[declaration.category].add(
      alias ? rename(declaration.display, local, alias) : declaration.display,
    );

    declaration.members?.forEach((member) =>
      exports.methods.add(alias ? rename(member, local, alias) : member),
    );
  }
};

const declarationIndex = (root: Node): ReadonlyMap<string, Declaration> => {
  const declarations = new Map<string, Declaration>();

  for (const statement of root.namedChildren) {
    const node =
      statement.type === 'export_statement'
        ? statement.childForFieldName('declaration')
        : statement;

    if (!node) {
      continue;
    }

    for (const declaration of unwrapDeclarations(node)) {
      for (const entry of describeDeclaration(declaration)) {
        declarations.set(entry.name, entry.value);
      }
    }
  }

  return declarations;
};

const describeDeclaration = (
  node: Node,
): readonly { readonly name: string; readonly value: Declaration }[] => {
  if (isClassDeclaration(node.type)) {
    const name = node.childForFieldName('name')?.text;

    return name
      ? [
          {
            name,
            value: {
              category: 'classes',
              display: name,
              members: classMembers(node, name),
            },
          },
        ]
      : [];
  }

  if (node.type.includes('function_declaration')) {
    const name = node.childForFieldName('name')?.text;

    return name
      ? [
          {
            name,
            value: {
              category: 'functions',
              display: functionSignature(node, name),
            },
          },
        ]
      : [];
  }

  if (isTypeDeclaration(node.type)) {
    const name = node.childForFieldName('name')?.text;

    return name
      ? [
          {
            name,
            value: {
              category: 'types',
              display: `${typeLabel(node.type)} ${name}`,
            },
          },
        ]
      : [];
  }

  if (
    node.type === 'lexical_declaration' ||
    node.type === 'variable_declaration'
  ) {
    return node.namedChildren
      .filter(({ type }) => type === 'variable_declarator')
      .flatMap((declarator) => {
        const name = declarator.childForFieldName('name')?.text;

        return name
          ? [
              {
                name,
                value: {
                  category: 'variables' as const,
                  display: variableSignature(declarator),
                },
              },
            ]
          : [];
      });
  }

  return [];
};

const addDeclaration = (node: Node, exports: Sets): void => {
  for (const declaration of unwrapDeclarations(node)) {
    const described = describeDeclaration(declaration);

    for (const { value } of described) {
      exports[value.category].add(value.display);
    }

    if (isClassDeclaration(declaration.type)) {
      if (described.length === 0) {
        exports.classes.add('default');
      }

      addClassMembers(declaration, exports);
    }
  }
};

const addClassMembers = (declaration: Node, exports: Sets): void => {
  const className = declaration.childForFieldName('name')?.text ?? 'default';

  classMembers(declaration, className).forEach((member) =>
    exports.methods.add(member),
  );
};

const classMembers = (
  declaration: Node,
  className: string,
): readonly string[] => {
  const body = declaration.childForFieldName('body');

  if (!body) {
    return [];
  }

  const members: string[] = [];

  for (const member of body.namedChildren) {
    if (!isPublic(member)) {
      continue;
    }

    if (
      member.type === 'method_definition' ||
      member.type === 'method_signature' ||
      member.type === 'abstract_method_signature'
    ) {
      members.push(methodSignature(member, className));
    }

    if (
      member.type === 'public_field_definition' ||
      member.type === 'field_definition'
    ) {
      const name = member.childForFieldName('name')?.text;

      if (name) {
        members.push(
          `${className}.${name}${member.childForFieldName('type')?.text ?? ''}`,
        );
      }
    }
  }

  return members;
};

const extractCommonJs = (
  assignment: Node,
  declarations: ReadonlyMap<string, Declaration>,
  exports: Sets,
): void => {
  const left = assignment.childForFieldName('left');
  const right = assignment.childForFieldName('right');

  if (!left || !right) {
    return;
  }

  const target = left.text.replaceAll(/\s/gu, '');

  if (target === 'module.exports' && right.type === 'object') {
    for (const property of right.namedChildren) {
      const name = property.childForFieldName('key')?.text ?? property.text;

      addValue(
        property.childForFieldName('value') ?? property,
        name,
        declarations,
        exports,
      );
    }

    return;
  }

  const bracket = bracketExport(left);

  if (bracket) {
    addValue(right, bracket, declarations, exports);

    return;
  }

  const match = /^(?:module\.)?exports\.([^.[\]]+)$/u.exec(target);

  if (target !== 'module.exports' && !match) {
    return;
  }

  addValue(right, match?.[1] ?? 'default', declarations, exports);
};

const addValue = (
  value: Node,
  exportedName: string,
  declarations: ReadonlyMap<string, Declaration>,
  exports: Sets,
): void => {
  const referenced = isReference(value.type)
    ? declarations.get(value.text)
    : undefined;

  if (referenced) {
    exports[referenced.category].add(
      rename(referenced.display, value.text, exportedName),
    );

    referenced.members?.forEach((member) =>
      exports.methods.add(rename(member, value.text, exportedName)),
    );

    return;
  }

  if (value.type === 'class' || isClassDeclaration(value.type)) {
    exports.classes.add(exportedName);

    classMembers(value, exportedName).forEach((member) =>
      exports.methods.add(member),
    );

    return;
  }

  if (value.type.includes('function') || value.type === 'arrow_function') {
    exports.functions.add(functionSignature(value, exportedName));

    return;
  }

  exports.variables.add(exportedName);
};

const emptySets = (): Sets => ({
  classes: new Set(),
  methods: new Set(),
  functions: new Set(),
  variables: new Set(),
  types: new Set(),
  reexports: new Set(),
});

const render = (sets: Sets): ModuleExports | undefined => {
  const result = Object.fromEntries(
    Object.entries(sets).flatMap(([category, values]) => {
      const sorted = [...values].sort(compare);

      return sorted.length === 0 ? [] : [[category, sorted]];
    }),
  ) as ModuleExports;

  return Object.keys(result).length === 0 ? undefined : result;
};

const functionSignature = (node: Node, name: string): string => {
  const parameters =
    node.childForFieldName('parameters')?.text ??
    node.namedChildren.find(({ type }) => type === 'formal_parameters')?.text ??
    '()';

  return normalize(
    `${name}${parameters}${node.childForFieldName('return_type')?.text ?? ''}`,
  );
};

const methodSignature = (node: Node, className: string): string => {
  const nameNode = node.childForFieldName('name');
  const name = nameNode?.text ?? 'constructor';

  const before = nameNode
    ? node.text.slice(0, nameNode.startIndex - node.startIndex)
    : '';

  const accessor = /\bget\s*$/u.test(before)
    ? 'get '
    : /\bset\s*$/u.test(before)
      ? 'set '
      : '';

  return `${className}.${accessor}${functionSignature(node, name)}`;
};

const variableSignature = (node: Node): string =>
  `${node.childForFieldName('name')?.text ?? node.text}${node.childForFieldName('type')?.text ?? ''}`;

const isPublic = (node: Node): boolean => {
  const name = node.childForFieldName('name');

  if (name?.type === 'private_property_identifier') {
    return false;
  }

  const access = node.namedChildren.find(
    ({ type }) => type === 'accessibility_modifier',
  )?.text;

  return access !== 'private' && access !== 'protected';
};

const isTypeDeclaration = (type: string): boolean =>
  type === 'interface_declaration' ||
  type === 'type_alias_declaration' ||
  type === 'enum_declaration' ||
  type === 'internal_module';

const typeLabel = (type: string): string =>
  type === 'interface_declaration'
    ? 'interface'
    : type === 'type_alias_declaration'
      ? 'type'
      : type === 'enum_declaration'
        ? 'enum'
        : 'namespace';

const unwrapDeclarations = (node: Node): readonly Node[] =>
  node.type === 'ambient_declaration' ? node.namedChildren : [node];

const isClassDeclaration = (type: string): boolean =>
  type === 'class_declaration' || type === 'abstract_class_declaration';

const isReference = (type: string): boolean =>
  type === 'identifier' || type === 'shorthand_property_identifier';

const bracketExport = (left: Node): string | undefined => {
  if (left.type !== 'subscript_expression') {
    return undefined;
  }

  const [base, index] = left.namedChildren;

  if (!base || !index || index.type !== 'string') {
    return undefined;
  }

  const target = base.text.replaceAll(/\s/gu, '');

  return target === 'exports' || target === 'module.exports'
    ? literal(index)
    : undefined;
};

const descendants = (node: Node, type: string): readonly Node[] =>
  node.descendantsOfType(type);

const rename = (display: string, from: string, to: string): string =>
  display.startsWith(from) ? `${to}${display.slice(from.length)}` : to;

const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim();

const unique = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].sort(compare);

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
