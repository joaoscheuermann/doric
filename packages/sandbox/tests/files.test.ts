import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  listSandboxDirectories,
  listSandboxDirectory,
  listSandboxRepos,
  listSandboxTree,
  type SandboxTreeNode,
  workspacePathKind,
} from '../src/index.js';
import { createLocalSandbox } from './fake-sandbox.js';

void describe('workspace listing', () => {
  void test('keeps ignored dependency files out of the listing transport while preserving reopened directories', async (context) => {
    const root = await workspace('listing-prune');
    context.after(() => rm(root, { recursive: true, force: true }));
    await write(
      root,
      '.gitignore',
      'node_modules/\ncache[1]/\nvendor/\n!vendor/\n',
    );
    await write(root, 'node_modules/large-package/unused.js', 'unused');
    await write(root, 'cache[1]/unused.js', 'unused');
    await write(root, 'cache1/visible.js', 'visible');
    await write(root, 'vendor/.gitignore', '*.log\n!keep.log\n');
    await write(root, 'vendor/keep.log', 'keep');
    await write(root, 'vendor/drop.log', 'drop');
    await write(root, '.agents/skill.md', 'skill');
    const sandbox = createLocalSandbox(root);
    const received: string[] = [];
    const result = await listSandboxTree({
      ...sandbox,
      exec: async (input) => {
        const output = await sandbox.exec(input);
        received.push(output.stdout);
        return output;
      },
    });
    assert.equal(result.status, 'listed');
    assert.equal(received.join('\n').includes('unused.js'), false);
    assert.deepEqual(
      result.status === 'listed'
        ? result.entries.map((entry) => entry.name)
        : [],
      ['.agents', 'cache1', 'vendor'],
    );
    const vendor =
      result.status === 'listed'
        ? result.entries.find((entry) => entry.name === 'vendor')
        : undefined;
    assert.deepEqual(
      vendor?.children?.map((entry) => entry.name),
      ['keep.log'],
    );
  });

  void test('ignores dependency installs without a .gitignore, which a negation brings back', async (context) => {
    const root = await workspace('listing-defaults');
    context.after(() => rm(root, { recursive: true, force: true }));
    await write(root, 'node_modules/pkg/unused.js', 'unused');
    await write(root, 'app/node_modules/pkg/unused.js', 'unused');
    await write(root, 'app/__pycache__/main.pyc', 'unused');
    await write(root, 'app/main.py', 'main');
    const sandbox = createLocalSandbox(root);
    const received: string[] = [];
    const listing = await listSandboxTree({
      ...sandbox,
      exec: async (input) => {
        const output = await sandbox.exec(input);
        received.push(output.stdout);
        return output;
      },
    });

    assert.deepEqual(
      listing.status === 'listed' ? visible(listing.entries) : [],
      ['app', 'app/main.py'],
    );
    assert.equal(received.join('\n').includes('unused.js'), false);

    await write(root, '.gitignore', '!node_modules/\n');
    const reopened = await listSandboxDirectory(sandbox);

    assert.deepEqual(
      reopened.status === 'listed'
        ? reopened.entries.map(({ path: value }) => value)
        : [],
      ['app', 'node_modules'],
    );
  });

  void test('lists one level with names, relative paths, sizes and ordering', async () => {
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

  void test('never recurses into a directory it lists', async () => {
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

  void test('hides dot entries but keeps .agents', async () => {
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

  void test('applies .gitignore with negation from every ancestor directory', async () => {
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

  void test('rejects a path that leaves the workspace root', async () => {
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

  void test('reports a missing path and a file where a directory was listed', async () => {
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

  void test('rejects an unsupported exclude pattern and an excluded root', async () => {
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

  void test('builds the recursive tree the tree tool renders', async () => {
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

  void test('lists a large workspace with many .gitignore rules quickly', async (context) => {
    const root = await workspace('listing-scale');
    context.after(() => rm(root, { recursive: true, force: true }));
    const rules = Array.from({ length: 3000 }, (_, index) => `rule-${index}-*`);

    await write(root, '.gitignore', `${rules.join('\n')}\n`);

    const files = Array.from(
      { length: 4000 },
      (_, index) => `a/b/c/d/e${index % 20}/file-${index}.ts`,
    );

    await Promise.all(files.map((file) => write(root, file, '')));

    const started = performance.now();
    const result = await listSandboxTree(createLocalSandbox(root));
    const elapsed = performance.now() - started;

    assert.equal(
      visible(result.status === 'listed' ? result.entries : []).filter(
        (entry) => entry.endsWith('.ts'),
      ).length,
      4000,
    );

    assert.ok(
      elapsed < 4000,
      `listing took ${Math.round(elapsed)} ms; .gitignore matching must not grow with files times rules times a path resolution`,
    );
  });
});

void describe('workspace directories listed one level each', () => {
  /**
   * A workspace exercising every visibility rule: nested `.gitignore` files with
   * negations at several depths, a rule file in `.agents` that sorts before the
   * workspace's own, default-ignored dependency installs (one reopened), hidden
   * entries and an ignored directory whose own rules whitelist inside it.
   */
  const rulesWorkspace = async (name: string): Promise<string> => {
    const root = await workspace(name);
    await write(
      root,
      '.gitignore',
      '*.log\n!keep.log\nbuild/\n!x.txt\n!vendor/node_modules/\n',
    );
    await write(root, 'keep.log', 'keep');
    await write(root, 'drop.log', 'drop');
    await write(root, 'x.txt', 'x');
    await write(root, '.env', 'secret');
    await write(root, '.hidden/secret.txt', 'secret');
    await write(root, '.agents/.gitignore', 'x.txt\n');
    await write(root, '.agents/x.txt', 'x');
    await write(root, '.agents/skill.md', 'skill');
    await write(root, 'build/.gitignore', '!out.js\n');
    await write(root, 'build/out.js', 'out');
    await write(root, 'node_modules/pkg/index.js', 'pkg');
    await write(root, 'app/__pycache__/main.pyc', 'pyc');
    await write(root, 'app/main.py', 'main');
    await write(root, 'app/node_modules/pkg/index.js', 'pkg');
    await write(root, 'vendor/node_modules/pkg/index.js', 'pkg');
    await write(root, 'sub/.gitignore', 'keep.log\ngenerated/\n');
    await write(root, 'sub/keep.log', 'keep');
    await write(root, 'sub/drop.log', 'drop');
    await write(root, 'sub/generated/out.ts', 'out');
    await write(root, 'sub/deep/.gitignore', '!keep.log\n');
    await write(root, 'sub/deep/keep.log', 'keep');
    await write(root, 'sub/deep/drop.log', 'drop');
    await write(root, 'sub/deep/inner/main.ts', 'main');
    await write(root, 'sub/B.ts', 'b');
    await write(root, 'sub/a.ts', 'a');
    return root;
  };

  /** Every directory of a recursive listing with the children it nests. */
  const nested = (
    nodes: readonly SandboxTreeNode[],
    path: string,
    into = new Map<string, readonly string[]>(),
  ): Map<string, readonly string[]> => {
    into.set(
      path,
      nodes.map((node) => `${node.type}:${node.path}`),
    );
    for (const node of nodes) {
      if (node.children !== undefined) nested(node.children, node.path, into);
    }
    return into;
  };

  for (const treeRoot of ['', 'sub']) {
    void test(`lists each directory as the recursive listing from '${treeRoot}' nests it`, async (context) => {
      const root = await rulesWorkspace('directories-parity');
      context.after(() => rm(root, { recursive: true, force: true }));
      const sandbox = createLocalSandbox(root);
      const tree = await listSandboxTree(sandbox, { path: treeRoot });
      assert.equal(tree.status, 'listed');
      const expected = nested(
        tree.status === 'listed' ? tree.entries : [],
        treeRoot,
      );

      const paths = [...expected.keys()];
      const listed = await listSandboxDirectories(sandbox, {
        paths,
        root: treeRoot,
      });

      assert.deepEqual(
        new Map(
          listed.map((result, index) => [
            paths[index] as string,
            result.status === 'listed'
              ? result.entries.map((entry) => `${entry.type}:${entry.path}`)
              : [result.status],
          ]),
        ),
        expected,
      );
    });
  }

  void test('applies negations from every ancestor .gitignore, deepest rules winning', async (context) => {
    const root = await rulesWorkspace('directories-negation');
    context.after(() => rm(root, { recursive: true, force: true }));

    const [workspaceRoot, sub, deep, agents, vendor] =
      await listSandboxDirectories(createLocalSandbox(root), {
        paths: ['', 'sub', 'sub/deep', '.agents', 'vendor'],
      });

    const names = (result: typeof workspaceRoot): readonly string[] =>
      result?.status === 'listed'
        ? result.entries.map((entry) => entry.name)
        : [];
    assert.deepEqual(names(workspaceRoot), [
      '.agents',
      'app',
      'sub',
      'vendor',
      'keep.log',
      'x.txt',
    ]);
    // `sub` ignores keep.log again below itself; `sub/deep` negates it back.
    assert.deepEqual(names(sub), ['deep', 'a.ts', 'B.ts']);
    assert.deepEqual(names(deep), ['inner', 'keep.log']);
    // The workspace's `!x.txt` is read after `.agents/.gitignore`, as the
    // recursive listing reads them.
    assert.deepEqual(names(agents), ['skill.md', 'x.txt']);
    assert.deepEqual(names(vendor), ['node_modules']);
  });

  void test('answers each requested path in order, refusing missing, file and escaping paths', async (context) => {
    const root = await rulesWorkspace('directories-refusals');
    context.after(() => rm(root, { recursive: true, force: true }));

    const results = await listSandboxDirectories(createLocalSandbox(root), {
      paths: ['gone', 'x.txt', '../outside', 'app', 'app', '/workspace/app'],
    });

    assert.deepEqual(
      results.map((result) => result.status),
      ['missing', 'not_directory', 'escaped', 'listed', 'listed', 'listed'],
    );
    assert.deepEqual(results[3], {
      status: 'listed',
      path: 'app',
      entries: [{ name: 'main.py', path: 'app/main.py', type: 'file' }],
    });
    assert.deepEqual(results[5], results[3]);
    assert.deepEqual(
      await listSandboxDirectories(createLocalSandbox(root), {
        paths: ['../outside'],
      }),
      [{ status: 'escaped', message: 'Path escapes workspace: ../outside' }],
    );
  });

  void test('lists any number of directories in one sandbox command', async (context) => {
    const root = await workspace('directories-one-command');
    context.after(() => rm(root, { recursive: true, force: true }));
    const paths = Array.from({ length: 40 }, (_, index) => `d${index}`);
    await Promise.all(paths.map((dir) => write(root, `${dir}/file.ts`, '')));
    const sandbox = createLocalSandbox(root);
    let commands = 0;

    const results = await listSandboxDirectories(
      {
        ...sandbox,
        exec: (input) => {
          commands += 1;
          return sandbox.exec(input);
        },
      },
      { paths: ['', ...paths] },
    );

    assert.equal(commands, 1);
    assert.equal(
      results[0]?.status === 'listed' ? results[0].entries.length : 0,
      40,
    );
    assert.ok(
      results
        .slice(1)
        .every(
          (result) =>
            result.status === 'listed' &&
            result.entries.length === 1 &&
            result.entries[0]?.size === undefined,
        ),
    );
  });
});

void describe('workspace repositories', () => {
  void test('finds each repository, stopping at a nested boundary', async () => {
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

  void test('matches a .git file, as a submodule or a linked worktree writes it', async () => {
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

  void test('finds the workspace root as a repository when it is one', async () => {
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

  void test('reports no repository for a workspace without one', async () => {
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
