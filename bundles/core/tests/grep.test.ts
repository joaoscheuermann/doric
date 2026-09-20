import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import factory from '../tools/grep.js';
import { createFakeSandbox } from './fake-sandbox.js';

describe('grep tool', () => {
  test('finds matching lines with requested context and glob filtering', async () => {
    const root = await workspace('grep-context');

    await write(
      root,
      'src/one.ts',
      'before one\nconst value = Target;\nafter one\n',
    );

    await write(root, 'src/two.txt', 'Target\n');

    const result = await factory(createFakeSandbox(root)).execute({
      pattern: 'Target',
      path: 'src',
      glob: '*.ts',
      context: 1,
    });

    assert.equal(result.total, 1);

    assert.deepEqual(result.matches[0], {
      file: 'one.ts',
      line: 2,
      text: 'const value = Target;',
      context_before: ['before one'],
      context_after: ['after one'],
    });

    await rm(root, { recursive: true, force: true });
  });

  test('returns a structured error for invalid regular expressions', async () => {
    const root = await workspace('grep-invalid-regex');

    const result = await factory(createFakeSandbox(root)).execute({
      pattern: '[',
    });

    assert.equal(result.matches.length, 0);

    assert.match(result.error ?? '', /^Invalid regex pattern:/);

    await rm(root, { recursive: true, force: true });
  });

  test('honors gitignore whitelist rules while walking', async () => {
    const root = await workspace('grep-ignore-whitelist');

    await write(root, '.gitignore', '*.txt\n!keep.txt\n');

    await write(root, 'ignored.txt', 'Target\n');

    await write(root, 'keep.txt', 'Target\n');

    const result = await factory(createFakeSandbox(root)).execute({
      pattern: 'Target',
      glob: '*.txt',
    });

    assert.deepEqual(
      result.matches.map((match) => match.file),
      ['keep.txt'],
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
