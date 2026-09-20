import { lstat, readdir, readFile } from 'node:fs/promises';
import hostPath from 'node:path';
import { posix as path } from 'node:path';

import type {
  SandboxExecInput,
  SandboxExecResult,
  SandboxSession,
} from 'sandbox';

export const WORKSPACE_ROOT = '/workspace';

export type FakeSandbox = {
  readonly session: SandboxSession;
  readonly reads: readonly string[];
};

export const createFakeSandbox = (localRoot: string): FakeSandbox => {
  const reads: string[] = [];

  return {
    reads,
    session: {
      id: 'fake-sandbox',
      root: WORKSPACE_ROOT,
      exec: (input) => exec(localRoot, input),
      readFile: async (file) => {
        reads.push(file);

        return readFile(toLocal(localRoot, file), 'utf8');
      },
      cloneRepo: reject,
      writeFile: reject,
      putFile: reject,
      getFile: reject,
      diff: reject,
      dispose: async () => undefined,
    },
  };
};

const exec = async (
  localRoot: string,
  input: SandboxExecInput,
): Promise<SandboxExecResult> => {
  if (input.cmd[0] === 'sh' && input.cmd[1] === '-c') {
    return result(await pathKind(localRoot, input.cmd.at(-1) ?? ''));
  }

  if (input.cmd[0] === 'find') {
    return find(localRoot, input.cmd);
  }

  return result('', 127, `Unsupported command: ${input.cmd.join(' ')}`);
};

const pathKind = async (localRoot: string, value: string): Promise<string> => {
  const stats = await lstat(toLocal(localRoot, value)).catch(() => undefined);

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
  cmd: readonly string[],
): Promise<SandboxExecResult> => {
  const root = normalize(cmd[1] ?? WORKSPACE_ROOT);
  const files = await walk(toLocal(localRoot, root), root);
  const markdown = files.filter((file) => file.endsWith('.md')).sort();

  return result(`${markdown.join('\n')}${markdown.length === 0 ? '' : '\n'}`);
};

const walk = async (
  local: string,
  sandbox: string,
): Promise<readonly string[]> => {
  const stats = await lstat(local).catch(() => undefined);

  if (stats === undefined || stats.isSymbolicLink()) {
    return [];
  }

  if (stats.isFile()) {
    return [sandbox];
  }

  if (!stats.isDirectory()) {
    return [];
  }

  const children = await readdir(local);

  const nested = await Promise.all(
    children.map((child) =>
      walk(hostPath.join(local, child), path.join(sandbox, child)),
    ),
  );

  return nested.flat();
};

const toLocal = (localRoot: string, value: string): string => {
  const normalized = normalize(value);

  if (
    normalized !== WORKSPACE_ROOT &&
    !normalized.startsWith(`${WORKSPACE_ROOT}/`)
  ) {
    throw new Error(`Path escapes fake sandbox: ${value}`);
  }

  const relative = path.relative(WORKSPACE_ROOT, normalized);

  return relative === ''
    ? localRoot
    : hostPath.join(localRoot, ...relative.split('/'));
};

const normalize = (value: string): string => {
  const resolved = path.normalize(path.isAbsolute(value) ? value : `/${value}`);

  return resolved === '/' ? resolved : resolved.replace(/\/+$/u, '');
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

const reject = async (): Promise<never> => {
  throw new Error('Unsupported fake sandbox operation');
};
