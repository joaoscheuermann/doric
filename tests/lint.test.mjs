import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const biome = join(root, 'node_modules', '.bin', 'biome');

const run = ({ source, directory, extension, command = 'lint', args = [] }) => {
  const fixture = mkdtempSync(join(root, directory, 'biome-fixture-'));
  const file = join(fixture, `example.${extension}`);

  try {
    writeFileSync(file, source);
    const result = spawnSync(
      biome,
      [command, file, ...args, '--reporter=json'],
      { cwd: root, encoding: 'utf8' },
    );
    if (result.error) throw result.error;

    return {
      status: result.status,
      diagnostics: JSON.parse(result.stdout).diagnostics.map(
        ({ category }) => category,
      ),
      output: readFileSync(file, 'utf8'),
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
};

test('reports undeclared names in JavaScript tooling', () => {
  const result = run({
    source: 'missingFunction();\n',
    directory: 'tests',
    extension: 'mjs',
  });

  assert.equal(result.status, 1);
  assert.ok(
    result.diagnostics.includes('lint/correctness/noUndeclaredVariables'),
  );
});

test('reports unhandled promises in production and test TypeScript', () => {
  for (const directory of [
    'packages/session/src/lib',
    'packages/agent/tests',
  ]) {
    const result = run({
      source: 'export function start() { Promise.resolve(1); }\n',
      directory,
      extension: 'ts',
    });

    assert.equal(result.status, 1, directory);
    assert.ok(result.diagnostics.includes('lint/nursery/noFloatingPromises'));
  }
});

test('enforces shorthand array types', () => {
  const result = run({
    source: 'export const values: Array<string> = [];\n',
    directory: 'packages/session/src/lib',
    extension: 'ts',
  });

  assert.ok(result.diagnostics.includes('lint/style/useConsistentArrayType'));
});

test('requires await in production async functions while allowing test doubles', () => {
  const source = 'export async function fixture() { return 1; }\n';
  const production = run({
    source,
    directory: 'packages/session/src/lib',
    extension: 'ts',
  });
  const fixture = run({
    source,
    directory: 'packages/agent/tests',
    extension: 'ts',
  });

  assert.ok(production.diagnostics.includes('lint/suspicious/useAwait'));
  assert.equal(fixture.status, 0);
});

test('allows unused underscore parameters but reports forgotten values', () => {
  const result = run({
    source:
      'export function fixture(_unused: string) { const forgotten = 1; return 2; }\n',
    directory: 'packages/session/src/lib',
    extension: 'ts',
  });

  assert.equal(
    result.diagnostics.filter(
      (category) => category === 'lint/correctness/noUnusedVariables',
    ).length,
    1,
  );
});

test('reports unsorted imports', () => {
  const result = run({
    source:
      "import path from 'node:path';\nimport fs from 'node:fs';\nconsole.log(path, fs);\n",
    directory: 'tests',
    extension: 'mjs',
    command: 'check',
    args: ['--formatter-enabled=false'],
  });

  assert.ok(result.diagnostics.includes('assist/source/organizeImports'));
});

test('formats JavaScript with single quotes and semicolons', () => {
  const result = run({
    source: 'const value = "text"\nconsole.log(value)\n',
    directory: 'tests',
    extension: 'mjs',
    command: 'format',
    args: ['--write'],
  });

  assert.equal(result.status, 0);
  assert.equal(result.output, "const value = 'text';\nconsole.log(value);\n");
});

test('ignores generated source', () => {
  const result = run({
    source: 'missingFunction();\n',
    directory: 'agents/doric/src/generated',
    extension: 'ts',
    args: ['--no-errors-on-unmatched'],
  });

  assert.equal(result.status, 0);
  assert.deepEqual(result.diagnostics, []);
});
