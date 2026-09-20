import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import factory from '../tools/tree.js';
import { createFakeSandbox } from './fake-sandbox.js';

describe('tree tool', () => {
  test('renders ascii tree and includes .agents while hiding other dot paths', async () => {
    const root = await workspace('tree-visible');

    await write(root, '.agents/skill.md', 'skill');

    await write(root, '.hidden/secret.txt', 'secret');

    await write(root, 'src/lib.ts', 'lib');

    await write(root, 'visible.txt', 'visible');

    const output = await factory(createFakeSandbox(root)).execute({
      path: '.',
    });

    assert.match(output, /\|-- .agents\/|`-- .agents\//);

    assert.match(output, /skill\.md/);

    assert.match(output, /visible\.txt/);

    assert.doesNotMatch(output, /\.hidden/);

    assert.doesNotMatch(output, /[├└│─]/);

    await rm(root, { recursive: true, force: true });
  });

  test('honors gitignore whitelist rules while rendering', async () => {
    const root = await workspace('tree-ignore-whitelist');

    await write(root, '.gitignore', '*.txt\n!keep.txt\n');

    await write(root, 'ignored.txt', 'ignored');

    await write(root, 'keep.txt', 'keep');

    const output = await factory(createFakeSandbox(root)).execute({
      path: '.',
    });

    assert.match(output, /keep\.txt/);

    assert.doesNotMatch(output, /ignored\.txt/);

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
