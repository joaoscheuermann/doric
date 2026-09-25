import { lstat, readdir, readFile } from 'node:fs/promises';
import hostPath from 'node:path';
import { posix as sandboxPath } from 'node:path';

import type { Host } from 'host';
import type { Sandbox, SandboxExecInput, SandboxExecResult } from 'sandbox';

export const WORKSPACE_ROOT = '/workspace';

export const createFakeSandbox = (
  localRoot: string,
  root = WORKSPACE_ROOT,
): Sandbox => ({
  id: 'fake-sandbox',
  root,

  exec(input) {
    return exec(localRoot, root, input);
  },

  readFile(file) {
    return readFile(toLocalPath(localRoot, root, file), 'utf8');
  },

  async cloneRepo() {
    throw unsupported();
  },

  async writeFile() {
    throw unsupported();
  },

  async putFile() {
    throw unsupported();
  },

  async getFile() {
    throw unsupported();
  },

  async diff() {
    throw unsupported();
  },

  async ssh() {
    return undefined;
  },
});

const exec = async (
  localRoot: string,
  root: string,
  input: SandboxExecInput,
): Promise<SandboxExecResult> => {
  if (input.cmd[0] === 'sh' && input.cmd[1] === '-c') {
    return result(await pathKind(localRoot, root, input.cmd.at(-1) ?? root));
  }

  if (input.cmd[0] === 'find') {
    return find(localRoot, root, input.cmd);
  }

  return result('', 127, `Unsupported command: ${input.cmd.join(' ')}`);
};

const pathKind = async (
  localRoot: string,
  root: string,
  value: string,
): Promise<string> => {
  const stats = await lstat(toLocalPath(localRoot, root, value)).catch(
    () => undefined,
  );

  if (stats === undefined) {
    return 'missing';
  }

  if (stats.isDirectory()) {
    return 'directory';
  }

  return stats.isFile() ? 'file' : 'other';
};

const find = async (
  localRoot: string,
  root: string,
  cmd: readonly string[],
): Promise<SandboxExecResult> => {
  const target = normalizePath(cmd[1] ?? root);
  const localTarget = toLocalPath(localRoot, root, target);
  const type = cmd[cmd.indexOf('-type') + 1];
  const name = cmd.includes('.gitignore') ? '.gitignore' : undefined;
  const pruneNodeModules = cmd.includes('node_modules');

  const paths = await walk(localTarget, target, {
    type,
    name,
    pruneNodeModules,
  });

  return result(`${paths.join('\n')}${paths.length === 0 ? '' : '\n'}`);
};

type WalkOptions = {
  readonly type: string | undefined;
  readonly name: string | undefined;
  readonly pruneNodeModules: boolean;
};

const walk = async (
  local: string,
  sandbox: string,
  options: WalkOptions,
): Promise<readonly string[]> => {
  const stats = await lstat(local).catch(() => undefined);

  if (stats === undefined || stats.isSymbolicLink()) {
    return [];
  }

  const name = sandboxPath.basename(sandbox);

  if (
    name === '.git' ||
    (options.pruneNodeModules && name === 'node_modules')
  ) {
    return [];
  }

  const own =
    ((options.type === 'f' && stats.isFile()) ||
      (options.type === 'd' && stats.isDirectory())) &&
    (options.name === undefined || name === options.name)
      ? [sandbox]
      : [];

  if (!stats.isDirectory()) {
    return own;
  }

  const children = await readdir(local);

  const nested = await Promise.all(
    children.map((child) =>
      walk(
        hostPath.join(local, child),
        sandboxPath.join(sandbox, child),
        options,
      ),
    ),
  );

  return [...own, ...nested.flat()];
};

const toLocalPath = (
  localRoot: string,
  root: string,
  value: string,
): string => {
  const normalizedRoot = normalizePath(root);
  const normalized = normalizePath(value);

  if (
    normalized !== normalizedRoot &&
    !normalized.startsWith(`${normalizedRoot}/`)
  ) {
    throw new Error(`Path escapes fake sandbox root: ${value}`);
  }

  const relative = sandboxPath.relative(normalizedRoot, normalized);

  return relative === ''
    ? localRoot
    : hostPath.join(localRoot, ...relative.split('/'));
};

const result = (
  stdout: string,
  exitCode = 0,
  stderr = '',
): SandboxExecResult => ({
  exitCode,
  stdout,
  stderr,
  stdoutBytes: new Uint8Array(),
  stderrBytes: new Uint8Array(),
});

const normalizePath = (value: string): string => {
  const resolved = sandboxPath.normalize(
    sandboxPath.isAbsolute(value) ? value : `/${value}`,
  );

  return resolved === '/' ? resolved : resolved.replace(/\/+$/, '');
};

const unsupported = (): Error =>
  new Error('Fake sandbox method not implemented');

/** Tool tests never reach host capabilities; the facade only has to exist. */
export const fakeHost = (): Host => ({ threads: {} as never });
