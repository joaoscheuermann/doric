import { lstat, readdir, readFile, stat } from 'node:fs/promises';
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
    const label = input.cmd[3];

    if (label === 'entries' || label === 'ignores') {
      return result(await dump(localRoot, root, label, input.cmd));
    }

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

/** The framed stream the listing scripts print, modeled from the real tree. */
const dump = async (
  localRoot: string,
  root: string,
  label: 'entries' | 'ignores',
  cmd: readonly string[],
): Promise<string> => {
  const deep = cmd[4] === 'deep';
  const target = normalizePath(cmd[5] ?? root);
  const localTarget = toLocalPath(localRoot, root, target);
  const kind = await pathKind(localRoot, root, target);
  const lines: string[] = [];

  if (label === 'entries') {
    lines.push(`K ${kind}`);

    if (kind !== 'directory') {
      return finish(lines);
    }

    const [directories, files] = await Promise.all([
      walk(localTarget, target, {
        type: 'd',
        name: undefined,
        pruneNodeModules: false,
      }),
      walk(localTarget, target, {
        type: 'f',
        name: undefined,
        pruneNodeModules: false,
      }),
    ]);

    for (const value of [...directories, ...files]) {
      const distance =
        value === target
          ? 0
          : sandboxPath.relative(target, value).split('/').length;

      if (deep || distance <= 1) {
        lines.push(`${directories.includes(value) ? 'D' : 'F'} ${value}`);
      }
    }

    return finish(lines);
  }

  if (kind !== 'directory') {
    return '';
  }

  const content = async (file: string): Promise<readonly string[]> => {
    const text = await readFile(
      toLocalPath(localRoot, root, file),
      'utf8',
    ).catch(() => undefined);

    return text === undefined ? [] : shellLines(text).map((line) => `+${line}`);
  };

  for (const dir of cmd.slice(6)) {
    const rules = await content(`${dir}/.gitignore`);

    if (rules.length > 0) {
      lines.push(`A ${dir}`, ...rules);
    }
  }

  if (deep) {
    const files = await walk(localTarget, target, {
      type: 'f',
      name: '.gitignore',
      pruneNodeModules: false,
    });

    for (const file of files) {
      const rules = await content(file);

      if (rules.length > 0) {
        lines.push(`N ${file}`, ...rules);
      }
    }
  }

  return finish(lines);
};

const finish = (lines: readonly string[]): string =>
  `${lines.join('\n')}${lines.length === 0 ? '' : '\n'}`;

/** The lines a shell `read` loop sees: split on newlines, final newline silent. */
const shellLines = (content: string): readonly string[] => {
  const parts = content.split('\n');

  if (parts[parts.length - 1] === '') {
    parts.pop();
  }

  return parts;
};

interface WalkOptions {
  readonly type: string | undefined;
  readonly name: string | undefined;
  readonly pruneNodeModules: boolean;
}

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

/** What a fake facade needs to know about the workspace it stands for. */
export interface FakeHostOptions {
  /** The workspace root a working directory must stay inside. */
  readonly root?: string;
  /** Where the working directory starts; the root by default. */
  readonly cwd?: string;
  /** Where `root` lives on this machine, so a move can see what is there. */
  readonly localRoot?: string;
}

/**
 * The facade a tool test binds a tool to. Threads are never reached here, so
 * only the workspace control is real: it answers the way the host's own does,
 * resolving a relative path against the current directory and moving only to a
 * directory inside the root. Without `localRoot` the fake cannot see what
 * exists, so every path inside the root counts as a directory.
 */
export const fakeHost = (options: FakeHostOptions = {}): Host => {
  const root = normalizePath(options.root ?? WORKSPACE_ROOT);
  const localRoot = options.localRoot;
  let cwd = normalizePath(options.cwd ?? root);

  return {
    threads: {} as never,

    workspace: {
      cwd: () => cwd,

      async setCwd(path) {
        const resolved = normalizePath(
          sandboxPath.isAbsolute(path) ? path : sandboxPath.join(cwd, path),
        );

        if (!within(root, resolved)) {
          return { status: 'outside' };
        }

        const kind = await directoryKind(localRoot, root, resolved);

        if (kind === 'missing') {
          return { status: 'missing' };
        }

        if (kind === 'other') {
          return { status: 'not-directory' };
        }

        cwd = resolved;

        return { status: 'set', cwd };
      },
    },
  };
};

/** What the machine says `resolved` is; a directory when it cannot be seen. */
const directoryKind = async (
  localRoot: string | undefined,
  root: string,
  resolved: string,
): Promise<'directory' | 'other' | 'missing'> => {
  if (localRoot === undefined) {
    return 'directory';
  }

  const stats = await stat(toLocalPath(localRoot, root, resolved)).catch(
    () => undefined,
  );

  if (stats === undefined) {
    return 'missing';
  }

  return stats.isDirectory() ? 'directory' : 'other';
};

const within = (root: string, child: string): boolean =>
  child === root || child.startsWith(`${root}/`);
