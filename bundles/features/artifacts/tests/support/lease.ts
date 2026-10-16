// A fake `runtime.lease/v1` for the registry's tests: a real temporary
// directory stands in for the Project's sandbox, mounted at `/workspace` as
// the host mounts it. The registry reaches it through `withLease`, the
// Project's current lease, so the fake hands the task a sandbox over that
// directory — bytes in and out, plus the two commands the store issues (`ls`,
// `rm`) — or answers the lease state a test asked for instead.

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { defineMethod, defineService } from 'bundle/contracts';
import {
  type LeaseTask,
  RuntimeLeaseV1,
  runtimeLeaseMethods,
} from 'runtime/contracts';

/** The sandbox a `withLease` task receives. */
type Sandbox = Parameters<LeaseTask<unknown>>[0];

/** The workspace root the fake sandbox answers for. */
export const workspaceRoot = '/workspace';

/** What the Project's lease is in a test: held, or one of the other states. */
export type FakeLeaseState =
  | 'ready'
  | 'pending'
  | 'unavailable'
  | 'expired'
  | 'missing';

/** Maps a sandbox path into this machine's copy of the workspace. */
export const localPath = (localRoot: string, path: string): string => {
  const relative = path.startsWith(workspaceRoot)
    ? path.slice(workspaceRoot.length)
    : path;
  const parts = relative.split('/').filter((part) => part !== '');

  // The fake is a boundary double, not a guard: a path that would leave the
  // workspace fails loudly so a test sees an escape instead of a write.
  if (parts.includes('..')) {
    throw new Error(`The fake sandbox refuses a path outside it: ${path}`);
  }

  return join(localRoot, ...parts);
};

const result = (exitCode: number, stdout = '') => ({
  exitCode,
  stdout,
  stderr: '',
  stdoutBytes: new Uint8Array(Buffer.from(stdout)),
  stderrBytes: new Uint8Array(),
});

const exec = async (localRoot: string, cmd: readonly string[]) => {
  const [program, ...args] = cmd;
  const operand = args.at(-1);

  if (program === 'ls' && operand !== undefined) {
    const entries = await readdir(localPath(localRoot, operand)).catch(
      () => undefined,
    );

    return entries === undefined
      ? result(2)
      : result(0, entries.map((entry) => `${entry}\n`).join(''));
  }

  if (program === 'rm' && operand !== undefined) {
    await rm(localPath(localRoot, operand), { recursive: true, force: true });

    return result(0);
  }

  return result(127);
};

const put = async (target: string, bytes: Uint8Array): Promise<void> => {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
};

/** The sandbox a `withLease` task receives, over one local directory. */
export const fakeSandbox = (localRoot: string) => ({
  id: 'fake-sandbox',
  root: workspaceRoot,
  exec: (input: { readonly cmd: readonly string[] }) =>
    exec(localRoot, input.cmd),
  readFile: (path: string) => readFile(localPath(localRoot, path), 'utf8'),
  writeFile: (path: string, content: string) =>
    put(localPath(localRoot, path), new Uint8Array(Buffer.from(content))),
  putFile: (path: string, bytes: Uint8Array) =>
    put(localPath(localRoot, path), bytes),
  getFile: async (path: string) =>
    new Uint8Array(await readFile(localPath(localRoot, path))),
});

/** The lease over one local directory; `localRoot` is the sandbox's `/workspace`. */
export const fakeLease = (
  localRoot: string,
  state: () => FakeLeaseState = () => 'ready',
) => {
  const sandbox = fakeSandbox(localRoot);

  return defineService(RuntimeLeaseV1.id, {
    describe: defineMethod({
      ...runtimeLeaseMethods.describe,
      execute: async () => ({ id: sandbox.id, root: sandbox.root }),
    }),
    withLease: defineMethod({
      ...runtimeLeaseMethods.withLease,
      execute: async (task: LeaseTask<unknown>) => {
        const current = state();

        if (current !== 'ready') return { status: current };

        // The store reaches only what this fake answers; the rest of the
        // sandbox surface (git, ssh, diff) is never called by the registry.
        return {
          status: 'ready' as const,
          value: await task(sandbox as unknown as Sandbox),
        };
      },
    }),
  });
};
