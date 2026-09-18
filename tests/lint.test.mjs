import assert from 'node:assert/strict';
import test from 'node:test';

import { ESLint } from 'eslint';
import { format } from 'prettier';

const lint = new ESLint();
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

test('reports unhandled promises in bundle entrypoints', async () => {
  for (const filePath of ['bundles/core/index.mts', 'bundles/git/index.mts']) {
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
