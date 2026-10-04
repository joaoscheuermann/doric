import assert from 'node:assert/strict';
import test from 'node:test';

import { ESLint } from 'eslint';
import { format } from 'prettier';

const lint = new ESLint({
  overrideConfig: {
    languageOptions: {
      parserOptions: {
        // lintText replaces on-disk source with in-memory snippets, even in CI.
        disallowAutomaticSingleRunInference: true,
      },
    },
  },
});
const typedFile = 'packages/session/src/lib/session.ts';

test('reports undefined names in JavaScript tooling', async () => {
  const [result] = await lint.lintText('missingFunction();', {
    filePath: 'lint-example.mjs',
  });

  assert.ok(result.messages.some(({ ruleId }) => ruleId === 'no-undef'));
});

test('reports unhandled promises in package TypeScript', async () => {
  const [result] = await lint.lintText(
    'export function start() { Promise.resolve(1); }',
    { filePath: typedFile },
  );

  assert.ok(
    result.messages.some(
      ({ ruleId }) => ruleId === '@typescript-eslint/no-floating-promises',
    ),
  );
});

test('enforces the official TypeScript array style', async () => {
  const [result] = await lint.lintText(
    'export const values: Array<string> = [];',
    { filePath: typedFile },
  );

  assert.ok(
    result.messages.some(
      ({ ruleId }) => ruleId === '@typescript-eslint/array-type',
    ),
  );
});

test('allows immediate async test doubles but requires async work in production', async () => {
  const source = 'export const fixture = async () => 1;';
  const [fixture] = await lint.lintText(source, {
    filePath: 'packages/agent/tests/fakes.ts',
  });
  const [production] = await lint.lintText(source, { filePath: typedFile });
  assert.equal(fixture.errorCount, 0, JSON.stringify(fixture.messages));
  assert.ok(
    production.messages.some(
      ({ ruleId }) => ruleId === '@typescript-eslint/require-await',
    ),
  );
});

test('still reports unhandled promises inside tests', async () => {
  const [result] = await lint.lintText(
    'export function exercise() { Promise.resolve(1); }',
    { filePath: 'packages/agent/tests/fakes.ts' },
  );
  assert.ok(
    result.messages.some(
      ({ ruleId }) => ruleId === '@typescript-eslint/no-floating-promises',
    ),
  );
});

test('allows deliberately unused parameters but catches accidental unused values', async () => {
  const [result] = await lint.lintText(
    'export function fixture(_unused: string) { const forgotten = 1; return 2; }',
    { filePath: typedFile },
  );
  const unused = result.messages.filter(
    ({ ruleId }) => ruleId === '@typescript-eslint/no-unused-vars',
  );
  assert.equal(unused.length, 1);
  assert.match(unused[0].message, /forgotten/);
});

test('reports unhandled promises in bundle entrypoints', async () => {
  for (const filePath of [
    'bundles/core/index.mts',
    'bundles/git/index.mts',
    'bundles/threads/index.mts',
  ]) {
    const [result] = await lint.lintText(
      'export function start() { Promise.resolve(1); }',
      { filePath },
    );

    assert.ok(
      result.messages.some(
        ({ ruleId }) => ruleId === '@typescript-eslint/no-floating-promises',
      ),
      filePath,
    );
  }
});

test('accepts Prettier output without additional blank-line rules', async () => {
  const source = await format('const value=1; console.log(value);', {
    parser: 'babel',
  });
  const [result] = await lint.lintText(source, {
    filePath: 'lint-example.mjs',
  });

  assert.equal(result.errorCount, 0, JSON.stringify(result.messages));
});

test('reports unsorted imports', async () => {
  const [result] = await lint.lintText(
    "import path from 'node:path';\nimport fs from 'node:fs';\nconsole.log(path, fs);",
    { filePath: 'lint-example.mjs' },
  );

  assert.ok(
    result.messages.some(
      ({ ruleId }) => ruleId === 'simple-import-sort/imports',
    ),
  );
});

test('ignores generated code and installed dependencies', async () => {
  for (const path of [
    'packages/session/dist/index.js',
    'agents/doric/src/generated/prisma/client.ts',
    'node_modules/example/index.js',
  ]) {
    assert.equal(await lint.isPathIgnored(path), true, path);
  }
});
