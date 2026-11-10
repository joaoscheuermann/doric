// git.commands/v1@1.1.0 `discard` (ui-redesign §4.4, T-4.4.3, T-4.4.4,
// T-4.4.5, T-4.4.15), on real repositories through a fake runtime. Discard is
// not recoverable, so every refusal is checked to leave the workspace exactly
// as it was, and every effect is checked on the files and the index.

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';

import { isContractError } from 'bundle/contracts';
import type { Sandbox } from 'sandbox';

import type { Discard } from '../src/contracts/index.js';
import { createGitService } from '../src/host/service.js';
import {
  type FakeRuntime,
  fakeRuntime,
  gitOver,
  localSandbox,
  repository,
  terminal,
} from './support/runtime.js';

const run = promisify(execFile);

const staleCwd =
  'The working directory changed. Reopen the Changes view and try again.';
const busy =
  'Wait for active prompts and terminal commands in this repository to finish before discarding changes.';
const notRepository = (repository: string) =>
  `${repository} is not a repository of this working directory.`;
const noChange = (path: string) => `${path} has no change to discard.`;
const separate = (path: string) =>
  `${path} is a separate repository. Discard does not change it.`;
const conflict = (path: string) =>
  `${path} has a merge conflict. Resolve it before discarding.`;
const stillChanged = (path: string) =>
  `${path} still has changes after Discard.`;

type Git = (...args: string[]) => Promise<string>;

const gitIn =
  (dir: string): Git =>
  async (...args) =>
    (
      await run('git', [
        '-C',
        dir,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        ...args,
      ])
    ).stdout;

const write = async (root: string, path: string, content: string) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
};

/** A repository at the workspace root with `files` committed. */
const committed = async (t: TestContext, files: Record<string, string>) => {
  const repo = await repository(t);
  for (const [path, content] of Object.entries(files))
    await write(repo.root, path, content);
  await repo.git('add', '-A');
  await repo.git('commit', '-qm', 'initial');
  return repo;
};

/** A new repository at `dir` with `files` committed. */
const nestedRepository = async (
  dir: string,
  files: Record<string, string>,
): Promise<Git> => {
  await mkdir(dir, { recursive: true });
  const git = gitIn(dir);
  await git('init', '-q', '-b', 'main');
  for (const [path, content] of Object.entries(files))
    await write(dir, path, content);
  await git('add', '-A');
  await git('commit', '-qm', 'initial');
  return git;
};

/** A workspace root that is not a repository. */
const emptyWorkspace = async (t: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'doric-discard-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

/** `git status` as `XY path[ <- origin]` lines, in Git's order. */
const status = async (git: Git): Promise<string[]> => {
  const records = (
    await git('status', '--porcelain=v1', '-z', '--untracked-files=all')
  ).split('\0');
  const lines: string[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index] ?? '';
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    lines.push(
      code.includes('R') || code.includes('C')
        ? `${record} <- ${records[++index]}`
        : record,
    );
  }
  return lines;
};

/** Every file and symlink under `root` (outside `.git`), with its content. */
const files = async (root: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) out[path] = `-> ${await readlink(full)}`;
      else if (entry.isDirectory()) await walk(full, path);
      else out[path] = await readFile(full, 'utf8');
    }
  };
  await walk(root, '');
  return out;
};

/** The files, and each repository's index and status, to prove nothing changed. */
const snapshot = async (root: string, repos: readonly string[] = ['']) =>
  JSON.stringify({
    files: await files(root),
    repos: await Promise.all(
      repos.map(async (repo) => {
        const git = gitIn(join(root, repo));
        return [
          await git('ls-files', '--stage'),
          await status(git),
          await git('rev-parse', '--verify', '--quiet', 'HEAD').catch(
            () => 'unborn',
          ),
        ];
      }),
    ),
  });

/** `discard` on `thread-1` of a fake runtime over `sandbox`. */
const discarder = (t: TestContext, sandbox: Sandbox, runtime: FakeRuntime) => {
  const { git, dispose } = gitOver(sandbox, runtime);
  t.after(dispose);
  return (input: {
    readonly cwd?: string;
    readonly repository?: string;
    readonly paths?: readonly string[];
  }): Promise<Discard> =>
    git({ threadId: 'thread-1' }).discard({
      threadId: 'thread-1',
      cwd: input.cwd ?? runtime.cwd,
      repository: input.repository ?? '',
      ...(input.paths === undefined ? {} : { paths: input.paths }),
    });
};

