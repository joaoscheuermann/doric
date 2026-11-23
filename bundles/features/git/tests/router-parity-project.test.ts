// Parity of `git.commands/v1`'s Project methods through the router with the
// kernel service (phase 3, slice S55c, P1–P3): on the same real-git
// workspaces, each routed `Changes`, `Diff` and `FileDiff` answer equals the
// kernel's (`gitOver`) answer as the codec's rules encode it, and the codec's
// message of it passes protovalidate. P2: each lease state passes through the
// same.

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';

import {
  ChangesResponseSchema,
  DiffResponseSchema,
  FileDiffResponseSchema,
} from '../src/contracts/gen/doric/git/commands/v1/commands_pb.js';
import {
  changesResponseOf,
  diffResponseOf,
  fileDiffResponseOf,
} from '../src/host/codec.js';
import { assertParity, fixGitDates } from './support/parity.js';
import {
  commandsHarness,
  type LeaseStatus,
} from './support/router-commands.js';
import { fakeRuntime, gitOver, localSandbox } from './support/runtime.js';

fixGitDates();

const run = promisify(execFile);

/** The limit a comparison side is cut at (256 KiB). */
const limit = 256 * 1024;

const write = async (root: string, path: string, content: string) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
};

/** A committed repository at `dir` with `files`; answers its `git`. */
const committedAt = async (dir: string, files: Record<string, string>) => {
  await mkdir(dir, { recursive: true });
  const git = async (...args: string[]) =>
    (await run('git', ['-C', dir, ...args])).stdout;
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.com');
  for (const [path, content] of Object.entries(files))
    await write(dir, path, content);
  await git('add', '-A');
  await git('commit', '-qm', 'initial');
  return git;
};

/**
 * A workspace that is not a repository, holding `alpha` (a modified file in
 * `src`, a staged rename, an untracked file, a binary and a file over the
 * limit) and `beta` (one modified file).
 */
const workspace = async (t: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'doric-parity-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const alpha = await committedAt(join(root, 'alpha'), {
    'src/a.ts': 'a\n',
    'old.ts': 'old\n',
    'bin.dat': 'a\0b',
  });
  await write(join(root, 'alpha'), 'src/a.ts', 'changed\n');
  await alpha('mv', 'old.ts', 'new.ts');
  await write(join(root, 'alpha'), 'untracked.ts', 'new\n');
  await write(join(root, 'alpha'), 'bin.dat', 'c\0d');
  await write(join(root, 'alpha'), 'large.txt', 'x'.repeat(limit + 10));
  await committedAt(join(root, 'beta'), { 'b.ts': 'b\n' });
  await write(join(root, 'beta'), 'b.ts', 'changed\n');
  return { root, sandbox: localSandbox(root) };
};

/** The kernel service and the routed client over `sandbox`, the lease in `lease`. */
const pair = async (
  t: TestContext,
  sandbox: ReturnType<typeof localSandbox>,
  lease: LeaseStatus = 'ready',
) => {
  const kernel = gitOver(sandbox, fakeRuntime({ lease }));
  t.after(kernel.dispose);
  const h = commandsHarness({ sandbox, state: { lease } });
  t.after(() => h.router.control.stop());
  await h.activate();
  return {
    kernel: kernel.git({ projectId: 'project-1' }),
    routed: h.client({ projectId: 'project-1' }),
  };
};

const readPaths: [string, string | undefined][] = [
  ['the root, with several repositories', undefined],
  ['a subdirectory', 'alpha/src'],
  ['one repository', 'beta'],
  ['a missing path', 'nowhere'],
  ['an escaping path', '../x'],
];

void test('P1/P3: Changes of the root (several repositories), a subdirectory, one repository, a missing path and ../', async (t) => {
  const { sandbox } = await workspace(t);
  const { kernel, routed } = await pair(t, sandbox);

  for (const [label, path] of readPaths) {
    const input = path === undefined ? {} : { path };
    assertParity({
      label: `Changes ${label}`,
      schema: ChangesResponseSchema,
      kernel: await kernel.changes(input),
      routed: await routed.changes(input),
      codec: changesResponseOf,
    });
  }
});

void test('P1/P3: Diff of the root (several repositories), a subdirectory, one repository, a missing path and ../', async (t) => {
  const { sandbox } = await workspace(t);
  const { kernel, routed } = await pair(t, sandbox);

  for (const [label, path] of readPaths) {
    const input = path === undefined ? {} : { path };
    assertParity({
      label: `Diff ${label}`,
      schema: DiffResponseSchema,
      kernel: await kernel.diff(input),
      routed: await routed.diff(input),
      codec: diffResponseOf,
    });
  }
});

void test('P1/P3: FileDiff of a modified, renamed, untracked, binary and over-the-limit file, one not found, and an invalid one', async (t) => {
  const { sandbox } = await workspace(t);
  const { kernel, routed } = await pair(t, sandbox);
  const cases: [string, string, string][] = [
    ['modified', 'alpha', 'src/a.ts'],
    ['renamed', 'alpha', 'new.ts'],
    ['untracked', 'alpha', 'untracked.ts'],
    ['binary', 'alpha', 'bin.dat'],
    ['over the limit', 'alpha', 'large.txt'],
    ['not found', 'alpha', 'unchanged.ts'],
    ['invalid', 'alpha', '../x'],
  ];

  for (const [label, repository, path] of cases) {
    assertParity({
      label: `FileDiff ${label}`,
      schema: FileDiffResponseSchema,
      kernel: await kernel.fileDiff({ repository, path }),
      routed: await routed.fileDiff({ repository, path }),
      codec: fileDiffResponseOf,
    });
  }
});

void test('P2: each lease state passes through every Project method as the kernel answers it', async (t) => {
  const { sandbox } = await workspace(t);
  for (const lease of [
    'pending',
    'unavailable',
    'expired',
    'missing',
  ] as const) {
    const { kernel, routed } = await pair(t, sandbox, lease);
    assertParity({
      label: `Changes ${lease}`,
      schema: ChangesResponseSchema,
      kernel: await kernel.changes({}),
      routed: await routed.changes({}),
      codec: changesResponseOf,
    });
    assertParity({
      label: `Diff ${lease}`,
      schema: DiffResponseSchema,
      kernel: await kernel.diff({}),
      routed: await routed.diff({}),
      codec: diffResponseOf,
    });
    assertParity({
      label: `FileDiff ${lease}`,
      schema: FileDiffResponseSchema,
      kernel: await kernel.fileDiff({ repository: 'alpha', path: 'src/a.ts' }),
      routed: await routed.fileDiff({ repository: 'alpha', path: 'src/a.ts' }),
      codec: fileDiffResponseOf,
    });
  }
});
