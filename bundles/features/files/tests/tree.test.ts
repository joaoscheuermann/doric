import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { tool as factory } from '../src/host/tools/tree.js';
import { createFakeSandbox, fakeHost } from './fake-sandbox.js';
import { bindTool } from './support/services.js';

void describe('tree tool', () => {
  void test('renders ascii tree and includes .agents while hiding other dot paths', async () => {
    const root = await workspace('tree-visible');

    await write(root, '.agents/skill.md', 'skill');

    await write(root, '.hidden/secret.txt', 'secret');

    await write(root, 'src/lib.ts', 'lib');

    await write(root, 'visible.txt', 'visible');

    const output = await bindTool(
      factory,
      createFakeSandbox(root),
      fakeHost(),
    ).execute({
      path: '.',
    });

    assert.match(output, /\|-- .agents\/|`-- .agents\//);

    assert.match(output, /skill\.md/);

    assert.match(output, /visible\.txt/);

    assert.doesNotMatch(output, /\.hidden/);

    assert.doesNotMatch(output, /[├└│─]/);

    await rm(root, { recursive: true, force: true });
  });

  void test('renders the working directory when no path is given', async () => {
    const root = await workspace('tree-cwd');

    await write(root, 'src/deep.ts', 'deep');

    await write(root, 'outside.ts', 'outside');

    const output = await bindTool(
      factory,
      createFakeSandbox(root),
      fakeHost({ cwd: '/workspace/src' }),
    ).execute({});

    assert.match(output, /^\/workspace\/src\n/);

    assert.match(output, /deep\.ts/);

    assert.doesNotMatch(output, /outside\.ts/);

    await rm(root, { recursive: true, force: true });
  });

  void test('honors gitignore whitelist rules while rendering', async () => {
    const root = await workspace('tree-ignore-whitelist');

    await write(root, '.gitignore', '*.txt\n!keep.txt\n');

    await write(root, 'ignored.txt', 'ignored');

    await write(root, 'keep.txt', 'keep');

    const output = await bindTool(
      factory,
      createFakeSandbox(root),
      fakeHost(),
    ).execute({
      path: '.',
    });

    assert.match(output, /keep\.txt/);

    assert.doesNotMatch(output, /ignored\.txt/);

    await rm(root, { recursive: true, force: true });
  });

  void test('stops at three levels by default, counting what a last-level directory holds', async () => {
    const root = await workspace('tree-depth');

    await write(root, 'a/b/c/d/deep.ts', 'deep');

    await write(root, 'a/b/c/near.ts', 'near');

    await mkdir(path.join(root, 'a/b/empty'), { recursive: true });

    const tool = bindTool(factory, createFakeSandbox(root), fakeHost());
    const shallow = await tool.execute({ path: '.' });

    assert.match(shallow, /c\/ \(2 entries not shown\)/);

    assert.match(shallow, /empty\/ \(empty\)/);

    assert.doesNotMatch(shallow, /near\.ts|deep\.ts/);

    const deep = await tool.execute({ path: '.', depth: 5 });

    assert.match(deep, /near\.ts/);

    assert.match(deep, /deep\.ts/);

    assert.match(
      await tool.execute({ path: '.', depth: 1 }),
      /a\/ \(1 entry not shown\)/,
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