const sorted = (outcome: Discard): Discard =>
  outcome.status === 'ready'
    ? {
        status: 'ready',
        value: { discarded: [...outcome.value.discarded].sort() },
      }
    : outcome.status === 'failed'
      ? { ...outcome, discarded: [...outcome.discarded].sort() }
      : outcome;

const isDiscardCommand = (cmd: readonly string[]) =>
  cmd[0] === 'git' &&
  cmd.some((arg) => ['clean', 'restore', 'rm'].includes(arg));

/** A sandbox whose commands `skip` selects exit 0 without running. */
const skipping = (
  sandbox: Sandbox,
  skip: (cmd: readonly string[]) => boolean,
  seen: string[][] = [],
): Sandbox => ({
  ...sandbox,
  exec: async (input) => {
    seen.push([...input.cmd]);
    if (!skip(input.cmd)) return sandbox.exec(input);
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      stdoutBytes: Buffer.alloc(0),
      stderrBytes: Buffer.alloc(0),
    };
  },
});

describe('git.commands/v1 discard: contract (T-4.4.15)', () => {
  test('is exposed to the desktop', () => {
    assert.equal(
      createGitService(() => undefined).methods.discard.expose,
      'desktop',
    );
  });

  test('an empty `paths` is invalid input; Discard all sends none', async (t) => {
    const repo = await committed(t, { 'a.txt': 'a\n' });
    await write(repo.root, 'u.txt', 'untracked\n');
    const before = await snapshot(repo.root);
    const { git, dispose } = gitOver(
      repo.sandbox,
      fakeRuntime({ cwd: repo.root }),
    );
    t.after(dispose);

    // The dispatcher validates before it calls, and may throw synchronously.
    await assert.rejects(
      async () =>
        git({ threadId: 'thread-1' }).discard({
          threadId: 'thread-1',
          cwd: repo.root,
          repository: '',
          paths: [],
        }),
      (error) => isContractError(error) && error.code === 'invalid_input',
    );
    assert.equal(await snapshot(repo.root), before);
  });

  test('runs under the Project lock and passes a Thread state through', async (t) => {
    const repo = await committed(t, { 'a.txt': 'a\n' });
    const runtime = fakeRuntime({ cwd: repo.root });
    await discarder(t, repo.sandbox, runtime)({});
    assert.deepEqual(runtime.threads, [
      { threadId: 'thread-1', options: { exclusive: true } },
    ]);

    for (const state of ['missing', 'inactive', 'pending'] as const)
      assert.deepEqual(
        await discarder(
          t,
          repo.sandbox,
          fakeRuntime({ thread: state, cwd: repo.root }),
        )({}),
        { status: state },
      );
  });
});

