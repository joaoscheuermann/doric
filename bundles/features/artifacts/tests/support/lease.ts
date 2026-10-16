// A fake `runtime.lease/v1` for the registry's tests: a real temporary
// directory stands in for the Project's sandbox, mounted at `/workspace` as
// the host mounts it. It answers what the store actually uses — the root, the
// two commands it issues (`cat`, `ls`) and the sandbox file reads and writes.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { defineMethod, defineService } from 'bundle/contracts';
import { RuntimeLeaseV1, runtimeLeaseMethods } from 'runtime/contracts';

/** The workspace root the fake sandbox answers for. */
export const workspaceRoot = '/workspace';

/** Maps a sandbox path into this machine's copy of the workspace. */
export const localPath = (localRoot: string, path: string): string => {
  const relative = path.startsWith(workspaceRoot)
    ? path.slice(workspaceRoot.length)
    : path;

  return join(localRoot, ...relative.split('/').filter((part) => part !== ''));
};

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' });
const fail = (exitCode: number) => ({ exitCode, stdout: '', stderr: '' });

const exec = async (localRoot: string, cmd: readonly string[]) => {
  const [program, ...args] = cmd;

  if (program === 'cat' && args[0] === '--' && args[1] !== undefined) {
    return await readFile(localPath(localRoot, args[1]), 'utf8').then(ok, () =>
      fail(1),
    );
  }

  if (program === 'ls' && args[0] === '-1' && args[1] !== undefined) {
    const entries = await readdir(localPath(localRoot, args[1])).catch(
      () => undefined,
    );

    if (entries === undefined) return fail(2);

    return ok(entries.map((entry) => `${entry}\n`).join(''));
  }

  return fail(127);
};

/** The lease over one local directory; `localRoot` is the sandbox's `/workspace`. */
export const fakeLease = (localRoot: string) =>
  defineService(RuntimeLeaseV1.id, {
    describe: defineMethod({
      ...runtimeLeaseMethods.describe,
      execute: async () => ({ id: 'fake-sandbox', root: workspaceRoot }),
    }),
    exec: defineMethod({
      ...runtimeLeaseMethods.exec,
      execute: (input: { readonly cmd: readonly string[] }) =>
        exec(localRoot, input.cmd),
    }),
    readFile: defineMethod({
      ...runtimeLeaseMethods.readFile,
      execute: (path: string) => readFile(localPath(localRoot, path), 'utf8'),
    }),
    writeFile: defineMethod({
      ...runtimeLeaseMethods.writeFile,
      execute: async ([path, content]: readonly [string, string]) => {
        const target = localPath(localRoot, path);

        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, 'utf8');
      },
    }),
  });
