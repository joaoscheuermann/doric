// git.commands/v1 `changes` totals and `fileDiff` comparisons on real
// repositories: untracked files of every kind count as Git counts a new file,
// a read costs the same number of sandbox round trips however many files are
// untracked, and a comparison finds its repository and its change exactly as
// the Project's repository discovery and whole status report them.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, type TestContext, test } from 'node:test';
import { promisify } from 'node:util';

import type { Sandbox } from 'sandbox';

import { routedGit } from './support/routed-git.js';
import { fakeRuntime, localSandbox, repository } from './support/runtime.js';

const run = promisify(execFile);

/** A sandbox that counts the commands it runs: each is one round trip. */
const counted = (sandbox: Sandbox) => {
  const counter = { execs: 0 };
  const wrapped: Sandbox = {
    ...sandbox,
    exec: (input) => {
      counter.execs++;
      return sandbox.exec(input);
    },
  };
  return { sandbox: wrapped, counter };
};

const projectOver = (t: TestContext, sandbox: Sandbox) => {
  const { git, dispose } = routedGit(sandbox, fakeRuntime());
  t.after(dispose);
  return git({ projectId: 'project-1' });
};

type Project = ReturnType<typeof projectOver>;

const totals = async (project: Project) => {
  const outcome = await project.changes({});
  if (outcome.status !== 'ready' || outcome.value.status !== 'read')
    throw new Error('expected a read');
  return outcome.value.repositories.map(({ path, added, removed }) => ({
    path,
    added,
    removed,
  }));
};

const comparison = async (
  project: Project,
  repository: string,
  path: string,
) => {
  const outcome = await project.fileDiff({ repository, path });
  if (outcome.status !== 'ready') throw new Error('expected an answer');
  return outcome.value.status === 'read' ? outcome.value.diff : undefined;
};

/** A committed repository at `root`, made with its files. */
const committed = async (root: string, files: Record<string, string>) => {
  await mkdir(root, { recursive: true });
  const git = async (...args: string[]) =>
    (await run('git', ['-C', root, ...args])).stdout;
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.com');
  for (const [path, content] of Object.entries(files))
    await writeFile(join(root, path), content);
  await git('add', '.');
  await git('commit', '-qm', 'initial');
  return git;
};

describe('changes line totals', () => {
  test('counts every untracked file as Git counts a new one', async (t) => {
    const repo = await repository(t);
    await writeFile(join(repo.root, 'tracked.txt'), 'a\nb\n');
    await repo.git('add', '.');
    await repo.git('commit', '-qm', 'initial');
    // +2 -1 against HEAD.
    await writeFile(join(repo.root, 'tracked.txt'), 'a\nc\nd\n');
    // Thirty files of two lines each: +60.
    await mkdir(join(repo.root, 'notes'));
    for (let index = 0; index < 30; index++)
      await writeFile(join(repo.root, 'notes', `n${index}.txt`), 'x\ny\n');
    // Names Git must receive intact: +3, +1, and +2 without a final newline.
    await writeFile(join(repo.root, 'with space.md'), 'a\nb\nc\n');
    await writeFile(join(repo.root, 'new\nline.md'), 'a\n');
    await writeFile(join(repo.root, 'ünï code ✓.md'), 'a\nb');
    // A binary file and an empty file add no lines.
    await writeFile(join(repo.root, 'bin.dat'), Buffer.from([0, 1, 2, 0]));
    await writeFile(join(repo.root, 'empty.txt'), '');
    // A link is new content of one line, its target: +1.
    await symlink('with space.md', join(repo.root, 'link'));
    // A repository nested in this one is an untracked directory: nothing.
    await committed(join(repo.root, 'vendor'), { 'lib.ts': 'a\nb\nc\n' });

    assert.deepEqual(await totals(projectOver(t, repo.sandbox)), [
      { path: '', added: 69, removed: 1 },
    ]);
  });

  test('compares every change of an unborn branch with empty', async (t) => {
    const repo = await repository(t);
    await writeFile(join(repo.root, 'staged.ts'), '1\n2\n');
    await writeFile(join(repo.root, 'gone.ts'), '1\n2\n3\n');
    await repo.git('add', '.');
    // Staged, then deleted: nothing is there to count.
    await unlink(join(repo.root, 'gone.ts'));
    await writeFile(join(repo.root, 'loose.ts'), '1\n');
    const project = projectOver(t, repo.sandbox);

    assert.deepEqual(await totals(project), [
      { path: '', added: 3, removed: 0 },
    ]);
    const staged = await comparison(project, '', 'staged.ts');
    assert.deepEqual(
      staged && [staged.status, staged.original, staged.modified],
      ['added', '', '1\n2\n'],
    );
  });

  test('costs the same round trips however many files are untracked', async (t) => {
    const execsFor = async (untracked: number) => {
      const repo = await repository(t);
      await writeFile(join(repo.root, 'tracked.txt'), 'a\n');
      await repo.git('add', '.');
      await repo.git('commit', '-qm', 'initial');
      await writeFile(join(repo.root, 'tracked.txt'), 'b\n');
      for (let index = 0; index < untracked; index++)
        await writeFile(join(repo.root, `u${index}.txt`), 'x\n');
      const { sandbox, counter } = counted(repo.sandbox);
      const [read] = await totals(projectOver(t, sandbox));
      assert.equal(read?.added, 1 + untracked);
      return counter.execs;
    };

    assert.equal(await execsFor(40), await execsFor(2));
  });
});

