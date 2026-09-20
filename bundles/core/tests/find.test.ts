import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import factory from '../tools/find.js';
import { createFakeSandbox } from './fake-sandbox.js';

describe('find tool', () => {
  test('returns matching files relative to the requested search path', async () => {
    const root = await workspace('find-matches');

    await write(root, 'src/a.ts', 'a');

    await write(root, 'src/nested/b.ts', 'b');

    await write(root, 'src/c.txt', 'c');

    const result = await factory(createFakeSandbox(root)).execute({
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

  test('respects gitignore files while walking', async () => {
    const root = await workspace('find-ignore');

    await write(root, '.gitignore', '*.txt\n!keep.txt\n');

    await write(root, 'visible.txt', 'visible');

    await write(root, 'ignored.txt', 'ignored');

    await write(root, 'keep.txt', 'keep');

    const result = await factory(createFakeSandbox(root)).execute({
      pattern: '*.txt',
    });

    assert.deepEqual(result.results, ['keep.txt']);

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