describe('git.commands/v1 discard: guards (T-4.4.3)', () => {
  test('a working directory other than the Thread’s is refused first', async (t) => {
    const repo = await committed(t, { 'a.txt': 'a\n' });
    await write(repo.root, 'a.txt', 'edited\n');
    const before = await snapshot(repo.root);
    const discard = discarder(
      t,
      repo.sandbox,
      fakeRuntime({ cwd: repo.root, busy: [repo.root] }),
    );

    assert.deepEqual(
      await discard({ cwd: join(repo.root, 'elsewhere'), repository: '/x' }),
      { status: 'refused', message: staleCwd },
    );
    assert.equal(await snapshot(repo.root), before);
  });

  /** `app` (the target, with `app/lib` nested in it) and `other`, unrelated. */
  const projects = async (t: TestContext) => {
    const root = await emptyWorkspace(t);
    await nestedRepository(join(root, 'app'), { 'src/a.txt': 'a\n' });
    await nestedRepository(join(root, 'app', 'lib'), { 'l.txt': 'l\n' });
    await nestedRepository(join(root, 'other'), { 'o.txt': 'o\n' });
    await write(root, 'app/src/a.txt', 'edited\n');
    await write(root, 'app/new.txt', 'new\n');
    await write(root, 'other/o.txt', 'edited\n');
    return { root, sandbox: localSandbox(root) };
  };

  test('running work inside, nested in, or above the repository refuses it', async (t) => {
    const { root, sandbox } = await projects(t);
    const before = await snapshot(root, ['app', 'app/lib', 'other']);
    const cwd = join(root, 'app');

    const blocked: Partial<FakeRuntime>[] = [
      { busy: [join(root, 'app')] },
      { busy: [join(root, 'app', 'src')] },
      { busy: [join(root, 'app', 'lib')] },
      { busy: [root] },
      { busy: [`${root}/other/../app/src`] },
      { terminals: [terminal({ origin: 'agent', cwd: join(root, 'app') })] },
      {
        terminals: [
          terminal({
            origin: 'user',
            command: 'npm run dev',
            cwd: join(root, 'app', 'lib'),
          }),
        ],
      },
      // Outside the sandbox mount, a directory above every repository.
      { terminals: [terminal({ origin: 'agent', cwd: '/' })] },
    ];
    for (const work of blocked)
      assert.deepEqual(
        await discarder(
          t,
          sandbox,
          fakeRuntime({ cwd, ...work }),
        )({
          repository: 'app',
        }),
        { status: 'refused', message: busy },
        JSON.stringify(work),
      );
    assert.equal(await snapshot(root, ['app', 'app/lib', 'other']), before);
  });

  test('running work in an unrelated repository, or an idle shell, does not', async (t) => {
    const { root, sandbox } = await projects(t);
    const outcome = await discarder(
      t,
      sandbox,
      fakeRuntime({
        cwd: join(root, 'app'),
        busy: [join(root, 'other')],
        terminals: [
          terminal({ origin: 'user', command: 'bash', cwd: join(root, 'app') }),
          terminal({ state: 'exited', cwd: join(root, 'app') }),
          terminal({ origin: 'agent', cwd: join(root, 'other', 'x') }),
        ],
      }),
    )({ repository: 'app' });

    assert.deepEqual(sorted(outcome), {
      status: 'ready',
      value: { discarded: ['new.txt', 'src/a.txt'] },
    });
    assert.equal(await readFile(join(root, 'app/src/a.txt'), 'utf8'), 'a\n');
    assert.equal(await readFile(join(root, 'other/o.txt'), 'utf8'), 'edited\n');
  });

  test('a repository the Thread’s scope does not list is refused', async (t) => {
    const { root, sandbox } = await projects(t);
    const before = await snapshot(root, ['app', 'app/lib', 'other']);
    const discard = discarder(
      t,
      sandbox,
      fakeRuntime({ cwd: join(root, 'app') }),
    );

    for (const repository of ['other', 'app/lib', 'missing', ''])
      assert.deepEqual(await discard({ repository }), {
        status: 'refused',
        message: notRepository(repository),
      });
    assert.equal(await snapshot(root, ['app', 'app/lib', 'other']), before);
  });
});