describe('fileDiff comparisons', () => {
  test('finds a renamed file, its origin and a name with pattern characters', async (t) => {
    const repo = await repository(t);
    await writeFile(join(repo.root, 'old.ts'), 'one\ntwo\n');
    await writeFile(join(repo.root, 'a.ts'), 'keep\n');
    await writeFile(join(repo.root, 'a*.ts'), 'star\n');
    await writeFile(join(repo.root, 'ab.ts'), 'plain\n');
    await writeFile(join(repo.root, 'kept.ts'), 'kept\n');
    await repo.git('add', '.');
    await repo.git('commit', '-qm', 'initial');
    await repo.git('mv', 'old.ts', 'new.ts');
    await writeFile(join(repo.root, 'new.ts'), 'one\ntwo\nthree\n');
    // A renamed file whose old name holds a new, untracked file.
    await repo.git('mv', 'a.ts', 'moved.ts');
    await writeFile(join(repo.root, 'a.ts'), 'again\n');
    await writeFile(join(repo.root, 'a*.ts'), 'star!\n');
    await writeFile(join(repo.root, 'ab.ts'), 'plain!\n');
    await rm(join(repo.root, 'kept.ts'));
    await mkdir(join(repo.root, 'docs'));
    await writeFile(join(repo.root, 'docs', 'ünï code.md'), 'hello\n');
    const project = projectOver(t, repo.sandbox);

    const renamed = await comparison(project, '', 'new.ts');
    assert.deepEqual(
      renamed && {
        status: renamed.status,
        originalPath: renamed.originalPath,
        original: renamed.original,
        modified: renamed.modified,
      },
      {
        status: 'renamed',
        originalPath: 'old.ts',
        original: 'one\ntwo\n',
        modified: 'one\ntwo\nthree\n',
      },
    );
    // A rename's origin is no change of its own.
    assert.equal(await comparison(project, '', 'old.ts'), undefined);
    assert.equal((await comparison(project, '', 'a.ts'))?.status, 'untracked');

    const star = await comparison(project, '', 'a*.ts');
    assert.deepEqual(star && [star.original, star.modified], [
      'star\n',
      'star!\n',
    ]);
    const deleted = await comparison(project, '', 'kept.ts');
    assert.deepEqual(
      deleted && [deleted.status, deleted.original, deleted.modified],
      ['deleted', 'kept\n', ''],
    );
    const unicode = await comparison(project, '', 'docs/ünï code.md');
    assert.deepEqual(
      unicode && [unicode.status, unicode.original, unicode.modified],
      ['untracked', '', 'hello\n'],
    );
  });

  test('compares only in the repositories the workspace lists', async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'doric-git-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const web = join(root, 'apps', 'web');
    await committed(web, { 'index.ts': 'a\n' });
    await writeFile(join(web, 'index.ts'), 'b\n');
    await writeFile(join(web, 'draft.ts'), 'draft\n');
    // A repository inside another belongs to the outer one's tree.
    const inner = join(web, 'vendor', 'inner');
    await committed(inner, { 'x.ts': 'x\n' });
    await writeFile(join(inner, 'x.ts'), 'y\n');
    await symlink(join('apps', 'web'), join(root, 'alias'));
    const project = projectOver(t, localSandbox(root));

    const listed = await project.changes({});
    assert.deepEqual(
      listed.status === 'ready' && listed.value.status === 'read'
        ? listed.value.repositories.map((repository) => repository.path)
        : listed.status,
      ['apps/web'],
    );
    const modified = await comparison(project, 'apps/web', 'index.ts');
    assert.deepEqual(modified && [modified.original, modified.modified], [
      'a\n',
      'b\n',
    ]);
    assert.equal(
      (await comparison(project, 'apps/web', 'draft.ts'))?.modified,
      'draft\n',
    );
    for (const [repository, path] of [
      ['apps/web/vendor/inner', 'x.ts'],
      ['apps', 'web/index.ts'],
      ['', 'apps/web/index.ts'],
      ['apps/web/', 'index.ts'],
      ['apps//web', 'index.ts'],
      ['alias', 'index.ts'],
      ['apps/mobile', 'index.ts'],
    ] as const)
      assert.equal(
        await comparison(project, repository, path),
        undefined,
        `${repository}:${path}`,
      );
  });

  test('reads a file the workspace renamed from outside Git as untracked', async (t) => {
    const repo = await repository(t);
    await writeFile(join(repo.root, 'one.ts'), 'one\n');
    await repo.git('add', '.');
    await repo.git('commit', '-qm', 'initial');
    await rename(join(repo.root, 'one.ts'), join(repo.root, 'two.ts'));
    const project = projectOver(t, repo.sandbox);

    const added = await comparison(project, '', 'two.ts');
    assert.deepEqual(added && [added.status, added.original, added.modified], [
      'untracked',
      '',
      'one\n',
    ]);
    const removed = await comparison(project, '', 'one.ts');
    assert.deepEqual(
      removed && [removed.status, removed.original, removed.modified],
      ['deleted', 'one\n', ''],
    );
  });
});

