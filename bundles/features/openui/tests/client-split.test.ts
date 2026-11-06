// C13 (conversation-openui.md D29, "Entry and chunk"): the client entry and
// the renderer chunk are separate builds, so a module both reach exists twice.
// The split is fixed: read from the sources, the relative modules reachable
// from `src/client/index.ts` and from `src/client/chunks/renderer.ts` share only
// `src/client/chat-contract.ts`. Imports of `src/contracts` become the
// `openui/contracts` import-map specifier in both builds, once per window, so
// they are not counted; neither are `import type`, `export type` and type-only
// specifiers, which esbuild erases.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/** The bundle's root: tests run from `dist-tests/tests`. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLIENT = join(ROOT, 'src/client');
const CONTRACTS = join(ROOT, 'src/contracts');

/** The value-carrying module specifiers of one source file. */
const valueImports = (file: string): string[] => {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every(
              (element) => element.isTypeOnly,
            )));
      if (!typeOnly && ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier.text);
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const clause = statement.exportClause;
      const typeOnly =
        statement.isTypeOnly ||
        (clause !== undefined &&
          ts.isNamedExports(clause) &&
          clause.elements.length > 0 &&
          clause.elements.every((element) => element.isTypeOnly));
      if (!typeOnly) specifiers.push(statement.moduleSpecifier.text);
    }
  }

  return specifiers;
};

/** A relative `.js` specifier as its `.ts` or `.tsx` source, or undefined for any other file. */
const sourceOf = (from: string, specifier: string): string | undefined => {
  const target = resolve(dirname(from), specifier);
  for (const candidate of [
    target.replace(/\.js$/, '.ts'),
    target.replace(/\.js$/, '.tsx'),
    target,
  ]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  assert.ok(
    !/\.(js|ts|tsx)$/.test(specifier),
    `${relative(ROOT, from)} imports ${specifier}, which has no source`,
  );
  return undefined;
};

/** Every relative source module reachable from `entry` by value imports, contracts left out. */
const reachable = (entry: string): Set<string> => {
  assert.ok(existsSync(entry), `${relative(ROOT, entry)} exists`);
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of valueImports(file)) {
      if (!specifier.startsWith('.')) continue;
      const next = sourceOf(file, specifier);
      if (next === undefined || next.startsWith(`${CONTRACTS}/`)) continue;
      queue.push(next);
    }
  }

  return seen;
};

const filesUnder = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });

test('the entry and the renderer chunk share only chat-contract.ts', () => {
  const entry = reachable(join(CLIENT, 'index.ts'));
  const chunk = reachable(join(CLIENT, 'chunks/renderer.ts'));
  const shared = [...entry].filter((file) => chunk.has(file));

  assert.deepEqual(
    shared.map((file) => relative(ROOT, file)),
    ['src/client/chat-contract.ts'],
  );
});

test('the entry reaches the element, the folds, the answer changes, the projector and the settings section', () => {
  const entry = [...reachable(join(CLIENT, 'index.ts'))].map((file) =>
    relative(CLIENT, file),
  );

  for (const module of [
    'fence-element.tsx',
    'folds.ts',
    'answer-changes.ts',
    'answers-projector.ts',
    'settings.ts',
  ]) {
    assert.ok(entry.includes(module), module);
  }
});

test('no module under src/contracts imports react', () => {
  for (const file of filesUnder(CONTRACTS).filter((path) =>
    /\.tsx?$/.test(path),
  )) {
    const imports = valueImports(file).concat(
      // A type import still names the package the module depends on.
      [...readFileSync(file, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
        (match) => match[1] as string,
      ),
    );
    assert.ok(
      !imports.some(
        (specifier) => specifier === 'react' || specifier.startsWith('react/'),
      ),
      relative(ROOT, file),
    );
  }
});
