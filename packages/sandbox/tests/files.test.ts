import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  listSandboxDirectory,
  listSandboxTree,
  workspacePathKind,
} from '../src/index.js';
import { createLocalSandbox } from './fake-sandbox.js';

describe('workspace listing', () => {
  test('lists one level with names, relative paths, sizes and ordering', async () => {
    const root = await workspace('listing');

    await write(root, 'b.txt', 'bb');
    await write(root, 'a.txt', 'a');
    await write(root, 'zdir/nested.txt', 'nested');
    await write(root, 'adir/inner.txt', 'inner');

    const result = await listSandboxDirectory(createLocalSandbox(root));

    assert.equal(result.status, 'listed');
    assert.deepEqual(result.status === 'listed' ? result.entries : [], [
      { name: 'adir', path: 'adir', type: 'directory' },
      { name: 'zdir', path: 'zdir', type: 'directory' },
      { name: 'a.txt', path: 'a.txt', type: 'file', size: 1 },
      { name: 'b.txt', path: 'b.txt', type: 'file', size: 2 },
    ]);

    await rm(root, { recursive: true, force: true });
  });

  test('never recurses into a directory it lists', async () => {
    const root = await workspace('listing-depth');

    await write(root, 'src/lib/deep.ts', 'deep');

    const result = await listSandboxDirectory(createLocalSandbox(root), {
      path: 'src',
    });

    assert.deepEqual(
      result.status === 'listed'
        ? result.entries.map(({ path: value }) => value)
        : [],
      ['src/lib'],
    );

    await rm(root, { recursive: true, force: true });
  });

  test('hides dot entries but keeps .agents', async () => {
    const root = await workspace('listing-hidden');

    await write(root, '.agents/skill.md', 'skill');
    await write(root, '.hidden/secret.txt', 'secret');
    await write(root, '.env', 'secret');
    await write(root, 'visible.txt', 'visible');

    const result = await listSandboxDirectory(createLocalSandbox(root));

    assert.deepEqual(
      result.status === 'listed'
        ? result.entries.map(({ path: value }) => value)
        : [],
      ['.agents', 'visible.txt'],
    );

    await rm(root, { recursive: true, force: true });
  });

  test('applies .gitignore with negation from every ancestor directory', async () => {
    const root = await workspace('listing-ignore');

    await write(root, '.gitignore', '*.log\n!keep.log\nbuild/\n');
    await write(root, 'debug.log', 'debug');
    await write(root, 'keep.log', 'keep');
    await write(root, 'build/out.js', 'out');
    await write(root, 'src/main.ts', 'main');

    const listing = await listSandboxDirectory(createLocalSandbox(root));

    assert.deepEqual(
      listing.status === 'listed'
        ? listing.entries.map(({ path: value }) => value)
        : [],
      ['src', 'keep.log'],
    );

    // The workspace .gitignore also applies when a nested directory is listed.
    const nested = await listSandboxDirectory(createLocalSandbox(root), {
      path: 'src',
    });

    assert.deepEqual(
      nested.status === 'listed'
        ? nested.entries.map(({ path: value }) => value)
        : [],
      ['src/main.ts'],
    );

    await rm(root, { recursive: true, force: true });
  });

  test('rejects a path that leaves the workspace root', async () => {
    const root = await workspace('listing-escape');
    const sandbox = createLocalSandbox(root);

    const listing = await listSandboxDirectory(sandbox, {
      path: '../outside',
    });

    assert.deepEqual(listing, {
      status: 'escaped',
      message: 'Path escapes workspace: ../outside',
    });

    assert.equal(await workspacePathKind(sandbox, '../../etc'), 'escaped');
    assert.equal(await workspacePathKind(sandbox, 'missing.txt'), 'missing');

    await rm(root, { recursive: true, force: true });
  });

  test('reports a missing path and a file where a directory was listed', async () => {
    const root = await workspace('listing-kind');
    const sandbox = createLocalSandbox(root);

    await write(root, 'file.txt', 'file');

    assert.deepEqual(await listSandboxDirectory(sandbox, { path: 'gone' }), {
      status: 'missing',
    });
    assert.deepEqual(
      await listSandboxDirectory(sandbox, { path: 'file.txt' }),
      { status: 'not_directory' },
    );
    assert.equal(await workspacePathKind(sandbox, 'file.txt'), 'file');
    assert.equal(await workspacePathKind(sandbox, ''), 'directory');

    await rm(root, { recursive: true, force: true });
  });

  test('rejects an unsupported exclude pattern and an excluded root', async () => {
    const root = await workspace('listing-exclude');
    const sandbox = createLocalSandbox(root);

    await write(root, 'src/main.ts', 'main');

    assert.deepEqual(await listSandboxDirectory(sandbox, { exclude: ['[a'] }), {
      status: 'invalid_exclude',
      message: "Error: invalid exclude pattern '[a': unclosed character class",
    });
    assert.deepEqual(
      await listSandboxTree(sandbox, { path: 'src', exclude: ['src'] }),
      { status: 'excluded_root', name: 'src' },
    );

    await rm(root, { recursive: true, force: true });
  });

  test('builds the recursive tree the tree tool renders', async () => {
    const root = await workspace('listing-tree');

    await write(root, 'src/lib/inner.ts', 'inner');
    await write(root, 'src/main.ts', 'main');
    await write(root, 'src/empty/note.txt', 'note');
    await write(root, '.gitignore', 'ignored.ts\n');
    await write(root, 'src/ignored.ts', 'ignored');
    await write(root, 'README.md', 'readme');

    const result = await listSandboxTree(createLocalSandbox(root));

    assert.equal(result.status, 'listed');
    assert.deepEqual(result.status === 'listed' ? result.entries : [], [
      {
        name: 'src',
        path: 'src',
        type: 'directory',
        children: [
          {
            name: 'empty',
            path: 'src/empty',
            type: 'directory',
            children: [
              { name: 'note.txt', path: 'src/empty/note.txt', type: 'file' },
            ],
          },
          {
            name: 'lib',
            path: 'src/lib',
            type: 'directory',
            children: [
              { name: 'inner.ts', path: 'src/lib/inner.ts', type: 'file' },
            ],
          },
          { name: 'main.ts', path: 'src/main.ts', type: 'file' },
        ],
      },
      { name: 'README.md', path: 'README.md', type: 'file' },
    ]);

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
