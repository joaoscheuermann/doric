// Fakes of the runtime boundary the git service runs on: a sandbox that runs
// its commands in a local directory (real `git`, real `sh`), a
// `runtime.workspace/v1` whose `withThread` answers one Thread's state, and a
// `runtime.lease/v1` whose `withLease` answers one Project's lease state, and
// the Project's terminal sessions as `terminal/v1` lists them.

import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';

import {
  type AnyServiceDefinition,
  type Disposable,
  defineMethod,
  defineService,
  SecretsV1,
  secretsMethods,
  ToolsV1,
  toolsMethods,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import {
  type LeaseTask,
  RuntimeLeaseV1,
  RuntimeWorkspaceV1,
  readRuntimeScope,
  runtimeLeaseMethods,
  runtimeWorkspaceMethods,
  type ThreadTask,
  type WithThreadOptions,
} from 'runtime/contracts';
import type { Sandbox } from 'sandbox';
import {
  type TerminalService,
  TerminalServiceV1,
  type TerminalSession,
  terminalServiceMethods,
} from 'terminal/contracts';

import { GitCommandsV1 } from '../../src/contracts/index.js';
import { activate } from '../../src/host/index.js';
import { createGitService } from '../../src/host/service.js';

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
  /** Each `withThread` call: the Thread and its options. */
  readonly threads: { threadId: string; options: WithThreadOptions }[];
  /** Each `withLease` call's Project. */
  readonly leases: (string | undefined)[];
}

/** The fake `runtime.workspace/v1` and `runtime.lease/v1` over `runtime`. */
/** Every method of `methods`, each refusing unless `overrides` names it. */
const complete = <Methods extends Record<string, object>>(
  methods: Methods,
  overrides: Partial<Record<keyof Methods, (...args: never[]) => unknown>>,
) =>
  Object.fromEntries(
    Object.entries(methods).map(([name, spec]) => [
      name,
      defineMethod({
        ...(spec as Parameters<typeof defineMethod>[0]),
        execute:
          overrides[name] ??
          (() => {
            throw new Error(`The test does not call ${name}.`);
          }),
      } as Parameters<typeof defineMethod>[0]),
    ]),
  );

const runtimeProviders = (
  sandbox: Sandbox,
  runtime: FakeRuntime,
): AnyServiceDefinition[] => [
  defineService(RuntimeWorkspaceV1.id, {
    withThread: defineMethod({
      ...runtimeWorkspaceMethods.withThread,
      execute: async ([threadId, options, task]: [
        string,
        WithThreadOptions,
        ThreadTask<unknown>,
      ]) => {
        runtime.threads.push({ threadId, options });
        if (runtime.thread !== 'ready') return { status: runtime.thread };
        const value = await task({
          projectId: 'project-1',
          threadId,
          cwd: runtime.cwd,
          sandbox,
          closing: () => false,
          busyCwds: () => runtime.busy,
        });
        return { status: 'ready' as const, value };
      },
    }),
  }),
  defineService(RuntimeLeaseV1.id, {
    withLease: defineMethod({
      ...runtimeLeaseMethods.withLease,
      execute: async (task: LeaseTask<unknown>, call) => {
        runtime.leases.push(readRuntimeScope(call).projectId);
        if (runtime.lease !== 'ready') return { status: runtime.lease };
        const value = await task(sandbox);
        return runtime.dropDuringTask
          ? { status: 'unavailable' as const }
          : { status: 'ready' as const, value };
      },
    }),
  }),
];

/** The terminal list `runtime.terminals` stands for, while it is set. */
const terminalList = (
  runtime: FakeRuntime,
): Pick<TerminalService, 'list'> | undefined =>
  runtime.terminals === undefined
    ? undefined
    : { list: async () => runtime.terminals ?? [] };

/** `git.commands/v1` over a fake runtime and `sandbox`. */
export const gitOver = (sandbox: Sandbox, runtime: FakeRuntime) => {
  const harness = createTestServices({
    bundle: { id: 'git-test' },
    provide: [
      createGitService(() => terminalList(runtime)),
      ...runtimeProviders(sandbox, runtime),
    ],
  });
  return {
    git: (scope: { readonly projectId?: string; readonly threadId?: string }) =>
      harness.services.use(GitCommandsV1, scope),
    dispose: harness.dispose,
  };
};

const inert: Disposable = { dispose: () => undefined };

/**
 * `git.commands/v1` as the git bundle's activation provides it, over a fake
 * runtime and `sandbox`, with the `secrets/v1` and `tools/v1` it registers
 * with. A `terminal/v1` that lists `runtime.terminals` is provided only when
 * that list is set.
 */
export const activatedGit = async (sandbox: Sandbox, runtime: FakeRuntime) => {
  const terminals: AnyServiceDefinition[] =
    runtime.terminals === undefined
      ? []
      : [
          defineService(
            TerminalServiceV1.id,
            complete(terminalServiceMethods, {
              list: async () => runtime.terminals ?? [],
            }),
          ),
        ];
  const harness = createTestServices({
    bundle: { id: 'git' },
    provide: [
      defineService(
        SecretsV1.id,
        complete(secretsMethods, { registerKind: () => inert }),
      ),
      defineService(
        ToolsV1.id,
        complete(toolsMethods, { register: () => inert }),
      ),
      ...terminals,
      ...runtimeProviders(sandbox, runtime),
    ],
  });
  await activate({ services: harness.services } as Parameters<
    typeof activate
  >[0]);
  return {
    git: (scope: { readonly projectId?: string; readonly threadId?: string }) =>
      harness.services.use(GitCommandsV1, scope),
    dispose: harness.dispose,
  };
};

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