describe('git.commands/v1 discard: targets (T-4.4.4)', () => {
  test('a path with no listed change is refused and nothing changes', async (t) => {
    const repo = await committed(t, {
      'a.txt': 'a\n',
      'k.txt': 'keep\n',
      '.gitignore': '.env\n',
      'dir/inside.txt': 'inside\n',
    });
    await write(repo.root, 'a.txt', 'edited\n');
    await write(repo.root, '.env', 'SECRET=1\n');
    await symlink(join(repo.root, 'dir'), join(repo.root, 'link'));
    await write(repo.root, 'dir/inside.txt', 'edited inside\n');
    const before = await snapshot(repo.root);
    const discard = discarder(t, repo.sandbox, fakeRuntime({ cwd: repo.root }));

    for (const path of [
      'k.txt',
      '.env',
      'ghost.txt',
      join(repo.root, 'a.txt'),
      '/a.txt',
      '../a.txt',
      'dir/../a.txt',
      'link/inside.txt',
    ])
      assert.deepEqual(
        await discard({ paths: [path] }),
        { status: 'refused', message: noChange(path) },
        path,
      );
    // One refused path refuses the whole call.
    assert.deepEqual(await discard({ paths: ['a.txt', 'k.txt'] }), {
      status: 'refused',
      message: noChange('k.txt'),
    });
    assert.equal(await snapshot(repo.root), before);
  });

  test('a repository with NUL, a leading `/` or `..`, or unlisted, is refused', async (t) => {
    const repo = await committed(t, { 'a.txt': 'a\n' });
    await write(repo.root, 'a.txt', 'edited\n');
    const before = await snapshot(repo.root);
    const discard = discarder(t, repo.sandbox, fakeRuntime({ cwd: repo.root }));

    for (const repository of [
      'a\0b',
      '/',
      repo.root,
      '..',
      'x/..',
      '../x',
      'nope',
    ])
      assert.deepEqual(
        await discard({ repository }),
        { status: 'refused', message: notRepository(repository) },
        JSON.stringify(repository),
      );
    assert.equal(await snapshot(repo.root), before);
  });

  test('a nested repository and a submodule are never changed', async (t) => {
    const source = await emptyWorkspace(t);
    await nestedRepository(source, { 'm.txt': 'm\n' });
    const repo = await committed(t, { 'a.txt': 'a\n' });
    await repo.git(
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      source,
      'mod',
    );
    await repo.git('commit', '-qm', 'submodule');
    const mod = gitIn(join(repo.root, 'mod'));
    await write(repo.root, 'mod/m.txt', 'moved on\n');
    await mod('commit', '-qam', 'ahead');
    const modHead = await mod('rev-parse', 'HEAD');
    await nestedRepository(join(repo.root, 'sub'), { 's.txt': 's\n' });
    await write(repo.root, 'sub/s.txt', 'nested edit\n');
    await write(repo.root, 'u.txt', 'untracked\n');
    assert.deepEqual(await status(repo.git), [' M mod', '?? sub/', '?? u.txt']);
    const before = await snapshot(repo.root, ['', 'sub', 'mod']);
    const discard = discarder(t, repo.sandbox, fakeRuntime({ cwd: repo.root }));

    assert.deepEqual(await discard({ paths: ['sub/'] }), {
      status: 'refused',
      message: separate('sub/'),
    });
    assert.deepEqual(await discard({ paths: ['u.txt', 'mod'] }), {
      status: 'refused',
      message: separate('mod'),
    });
    assert.equal(await snapshot(repo.root, ['', 'sub', 'mod']), before);

    assert.deepEqual(await discard({}), {
      status: 'ready',
      value: { discarded: ['u.txt'] },
    });
    assert.deepEqual(await status(repo.git), [' M mod', '?? sub/']);
    assert.equal(
      await readFile(join(repo.root, 'sub/s.txt'), 'utf8'),
      'nested edit\n',
    );
    assert.equal(await mod('rev-parse', 'HEAD'), modHead);
  });

  test('a pathspec character in a name names that file only', async (t) => {
    const repo = await committed(t, { 'a.txt': 'a\n' });
    for (const name of ['x*', 'xa', ':!xa', 'b[1].txt', 'b1.txt'])
      await write(repo.root, name, `${name}\n`);
    const discard = discarder(t, repo.sandbox, fakeRuntime({ cwd: repo.root }));

    assert.deepEqual(
      sorted(await discard({ paths: ['x*', ':!xa', 'b[1].txt'] })),
      {
        status: 'ready',
        value: { discarded: [':!xa', 'b[1].txt', 'x*'] },
      },
    );
    assert.deepEqual(await status(repo.git), ['?? b1.txt', '?? xa']);
  });

  test('Discard all takes only the changes the working directory reads', async (t) => {
    const repo = await committed(t, { 'src/a.txt': 'a\n', 'top.txt': 't\n' });
    await write(repo.root, 'src/a.txt', 'edited\n');
    await write(repo.root, 'src/new.txt', 'new\n');
    await write(repo.root, 'top.txt', 'edited\n');
    await write(repo.root, 'loose.txt', 'loose\n');
    const cwd = join(repo.root, 'src');
    const discard = discarder(t, repo.sandbox, fakeRuntime({ cwd }));

    assert.deepEqual(await discard({ paths: ['top.txt'] }), {
      status: 'refused',
      message: noChange('top.txt'),
    });
    assert.deepEqual(sorted(await discard({})), {
      status: 'ready',
      value: { discarded: ['src/a.txt', 'src/new.txt'] },
    });
    assert.deepEqual(await status(repo.git), [' M top.txt', '?? loose.txt']);
  });
});

