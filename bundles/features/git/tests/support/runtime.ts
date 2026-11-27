// Fixtures of the runtime boundary the git service runs on: a sandbox that
// runs its commands in a local directory (real `git`, real `sh`), and the
// state one Thread, one Project lease and the Project's terminal sessions
// answer with (`FakeRuntime`), which `./routed-git.ts` hands to the router
// fakes.

import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';

import type { Sandbox } from 'sandbox';
import type { TerminalSession } from 'terminal/contracts';

const run = promisify(execFile);

const unsupported = async (): Promise<never> => {
  throw new Error('Not supported by the local sandbox.');
};

/** A sandbox rooted at a local directory; commands run there for real. */
export const localSandbox = (root: string): Sandbox => ({
  id: 'local',
  root,
  exec: async ({ cmd, cwd }) => {
    const [command = '', ...args] = cmd;
    try {
      const result = await run(command, args, {
        cwd: cwd ?? root,
        encoding: 'buffer',
      });
      return {
        exitCode: 0,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        stdoutBytes: result.stdout,
        stderrBytes: result.stderr,
      };
    } catch (error) {
      const failed = error as {
        code?: number;
        stdout?: Buffer;
        stderr?: Buffer;
      };
      return {
        exitCode: typeof failed.code === 'number' ? failed.code : 1,
        stdout: failed.stdout?.toString() ?? '',
        stderr: failed.stderr?.toString() ?? '',
        stdoutBytes: failed.stdout ?? Buffer.alloc(0),
        stderrBytes: failed.stderr ?? Buffer.alloc(0),
      };
    }
  },
  readFile: unsupported,
  writeFile: unsupported,
  putFile: unsupported,
  getFile: unsupported,
  cloneRepo: unsupported,
  // A relative directory is the sandbox's own, as a real sandbox reads it.
  diff: async ({ cwd } = {}) =>
    (await run('git', ['diff'], { cwd: resolve(root, cwd ?? '') })).stdout,
  ssh: async () => undefined,
  stats: async () => undefined,
});

/** A temporary workspace with one committed repository at its root. */
export const repository = async (t: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'doric-git-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args: string[]) =>
    (await run('git', ['-C', root, ...args])).stdout;
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.com');
  return { root, git, sandbox: localSandbox(root) };
};

export type ThreadState = 'ready' | 'missing' | 'inactive' | 'pending';
export type LeaseState =
  | 'ready'
  | 'pending'
  | 'unavailable'
  | 'expired'
  | 'missing';

/** How a Thread session was opened (`runtime.workspace/v1.OpenThread`). */
export interface ThreadOpen {
  readonly exclusive: boolean;
  readonly refreshHint?: boolean;
  readonly resume?: boolean;
}

/** What the fake runtime answers and what it was asked. */
export interface FakeRuntime {
  thread: ThreadState;
  cwd: string;
  /** Working directories of the Project's Threads with running prompts. */
  busy: string[];
  lease: LeaseState;
  /** Closing starts, or the lease drops, while a task runs. */
  dropDuringTask: boolean;
  /** The Project's sessions, while some bundle provides `terminal/v1`. */
  terminals?: TerminalSession[];
  /** Each Thread session opened: the Thread and its options. */
  readonly threads: { threadId: string; options: ThreadOpen }[];
  /** The Project of each Project lease read. */
  readonly leases: (string | undefined)[];
}

export const fakeRuntime = (
  overrides: Partial<FakeRuntime> = {},
): FakeRuntime => ({
  thread: 'ready',
  cwd: '',
  busy: [],
  lease: 'ready',
  dropDuringTask: false,
  threads: [],
  leases: [],
  ...overrides,
});

/** A tracked terminal of the Project, as `terminal/v1` lists it. */
export const terminal = (
  overrides: Partial<TerminalSession>,
): TerminalSession => ({
  id: 'terminal-1',
  projectId: 'project-1',
  threadId: 'thread-2',
  origin: 'agent',
  command: 'npm test',
  cwd: '/',
  startedAt: '2026-01-01T00:00:00.000Z',
  timeoutMs: null,
  state: 'running',
  pty: false,
  ...overrides,
});
