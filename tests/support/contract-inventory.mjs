import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import ts from 'typescript';

/** How deep a parameter or an answer is searched for a value that is not data. */
const MAX_DEPTH = 8;

/** Classes whose instances are not plain data (spec, "The inventory check"). */
const CLASS_NAMES = new Set([
  'Map',
  'Set',
  'Date',
  'Uint8Array',
  'ArrayBuffer',
  'Blob',
  'File',
  'Buffer',
  'AbortSignal',
  'ReadableStream',
  'Error',
]);

/** The root of the DOM's class hierarchy: a type that is or extends one of these is a DOM node. */
const DOM_NAMES = new Set(['Node', 'EventTarget']);

/** Directories whose sources are scanned, relative to the tsconfig's directory. */
const SOURCE_ROOTS = ['packages', 'bundles'];

/** Directories never scanned: tests, stories, dependencies and build output. */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'tests',
  'test',
  '__tests__',
  'stories',
  'e2e',
]);

const isSourceFile = (name) =>
  /\.(ts|tsx|mts|cts)$/.test(name) &&
  !name.endsWith('.d.ts') &&
  !/\.(test|spec|stories)\.[cm]?tsx?$/.test(name);

const listSources = (directory) => {
  const files = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name))
        files.push(...listSources(path));
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      files.push(path);
    }
  }
  return files;
};

const readCompilerOptions = (tsconfig) => {
  const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (read.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(read.error.messageText, '\n'),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(tsconfig),
    undefined,
    tsconfig,
  );
  return { ...parsed.options, noEmit: true };
};

/** Rows of the table of section A: `{contract, method}` from its second and third columns. */
const readInventoryRows = (inventory) => {
  const rows = [];
  let inSectionA = false;
  for (const line of readFileSync(inventory, 'utf8').split('\n')) {
    if (line.startsWith('## ')) {
      inSectionA = /^## A\./.test(line);
      continue;
    }
    if (!inSectionA || !/^\|\s*\d+\s*\|/.test(line)) continue;
    const cells = line
      .split('|')
      .map((cell) => cell.trim().replace(/^`|`$/g, ''));
    rows.push({ contract: cells[2], method: cells[3] });
  }
  return rows;
};

const readAllowlist = (allowlist) => {
  if (!allowlist) return new Set();
  const entries = JSON.parse(readFileSync(allowlist, 'utf8'));
  return new Set(
    entries.map(({ contract, method }) => `${contract}\u0000${method}`),
  );
};

const typeName = (type) => (type.aliasSymbol ?? type.getSymbol())?.getName();

/** Every name of the type and of its base classes and interfaces. */
const ancestorNames = (checker, type, seen = new Set()) => {
  const names = [];
  const symbol = type.getSymbol();
  if (!symbol || seen.has(symbol)) return names;
  seen.add(symbol);
  names.push(symbol.getName());
  const target = type.target ?? type;
  if (
    target.flags & ts.TypeFlags.Object &&
    target.objectFlags & ts.ObjectFlags.ClassOrInterface
  ) {
    for (const base of checker.getBaseTypes(target) ?? []) {
      names.push(...ancestorNames(checker, base, seen));
    }
  }
  return names;
};

/** True when a property name is a `unique symbol` key (the checker names those `__@…`). */
const isSymbolKey = (property) =>
  property.escapedName.toString().startsWith('__@');

const isOpaqueInterface = (checker, type) => {
  const symbol = type.getSymbol();
  if (!symbol || !(symbol.flags & ts.SymbolFlags.Interface)) return false;
  if (checker.getIndexInfosOfType(type).length > 0) return false;
  if (
    type.getCallSignatures().length > 0 ||
    type.getConstructSignatures().length > 0
  ) {
    return false;
  }
  return checker.getPropertiesOfType(type).every(isSymbolKey);
};

const isPromise = (type) => typeName(type) === 'Promise';

/**
 * The first reason a type is not plain data, or undefined when it is data.
 * `allowAny` makes `any` count as data, for an allowlisted member.
 */
const findReason = (
  checker,
  type,
  location,
  allowAny,
  depth = 0,
  path = new Set(),
) => {
  if (depth > MAX_DEPTH) return undefined;
  if (type.flags & ts.TypeFlags.Any) {
    if (allowAny) return undefined;
    return type.intrinsicName === 'error'
      ? 'unresolved type'
      : 'unresolved type `any`';
  }
  // A type parameter is the caller's own type: the value it stands for is
  // whatever the caller passes, so it is data unless its use says otherwise.
  if (type.flags & ts.TypeFlags.TypeParameter) return undefined;
  if (type.isUnionOrIntersection()) {
    for (const part of type.types) {
      const reason = findReason(checker, part, location, allowAny, depth, path);
      if (reason) return reason;
    }
    return undefined;
  }
  if (!(type.flags & ts.TypeFlags.Object)) return undefined;
  if (path.has(type)) return undefined;
  const inner = new Set(path).add(type);

  if (
    type.getCallSignatures().length > 0 ||
    type.getConstructSignatures().length > 0
  ) {
    return 'holds a function';
  }
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    for (const element of checker.getTypeArguments(type)) {
      const reason = findReason(
        checker,
        element,
        location,
        allowAny,
        depth + 1,
        inner,
      );
      if (reason) return reason;
    }
    return undefined;
  }
  const name = typeName(type);
  if (name && CLASS_NAMES.has(name))
    return `holds a class instance (\`${name}\`)`;
  if (
    ancestorNames(checker, type).some((ancestor) => DOM_NAMES.has(ancestor))
  ) {
    return 'holds a DOM node';
  }
  if (isOpaqueInterface(checker, type))
    return `holds an opaque interface (\`${name}\`)`;

  for (const property of checker.getPropertiesOfType(type)) {
    const propertyType = checker.getTypeOfSymbolAtLocation(property, location);
    const reason = findReason(
      checker,
      propertyType,
      location,
      allowAny,
      depth + 1,
      inner,
    );
    if (reason) return `${reason} at \`${property.getName()}\``;
  }
  for (const info of checker.getIndexInfosOfType(type)) {
    const reason = findReason(
      checker,
      info.type,
      location,
      allowAny,
      depth + 1,
      inner,
    );
    if (reason) return reason;
  }
  return undefined;
};

