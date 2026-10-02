import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  listSandboxDirectory,
  listSandboxRepos,
  listSandboxTree,
  type SandboxTreeNode,
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

  void test('keeps nested negation under its own directory, deepest rules last', async () => {
    const root = await workspace('listing-nested-negation');

    await write(root, '.gitignore', '*.log\n!keep.log\n');
    await write(root, 'sub/.gitignore', 'keep.log\n');
    await write(root, 'sub/deep/.gitignore', '!keep.log\n');
    await write(root, 'keep.log', 'keep');
    await write(root, 'drop.log', 'drop');
    await write(root, 'sub/keep.log', 'keep');
    await write(root, 'sub/drop.log', 'drop');
    await write(root, 'sub/deep/keep.log', 'keep');
    await write(root, 'sub/deep/drop.log', 'drop');

    const result = await listSandboxTree(createLocalSandbox(root));

    assert.equal(result.status, 'listed');
    // `sub` re-ignores `keep.log` under itself while `sub/deep` negates that
    // again below it; the deepest matching rule wins.
    assert.deepEqual(
      result.status === 'listed' ? visible(result.entries) : [],
      ['sub', 'sub/deep', 'sub/deep/keep.log', 'keep.log'],
    );

    await rm(root, { recursive: true, force: true });
  });

  void test('keeps an ignored directory closed even when its .gitignore whitelists inside', async () => {
    const root = await workspace('listing-ignored-dir');

    await write(root, '.gitignore', 'build/\n');
    await write(root, 'build/.gitignore', '!out.js\n');
    await write(root, 'build/out.js', 'out');
    await write(root, 'build/other.txt', 'other');
    await write(root, 'top.txt', 'top');

    const result = await listSandboxTree(createLocalSandbox(root));

    assert.equal(result.status, 'listed');
    assert.deepEqual(
      result.status === 'listed' ? visible(result.entries) : [],
      ['top.txt'],
    );

    await rm(root, { recursive: true, force: true });
  });

  void test('lets a workspace negation win over a nested rule, the rules read in order', async () => {
    const root = await workspace('listing-nested-order');

    await write(root, '.gitignore', '!x.txt\n');
    await write(root, '.agents/.gitignore', 'x.txt\n');
    await write(root, 'x.txt', 'x');
    await write(root, '.agents/x.txt', 'x');

    const result = await listSandboxTree(createLocalSandbox(root));

    assert.equal(result.status, 'listed');
    assert.deepEqual(
      result.status === 'listed' ? visible(result.entries) : [],
      ['.agents', '.agents/x.txt', 'x.txt'],
    );

    await rm(root, { recursive: true, force: true });
  });

  void test('lists a large directory in basename order whatever the scan order', async () => {
    const root = await workspace('listing-large');

    for (let index = 119; index >= 0; index -= 1) {
      await write(root, `f-${String(index).padStart(3, '0')}.txt`, 'x');
    }

    const result = await listSandboxDirectory(createLocalSandbox(root));

    assert.deepEqual(
      result.status === 'listed'
        ? result.entries.map(({ path: value }) => value)
        : [],
      Array.from(
        { length: 120 },
        (_, index) => `f-${String(index).padStart(3, '0')}.txt`,
      ),
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

describe('workspace repositories', () => {
  test('finds each repository, stopping at a nested boundary', async () => {
    const root = await workspace('repos-nested');

    await write(root, 'outer/.git/HEAD', 'ref: refs/heads/main');
    await write(root, 'outer/inner/.git/HEAD', 'ref: refs/heads/main');
    await write(root, 'sibling/.git/HEAD', 'ref: refs/heads/main');
    await write(root, 'plain/file.txt', 'plain');

    const result = await listSandboxRepos(createLocalSandbox(root));

    // `outer/inner` is inside `outer`, so the outer boundary claims it and Git
    // reports it there as one gitlink rather than as its own files.
    assert.deepEqual(result, {
      status: 'listed',
      path: '',
      repositories: [{ path: 'outer' }, { path: 'sibling' }],
    });

    await rm(root, { recursive: true, force: true });
  });

  test('matches a .git file, as a submodule or a linked worktree writes it', async () => {
    const root = await workspace('repos-worktree');

    await write(root, 'worktree/.git', 'gitdir: /elsewhere/.git/worktrees/wt');
    await write(root, 'worktree/file.txt', 'worktree');

    const result = await listSandboxRepos(createLocalSandbox(root));

    assert.deepEqual(result, {
      status: 'listed',
      path: '',
      repositories: [{ path: 'worktree' }],
    });

    await rm(root, { recursive: true, force: true });
  });

  test('finds the workspace root as a repository when it is one', async () => {
    const root = await workspace('repos-root');

    await write(root, '.git/HEAD', 'ref: refs/heads/main');
    await write(root, 'nested/.git/HEAD', 'ref: refs/heads/main');

    const result = await listSandboxRepos(createLocalSandbox(root));

    assert.deepEqual(result, {
      status: 'listed',
      path: '',
      repositories: [{ path: '' }],
    });

    await rm(root, { recursive: true, force: true });
  });

  test('reports no repository for a workspace without one', async () => {
    const root = await workspace('repos-none');

    await write(root, 'src/main.ts', 'main');

    assert.deepEqual(await listSandboxRepos(createLocalSandbox(root)), {
      status: 'listed',
      path: '',
      repositories: [],
    });

    await rm(root, { recursive: true, force: true });
  });
});

const workspace = (name: string): Promise<string> =>
  mkdtemp(path.join(os.tmpdir(), `doric-${name}-`));

/** The tree's visible paths, in the order the tool renders them. */
const visible = (nodes: readonly SandboxTreeNode[]): readonly string[] =>
  nodes.flatMap((node) => [
    node.path,
    ...(node.children ? visible(node.children) : []),
  ]);

const write = async (
  root: string,
  file: string,
  content: string,
): Promise<void> => {
  const target = path.join(root, file);

  await mkdir(path.dirname(target), { recursive: true });

  await writeFile(target, content, 'utf8');
};