// Bundle isolation 7(c), P2: the cases of the runtime's provisional
// `file-changes` and `workspace-files` tests that no test of this bundle
// stated yet, before the step deletes them.
describe('changes, diffs and comparisons the runtime used to read', () => {
  /** What `fileDiff` cuts a side at: 256 KiB. */
  const limit = 256 * 1024;

  const read = async (project: Project) => {
    const outcome = await project.changes({});
    if (outcome.status !== 'ready' || outcome.value.status !== 'read')
      throw new Error('expected a read');
    return outcome.value.repositories;
  };

  test('keeps special names through a rename, and reads a file staged and changed again as both, without patches', async (t) => {
    const repo = await repository(t);
    await writeFile(join(repo.root, 'old -> name\n.ts'), 'original\n');
    await writeFile(join(repo.root, 'edited.ts'), 'original\n');
    await repo.git('add', '.');
    await repo.git('commit', '-qm', 'initial');
    await rename(
      join(repo.root, 'old -> name\n.ts'),
      join(repo.root, 'new "name".ts'),
    );
    await writeFile(join(repo.root, 'edited.ts'), 'staged\n');
    await repo.git('add', '.');
    await writeFile(join(repo.root, 'edited.ts'), 'unstaged\n');
    await writeFile(join(repo.root, 'untracked\nfile.ts'), 'new\n');
    const project = projectOver(t, repo.sandbox);

    const [workspace] = await read(project);
    // edited.ts: +1 -1 against HEAD; the untracked file: +1; the rename: 0.
    assert.deepEqual([workspace?.added, workspace?.removed], [2, 1]);
    assert.equal('diff' in (workspace ?? {}), false);
    const renamed = workspace?.changes.find(
      (change) => change.status === 'renamed',
    );
    assert.deepEqual(renamed && [renamed.path, renamed.originalPath], [
      'new "name".ts',
      'old -> name\n.ts',
    ]);
    const edited = workspace?.changes.find(
      (change) => change.path === 'edited.ts',
    );
    assert.deepEqual(edited && [edited.staged, edited.unstaged], [true, true]);
    assert.equal(
      workspace?.changes.find((change) => change.path === 'untracked\nfile.ts')
        ?.status,
      'untracked',
    );
    const moved = await comparison(project, '', 'new "name".ts');
    assert.deepEqual(moved && [moved.original, moved.modified], [
      'original\n',
      'original\n',
    ]);
  });

  test('compares additions, deletions, binaries and files beyond the limit, each side on its own', async (t) => {
    const repo = await repository(t);
    await writeFile(join(repo.root, 'gone.ts'), 'old\n');
    await writeFile(join(repo.root, 'old-binary.dat'), 'old\0bytes');
    await writeFile(join(repo.root, 'old-large.txt'), 'x'.repeat(limit + 10));
    await repo.git('add', '.');
    await repo.git('commit', '-qm', 'initial');
    await rm(join(repo.root, 'gone.ts'));
    await writeFile(join(repo.root, 'new.ts'), 'new\n');
    await writeFile(join(repo.root, 'binary.dat'), 'a\0b');
    await writeFile(join(repo.root, 'large.txt'), 'x'.repeat(limit + 10));
    await writeFile(join(repo.root, 'old-binary.dat'), 'now text');
    await writeFile(join(repo.root, 'old-large.txt'), 'now short');
    const project = projectOver(t, repo.sandbox);

    assert.deepEqual(await totals(project), [
      { path: '', added: 3, removed: 2 },
    ]);
    const added = await comparison(project, '', 'new.ts');
    assert.deepEqual(added && [added.original, added.modified], ['', 'new\n']);
    const deleted = await comparison(project, '', 'gone.ts');
    assert.deepEqual(deleted && [deleted.original, deleted.modified], [
      'old\n',
      '',
    ]);
    const binary = await comparison(project, '', 'binary.dat');
    assert.deepEqual(binary && [binary.binary, binary.modified], [true, '']);
    const large = await comparison(project, '', 'large.txt');
    assert.deepEqual(large && [large.truncated, large.modified.length], [
      true,
      limit,
    ]);
    const wasBinary = await comparison(project, '', 'old-binary.dat');
    assert.deepEqual(wasBinary && [wasBinary.binary, wasBinary.original], [
      true,
      '',
    ]);
    const wasLarge = await comparison(project, '', 'old-large.txt');
    assert.deepEqual(
      wasLarge && [wasLarge.truncated, wasLarge.original.length],
      [true, limit],
    );
  });

  test('does not count a staged edit that the working tree reverses', async (t) => {
    const repo = await repository(t);
    await writeFile(join(repo.root, 'file\tname.txt'), 'one\ntwo\n');
    await repo.git('add', '.');
    await repo.git('commit', '-qm', 'initial');
    await writeFile(join(repo.root, 'file\tname.txt'), 'three\n');
    await repo.git('add', '.');
    await writeFile(join(repo.root, 'file\tname.txt'), 'one\ntwo\n');

    const [workspace] = await read(projectOver(t, repo.sandbox));
    assert.equal(workspace?.changes.length, 1);
    assert.deepEqual([workspace?.added, workspace?.removed], [0, 0]);
  });

  test('reads an unresolved merge as conflicted, comparing HEAD with the marked file', async (t) => {
    const repo = await repository(t);
    await writeFile(join(repo.root, 'conflict.ts'), 'base\n');
    await repo.git('add', '.');
    await repo.git('commit', '-qm', 'initial');
    await repo.git('switch', '-qc', 'other');
    await writeFile(join(repo.root, 'conflict.ts'), 'other\n');
    await repo.git('commit', '-qam', 'other');
    await repo.git('switch', '-q', 'main');
    await writeFile(join(repo.root, 'conflict.ts'), 'current\n');
    await repo.git('commit', '-qam', 'current');
    await assert.rejects(repo.git('merge', 'other'));
    const project = projectOver(t, repo.sandbox);

    const [workspace] = await read(project);
    assert.equal(workspace?.changes[0]?.status, 'conflicted');
    const conflict = await comparison(project, '', 'conflict.ts');
    assert.equal(conflict?.original, 'current\n');
    assert.match(conflict?.modified ?? '', /<<<<<<< HEAD/u);
  });

  test('reads one tracked diff per repository, each with its own changes', async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'doric-git-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const alpha = await committed(join(root, 'alpha'), {
      'old.ts': 'old\n',
    });
    await mkdir(join(root, 'alpha', 'src'));
    for (const name of ['a.ts', 'gone.ts'])
      await writeFile(join(root, 'alpha', 'src', name), `${name}\n`);
    await alpha('add', '.');
    await alpha('commit', '-qm', 'sources');
    await writeFile(join(root, 'alpha', 'src', 'a.ts'), 'changed\n');
    await writeFile(join(root, 'alpha', 'src', 'b.ts'), 'b\n');
    await alpha('add', 'src/b.ts');
    await alpha('rm', '-q', 'src/gone.ts');
    await alpha('mv', 'old.ts', 'new.ts');
    await writeFile(join(root, 'alpha', 'src', 'new.ts'), 'new\n');
    await committed(join(root, 'beta'), { 'b.ts': 'b\n' });
    await writeFile(join(root, 'beta', 'b.ts'), 'changed\n');
    const project = projectOver(t, localSandbox(root));

    const outcome = await project.diff({});
    if (outcome.status !== 'ready' || outcome.value.status !== 'read')
      throw new Error('expected a read');
    const byPath = new Map(
      outcome.value.repositories.map((repository) => [
        repository.path,
        repository,
      ]),
    );
    assert.deepEqual([...byPath.keys()].sort(), ['alpha', 'beta']);
    assert.deepEqual(
      byPath
        .get('alpha')
        ?.changes.map(({ path, status }) => `${status} ${path}`)
        .sort(),
      [
        'added src/b.ts',
        'deleted src/gone.ts',
        'modified src/a.ts',
        'renamed new.ts',
        'untracked src/new.ts',
      ],
    );
    assert.match(byPath.get('alpha')?.diff ?? '', /src\/a\.ts/u);
    assert.deepEqual(
      byPath
        .get('beta')
        ?.changes.map(({ path, status }) => `${status} ${path}`),
      ['modified b.ts'],
    );
    assert.match(byPath.get('beta')?.diff ?? '', /b\.ts/u);
  });

  test('reads no repository in a workspace that holds none, and echoes a path a diff asks for', async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'doric-git-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'a.ts'), 'x\n');
    const plain = await projectOver(t, localSandbox(root)).diff({});
    assert.deepEqual(
      plain.status === 'ready' && plain.value.status === 'read'
        ? plain.value.repositories
        : plain.status,
      [],
    );

    await committed(join(root, 'alpha'), { 'a.ts': 'a\n' });
    await writeFile(join(root, 'alpha', 'a.ts'), 'b\n');
    const project = projectOver(t, localSandbox(root));
    const scoped = await project.diff({ path: 'alpha' });
    if (scoped.status !== 'ready' || scoped.value.status !== 'read')
      throw new Error('expected a read');
    assert.equal(scoped.value.path, 'alpha');
    assert.deepEqual(
      scoped.value.repositories.map((repository) => repository.path),
      ['alpha'],
    );
    assert.deepEqual(await project.diff({ path: '../outside' }), {
      status: 'ready',
      value: { status: 'invalid_path' },
    });
  });
});