const isDisposable = (type) => typeName(type) === 'Disposable';

/** The reason a contract member is not plain data, or undefined when it is. */
const memberReason = (checker, memberType, location, allowAny) => {
  const signatures = checker.getNonNullableType(memberType).getCallSignatures();
  if (signatures.length === 0) {
    return findReason(checker, memberType, location, allowAny);
  }
  for (const signature of signatures) {
    for (const parameter of signature.getParameters()) {
      if (parameter.getName() === 'call') continue;
      const parameterType = checker.getTypeOfSymbolAtLocation(
        parameter,
        location,
      );
      const reason = findReason(checker, parameterType, location, allowAny, 1);
      if (reason) return `parameter \`${parameter.getName()}\` ${reason}`;
    }
    const answer = signature.getReturnType();
    if (!isPromise(answer)) return 'synchronous: the answer is not a Promise';
    const [resolved] = checker.getTypeArguments(answer);
    if (!resolved) continue;
    if (isDisposable(resolved)) return 'the answer is a Disposable';
    const reason = findReason(checker, resolved, location, allowAny, 1);
    if (reason) return `the answer ${reason}`;
  }
  return undefined;
};

/**
 * The API a `ref` call's answer carries: its property `api`, directly or one
 * level down (`@org/bundle` keeps it under a symbol key), which maps a command
 * or service definition to the stubs a caller sees. Undefined when there is none.
 */
const apiType = (checker, call) => {
  const answer = checker.getTypeAtLocation(call);
  const find = (type, depth) => {
    const nonNullable = checker.getNonNullableType(type);
    const api = nonNullable.getProperty('api');
    if (api)
      return checker.getNonNullableType(
        checker.getTypeOfSymbolAtLocation(api, call),
      );
    if (depth === 0) return undefined;
    for (const property of checker.getPropertiesOfType(nonNullable)) {
      const found = find(
        checker.getTypeOfSymbolAtLocation(property, call),
        depth - 1,
      );
      if (found) return found;
    }
    return undefined;
  };
  return find(answer, 1);
};

/** Every `ref<T>('<id>')` call of a source file. */
const findRefCalls = (sourceFile) => {
  const calls = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'ref' &&
      node.typeArguments?.length &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      calls.push({
        id: node.arguments[0].text,
        typeNode: node.typeArguments[0],
        node,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
};

/**
 * Scans TypeScript contract declarations and compares the (contract, method) pairs that are not plain data
 * (function members, brand interfaces, `any` not in the allowlist) with the rows of section A of an inventory file.
 * @param {{ tsconfig: string, inventory: string, allowlist?: string }} options paths
 * @returns {Promise<{ missing: Array<{contract: string, method: string, reason: string}>, extra: Array<{contract: string, method: string}> }>}
 */
export async function checkContractInventory(options) {
  const base = dirname(options.tsconfig);
  const files = SOURCE_ROOTS.flatMap((directory) =>
    listSources(join(base, directory)),
  ).filter((file) => /\bref\s*</.test(readFileSync(file, 'utf8')));
  const program = ts.createProgram(
    files,
    readCompilerOptions(options.tsconfig),
  );
  const checker = program.getTypeChecker();
  const allowed = readAllowlist(options.allowlist);

  /** key → {contract, method, reason} of every flagged member. */
  const flagged = new Map();
  for (const file of files) {
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile) continue;
    for (const { id, typeNode, node } of findRefCalls(sourceFile)) {
      const contractType =
        apiType(checker, node) ?? checker.getTypeFromTypeNode(typeNode);
      for (const member of checker.getPropertiesOfType(contractType)) {
        const method = member.getName();
        const key = `${id}\u0000${method}`;
        if (flagged.has(key)) continue;
        const memberType = checker.getTypeOfSymbolAtLocation(member, node);
        const reason = memberReason(
          checker,
          memberType,
          node,
          allowed.has(key),
        );
        if (reason) flagged.set(key, { contract: id, method, reason });
      }
    }
  }

  const rows = readInventoryRows(options.inventory);
  const rowKeys = new Set(
    rows.map(({ contract, method }) => `${contract}\u0000${method}`),
  );
  const missing = [...flagged]
    .filter(([key]) => !rowKeys.has(key))
    .map(([, entry]) => entry);
  const extra = rows
    .filter(
      ({ contract, method }) => !flagged.has(`${contract}\u0000${method}`),
    )
    .map(({ contract, method }) => ({ contract, method }));
  return { missing, extra };
}
