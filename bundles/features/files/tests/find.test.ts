import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { tool as factory } from '../src/host/tools/find.js';
import { createFakeSandbox, fakeHost } from './fake-sandbox.js';
import { bindTool } from './support/services.js';

void describe('find tool', () => {
  void test('returns matching files relative to the requested search path', async () => {
    const root = await workspace('find-matches');

    await write(root, 'src/a.ts', 'a');

    await write(root, 'src/nested/b.ts', 'b');

    await write(root, 'src/c.txt', 'c');

    const result = await bindTool(
      factory,
      createFakeSandbox(root),
      fakeHost(),
    ).execute({
      pattern: '*.ts',
      path: 'src',
    });

    assert.deepEqual(result, {
      results: ['a.ts', 'nested/b.ts'],
      total: 2,
      truncated: false,
    });

    await rm(root, { recursive: true, force: true });
  });

  void test('searches the working directory and leaves an absolute path absolute', async () => {
    const root = await workspace('find-cwd');

    await write(root, 'src/a.ts', 'a');

    await write(root, 'b.ts', 'b');

    const host = fakeHost({ cwd: '/workspace/src' });
    const sandbox = createFakeSandbox(root);

    assert.deepEqual(
      (await bindTool(factory, sandbox, host).execute({ pattern: '*.ts' }))
        .results,
      ['a.ts'],
    );

    assert.deepEqual(
      (
        await bindTool(factory, sandbox, host).execute({
          pattern: '*.ts',
          path: '/workspace',
        })
      ).results,
      ['b.ts', 'src/a.ts'],
    );

    await rm(root, { recursive: true, force: true });
  });

  void test('respects gitignore files while walking', async () => {
    const root = await workspace('find-ignore');

    await write(root, '.gitignore', '*.txt\n!keep.txt\n');

    await write(root, 'visible.txt', 'visible');

    await write(root, 'ignored.txt', 'ignored');

    await write(root, 'keep.txt', 'keep');

    const result = await bindTool(
      factory,
      createFakeSandbox(root),
      fakeHost(),
    ).execute({
      pattern: '*.txt',
    });

    assert.deepEqual(result.results, ['keep.txt']);

    await rm(root, { recursive: true, force: true });
  });

  void test('hides files under ignored directories and scopes nested gitignore files', async () => {
    const root = await workspace('find-ignore-nested');

    await write(root, '.gitignore', 'dist/\nout\n');

    await write(root, 'dist/deep/a.ts', 'a');

    await write(root, 'out/b.ts', 'b');

    await write(root, 'src/dist', 'a file named like a directory rule');

    await write(root, 'src/app/.gitignore', '*.gen.ts\n!keep.gen.ts\n');

    await write(root, 'src/app/main.ts', 'main');

    await write(root, 'src/app/drop.gen.ts', 'drop');

    await write(root, 'src/app/keep.gen.ts', 'keep');

    await write(root, 'src/other.gen.ts', 'outside the nested rule');

    const result = await bindTool(
      factory,
      createFakeSandbox(root),
      fakeHost(),
    ).execute({ pattern: '**' });

    assert.deepEqual(result.results, [
      '.gitignore',
      'src/app/.gitignore',
      'src/app/keep.gen.ts',
      'src/app/main.ts',
      'src/dist',
      'src/other.gen.ts',
    ]);

    await rm(root, { recursive: true, force: true });
  });

  void test('filters a large workspace with many gitignore rules quickly', async () => {
    const root = await workspace('find-ignore-scale');
    const rules = Array.from({ length: 1000 }, (_, index) => `rule-${index}-*`);

    await write(root, '.gitignore', `${rules.join('\n')}\n`);

    const files = Array.from(
      { length: 2000 },
      (_, index) => `a/b/c/d/e${index % 20}/file-${index}.ts`,
    );

    await Promise.all(files.map((file) => write(root, file, '')));

    const started = performance.now();

    const result = await bindTool(
      factory,
      createFakeSandbox(root),
      fakeHost(),
    ).execute({ pattern: '*.ts', limit: 5000 });

    assert.equal(result.total, 2000);

    assert.ok(
      performance.now() - started < 5000,
      'gitignore filtering must not grow with files times depth times rules',
    );

    await rm(root, { recursive: true, force: true });
  });
});

const workspace = (name: string): Promise<string> =>
  mkdtemp(path.join(os.tmpdir(), `doric-${name}-`));

const write = async (
  root: string,
  file: string,
  content: string,
): Promise<void> => {
  const target = path.join(root, file);

  await mkdir(path.dirname(target), { recursive: true });

  await writeFile(target, content, 'utf8');
};