describe('git.commands/v1 discard: effects (T-4.4.5)', () => {
  /** One repository holding every kind of change Discard handles. */
  const changed = async (t: TestContext) => {
    const repo = await committed(t, {
      '.gitignore': '*.log\n',
      'both.txt': 'head\n',
      'gone.txt': 'gone\n',
      'staged-gone.txt': 'staged gone\n',
      'origin.txt': 'origin\n',
      'keep.txt': 'keep\n',
    });
    await write(repo.root, 'untracked.txt', 'u\n');
    await write(repo.root, 'dir/one.txt', '1\n');
    await write(repo.root, 'dir/deep/two.txt', '2\n');
    await write(repo.root, 'dir/debug.log', 'ignored\n');
    await write(repo.root, 'added.txt', 'added\n');
    await repo.git('add', 'added.txt');
    await write(repo.root, 'both.txt', 'staged\n');
    await repo.git('add', 'both.txt');
    await write(repo.root, 'both.txt', 'staged and unstaged\n');
    await unlink(join(repo.root, 'gone.txt'));
    await repo.git('rm', '-q', 'staged-gone.txt');
    await repo.git('mv', 'origin.txt', 'moved.txt');
    await write(repo.root, 'ad.txt', 'ad\n');
    await repo.git('add', 'ad.txt');
    await unlink(join(repo.root, 'ad.txt'));
    await write(repo.root, 'am.txt', 'am\n');
    await repo.git('add', 'am.txt');
    await write(repo.root, 'am.txt', 'am edited\n');
    assert.deepEqual(await status(repo.git), [
      'AD ad.txt',
      'A  added.txt',
      'AM am.txt',
      'MM both.txt',
      ' D gone.txt',
      'R  moved.txt <- origin.txt',
      'D  staged-gone.txt',
      '?? dir/deep/two.txt',
      '?? dir/one.txt',
      '?? untracked.txt',
    ]);
    return repo;
  };

  const committedFiles = {
    '.gitignore': '*.log\n',
    'both.txt': 'head\n',
    'gone.txt': 'gone\n',
    'staged-gone.txt': 'staged gone\n',
    'origin.txt': 'origin\n',
    'keep.txt': 'keep\n',
  };

  test('Discard all returns the repository to HEAD, keeping ignored files', async (t) => {
    const repo = await changed(t);
    const discard = discarder(t, repo.sandbox, fakeRuntime({ cwd: repo.root }));

    assert.deepEqual(sorted(await discard({})), {
      status: 'ready',
      value: {
        discarded: [
          'ad.txt',
          'added.txt',
          'am.txt',
          'both.txt',
          'dir/deep/two.txt',
          'dir/one.txt',
          'gone.txt',
          'moved.txt',
          'staged-gone.txt',
          'untracked.txt',
        ],
      },
    });
    assert.deepEqual(await status(repo.git), []);
    assert.equal(await repo.git('diff', 'HEAD'), '');
    assert.deepEqual(await files(repo.root), {
      ...committedFiles,
      'dir/debug.log': 'ignored\n',
    });
  });

  test('each path alone has its own effect and leaves the others', async (t) => {
    const repo = await changed(t);
    const discard = discarder(t, repo.sandbox, fakeRuntime({ cwd: repo.root }));
    const expect = async (path: string, remaining: string[]) => {
      assert.deepEqual(await discard({ paths: [path] }), {
        status: 'ready',
        value: { discarded: [path] },
      });
      assert.deepEqual(await status(repo.git), remaining, path);
    };

    await expect('untracked.txt', [
      'AD ad.txt',
      'A  added.txt',
      'AM am.txt',
      'MM both.txt',
      ' D gone.txt',
      'R  moved.txt <- origin.txt',
      'D  staged-gone.txt',
      '?? dir/deep/two.txt',
      '?? dir/one.txt',
    ]);
    await expect('added.txt', [
      'AD ad.txt',
      'AM am.txt',
      'MM both.txt',
      ' D gone.txt',
      'R  moved.txt <- origin.txt',
      'D  staged-gone.txt',
      '?? dir/deep/two.txt',
      '?? dir/one.txt',
    ]);
    assert.equal(
      Object.hasOwn(await files(repo.root), 'added.txt'),
      false,
      'a staged new file leaves the working tree',
    );
    await expect('both.txt', [
      'AD ad.txt',
      'AM am.txt',
      ' D gone.txt',
      'R  moved.txt <- origin.txt',
      'D  staged-gone.txt',
      '?? dir/deep/two.txt',
      '?? dir/one.txt',
    ]);
    assert.equal(await readFile(join(repo.root, 'both.txt'), 'utf8'), 'head\n');
    await expect('gone.txt', [
      'AD ad.txt',
      'AM am.txt',
      'R  moved.txt <- origin.txt',
      'D  staged-gone.txt',
      '?? dir/deep/two.txt',
      '?? dir/one.txt',
    ]);
    await expect('staged-gone.txt', [
      'AD ad.txt',
      'AM am.txt',
      'R  moved.txt <- origin.txt',
      '?? dir/deep/two.txt',
      '?? dir/one.txt',
    ]);
    await expect('moved.txt', [
      'AD ad.txt',
      'AM am.txt',
      '?? dir/deep/two.txt',
      '?? dir/one.txt',
    ]);
    assert.equal(
      await readFile(join(repo.root, 'origin.txt'), 'utf8'),
      'origin\n',
    );
    await expect('ad.txt', [
      'AM am.txt',
      '?? dir/deep/two.txt',
      '?? dir/one.txt',
    ]);
    await expect('am.txt', ['?? dir/deep/two.txt', '?? dir/one.txt']);
    await expect('dir/one.txt', ['?? dir/deep/two.txt']);
    assert.equal(
      await readFile(join(repo.root, 'dir/debug.log'), 'utf8'),
      'ignored\n',
    );
    assert.deepEqual(await files(repo.root), {
      ...committedFiles,
      'dir/deep/two.txt': '2\n',
      'dir/debug.log': 'ignored\n',
    });
  });

  test('a copy loses the copy and keeps its origin, with the origin’s own change', async (t) => {
    const repo = await committed(t, { 'a.txt': 'one\ntwo\nthree\nfour\n' });
    await repo.git('config', 'status.renames', 'copies');
    await write(repo.root, 'c.txt', 'one\ntwo\nthree\nfour\n');
    await write(repo.root, 'a.txt', 'one\ntwo\nthree\nfour\nfive\n');
    await repo.git('add', 'a.txt', 'c.txt');
    assert.deepEqual(await status(repo.git), ['M  a.txt', 'C  c.txt <- a.txt']);
    const discard = discarder(t, repo.sandbox, fakeRuntime({ cwd: repo.root }));

    assert.deepEqual(await discard({ paths: ['c.txt'] }), {
      status: 'ready',
      value: { discarded: ['c.txt'] },
    });
    assert.deepEqual(await status(repo.git), ['M  a.txt']);
    assert.equal(
      await readFile(join(repo.root, 'a.txt'), 'utf8'),
      'one\ntwo\nthree\nfour\nfive\n',
    );
  });

  test('a conflicted target refuses the whole call and nothing changes', async (t) => {
    const repo = await committed(t, { 'a.txt': 'base\n' });
    await repo.git('checkout', '-qb', 'other');
    await write(repo.root, 'a.txt', 'theirs\n');
    await repo.git('commit', '-qam', 'theirs');
    await repo.git('checkout', '-q', 'main');
    await write(repo.root, 'a.txt', 'ours\n');
    await repo.git('commit', '-qam', 'ours');
    await repo.git('merge', '-q', 'other').catch(() => undefined);
    await write(repo.root, 'u.txt', 'untracked\n');
    assert.deepEqual(await status(repo.git), ['UU a.txt', '?? u.txt']);
    const before = await snapshot(repo.root);
    const discard = discarder(t, repo.sandbox, fakeRuntime({ cwd: repo.root }));

    for (const input of [{}, { paths: ['u.txt', 'a.txt'] }])
      assert.deepEqual(await discard(input), {
        status: 'refused',
        message: conflict('a.txt'),
      });
    assert.equal(await snapshot(repo.root), before);
  });

  test('a failing command answers failed with what a new read no longer lists', async (t) => {
    const repo = await committed(t, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    await write(repo.root, 'a.txt', 'edited\n');
    await write(repo.root, 'b.txt', 'edited\n');
    await write(repo.root, 'u.txt', 'untracked\n');
    // `restore` needs the index lock; `clean` does not.
    await writeFile(join(repo.root, '.git', 'index.lock'), '');
    t.after(() => rm(join(repo.root, '.git', 'index.lock'), { force: true }));
    const seen: string[][] = [];
    const discard = discarder(
      t,
      skipping(repo.sandbox, () => false, seen),
      fakeRuntime({ cwd: repo.root }),
    );

    const outcome = await discard({ paths: ['u.txt', 'a.txt', 'b.txt'] });
    assert.equal(outcome.status, 'failed');
    if (outcome.status !== 'failed') return;
    assert.notEqual(outcome.message, '');
    assert.equal(outcome.message.includes('\n'), false);
    assert.deepEqual(outcome.discarded, ['u.txt']);
    assert.deepEqual(await status(repo.git), [' M a.txt', ' M b.txt']);
    // The loop stopped at the first failure: b.txt was never attempted.
    assert.deepEqual(
      seen.filter(isDiscardCommand).map((cmd) => cmd.at(-1)),
      ['u.txt', 'a.txt'],
    );
  });

  test('a command that exits 0 but leaves its target listed answers failed', async (t) => {
    const repo = await committed(t, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    await write(repo.root, 'a.txt', 'edited\n');
    await write(repo.root, 'b.txt', 'edited\n');
    const sandbox = skipping(
      repo.sandbox,
      (cmd) => isDiscardCommand(cmd) && cmd.includes('b.txt'),
    );
    const discard = discarder(t, sandbox, fakeRuntime({ cwd: repo.root }));

    assert.deepEqual(await discard({}), {
      status: 'failed',
      message: stillChanged('b.txt'),
      discarded: ['a.txt'],
    });
    assert.deepEqual(await status(repo.git), [' M b.txt']);

    const none = discarder(
      t,
      skipping(repo.sandbox, isDiscardCommand),
      fakeRuntime({ cwd: repo.root }),
    );
    assert.deepEqual(await none({ paths: ['b.txt'] }), {
      status: 'failed',
      message: stillChanged('b.txt'),
      discarded: [],
    });
  });

  test('in a repository without a commit, staged files are removed with `rm`', async (t) => {
    const repo = await repository(t);
    await write(repo.root, 'a.txt', 'a\n');
    await repo.git('add', 'a.txt');
    await write(repo.root, 'am.txt', 'am\n');
    await repo.git('add', 'am.txt');
    await write(repo.root, 'am.txt', 'am edited\n');
    await write(repo.root, 'ad.txt', 'ad\n');
    await repo.git('add', 'ad.txt');
    await unlink(join(repo.root, 'ad.txt'));
    await write(repo.root, 'u.txt', 'u\n');
    assert.deepEqual(await status(repo.git), [
      'A  a.txt',
      'AD ad.txt',
      'AM am.txt',
      '?? u.txt',
    ]);
    const seen: string[][] = [];
    const sandbox = skipping(repo.sandbox, () => false, seen);
    const discard = discarder(t, sandbox, fakeRuntime({ cwd: repo.root }));

    assert.deepEqual(sorted(await discard({})), {
      status: 'ready',
      value: { discarded: ['a.txt', 'ad.txt', 'am.txt', 'u.txt'] },
    });
    assert.deepEqual(await status(repo.git), []);
    assert.deepEqual(await files(repo.root), {});
    const commands = seen.filter(isDiscardCommand);
    assert.equal(commands.filter((cmd) => cmd.includes('rm')).length, 3);
    assert.equal(commands.filter((cmd) => cmd.includes('clean')).length, 1);
    assert.equal(
      commands.some((cmd) => cmd.includes('restore')),
      false,
    );
  });
});
