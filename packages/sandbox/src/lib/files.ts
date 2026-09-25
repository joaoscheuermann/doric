import { posix as path } from 'node:path';

import type {
  SandboxEntry,
  SandboxListInput,
  SandboxListResult,
  SandboxTreeNode,
  SandboxTreeResult,
  WorkspacePathKind,
} from './types/files.js';
import type { Sandbox } from './types/sandbox.js';

/**
 * The one implementation of the workspace visibility rules: root confinement,
 * `.gitignore` handling with negation, hidden entries except `.agents`, and
 * directories-first alphabetical ordering. The `tree` tool and the host's file
 * routes both consume it, so neither can drift from the other.
 */

/** Hidden entries stay hidden except the agent skills directory. */
const HIDDEN_EXCEPTIONS = new Set(['.agents']);

/** `wc` argument batches stay well below the platform argument-list limit. */
const SIZE_BATCH = 256;

interface Entry {
  readonly path: string;
  readonly isDirectory: boolean;
}

interface IgnorePattern {
  readonly base: string;
  readonly pattern: string;
  readonly negated: boolean;
}

/** Lists one workspace directory level, with sizes for its files. */
export const listSandboxDirectory = async (
  sandbox: Sandbox,
  input: SandboxListInput = {},
): Promise<SandboxListResult> => {
  const failure = await listable(sandbox, input);

  if ('status' in failure) {
    return failure;
  }

  const { root, excludes } = failure;
  const entries = await visibleEntries(
    sandbox,
    sandbox.root,
    root.path,
    await ancestorIgnores(sandbox, sandbox.root, root.path),
    excludes,
    false,
  );
  const sizes = await fileSizes(
    sandbox,
    entries.filter((entry) => !entry.isDirectory).map((entry) => entry.path),
  );

  return {
    status: 'listed',
    path: root.relative,
    entries: ordered(entries).map((entry) =>
      entryResult(sandbox, entry, sizes),
    ),
  };
};

/** Lists a workspace directory recursively, so each directory carries children. */
export const listSandboxTree = async (
  sandbox: Sandbox,
  input: SandboxListInput = {},
): Promise<SandboxTreeResult> => {
  const failure = await listable(sandbox, input);

  if ('status' in failure) {
    return failure;
  }

  const { root, excludes } = failure;
  const entries = await visibleEntries(
    sandbox,
    sandbox.root,
    root.path,
    [
      ...(await ancestorIgnores(sandbox, sandbox.root, root.path)),
      ...(await nestedIgnores(sandbox, sandbox.root, root.path)),
    ],
    excludes,
    true,
  );

  return {
    status: 'listed',
    path: root.relative,
    entries: tree(sandbox, root.path, entries),
  };
};

/** Reports what a workspace-relative path is, without reading its content. */
export const workspacePathKind = async (
  sandbox: Sandbox,
  value = '',
): Promise<WorkspacePathKind | 'escaped'> => {
  const resolved = resolve(sandbox.root, value);

  if (typeof resolved === 'string') {
    return 'escaped';
  }

  return pathKind(sandbox, sandbox.root, resolved.path);
};

/** The resolved root plus the exclude patterns every listing shares. */
const listable = async (
  sandbox: Sandbox,
  input: SandboxListInput,
): Promise<
  | {
      readonly root: { readonly path: string; readonly relative: string };
      readonly excludes: readonly RegExp[];
    }
  | SandboxListResult
> => {
  const root = resolve(sandbox.root, input.path ?? '');

  if (typeof root === 'string') {
    return { status: 'escaped', message: root };
  }

  const excludes = compileExcludes(input.exclude ?? []);

  if (typeof excludes === 'string') {
    return { status: 'invalid_exclude', message: excludes };
  }

  const kind = await pathKind(sandbox, sandbox.root, root.path);

  if (kind === 'missing') {
    return { status: 'missing' };
  }

  if (kind !== 'directory') {
    return { status: 'not_directory' };
  }

  const name = path.basename(root.path);

  if (excludes.some((pattern) => pattern.test(name))) {
    return { status: 'excluded_root', name };
  }

  return { root, excludes };
};

const entryResult = (
  sandbox: Sandbox,
  entry: Entry,
  sizes: ReadonlyMap<string, number>,
): SandboxEntry => {
  const size = entry.isDirectory ? undefined : sizes.get(entry.path);

  return {
    name: path.basename(entry.path),
    path: relative(sandbox.root, entry.path),
    type: entry.isDirectory ? 'directory' : 'file',
    ...(size === undefined ? {} : { size }),
  };
};

/** Groups the flat visible entries into the directory tree the tool renders. */
const tree = (
  sandbox: Sandbox,
  root: string,
  entries: readonly Entry[],
): readonly SandboxTreeNode[] => {
  const groups = new Map<string, Entry[]>();

  for (const entry of entries) {
    const parent = path.dirname(entry.path);

    groups.set(parent, [...(groups.get(parent) ?? []), entry]);
  }

  const build = (parent: string): readonly SandboxTreeNode[] =>
    ordered(groups.get(parent) ?? []).map((entry) => ({
      name: path.basename(entry.path),
      path: relative(sandbox.root, entry.path),
      type: entry.isDirectory ? ('directory' as const) : ('file' as const),
      ...(entry.isDirectory ? { children: build(entry.path) } : {}),
    }));

  return build(root);
};

const visibleEntries = async (
  sandbox: Sandbox,
  workspaceRoot: string,
  root: string,
  ignores: readonly IgnorePattern[],
  excludes: readonly RegExp[],
  deep: boolean,
): Promise<readonly Entry[]> => {
  const [directories, files] = await Promise.all([
    listPaths(sandbox, workspaceRoot, root, 'd', deep),
    listPaths(sandbox, workspaceRoot, root, 'f', deep),
  ]);

  const entries = [
    ...directories
      .filter((entry) => entry !== root)
      .map((entry) => ({ path: entry, isDirectory: true })),
    ...files.map((entry) => ({ path: entry, isDirectory: false })),
  ];

  return entries.filter(
    (entry) =>
      !isHidden(root, entry.path) &&
      !isIgnoredWithAncestors(root, entry.path, entry.isDirectory, ignores) &&
      !isExcluded(entry.path, excludes),
  );
};

/** Directories first, then files, both sorted by name the way the tool prints. */
const ordered = (entries: readonly Entry[]): readonly Entry[] =>
  [...entries].sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) {
      return left.isDirectory ? -1 : 1;
    }

    return path
      .basename(left.path)
      .localeCompare(path.basename(right.path), undefined, {
        sensitivity: 'accent',
      });
  });

const listPaths = async (
  sandbox: Sandbox,
  workspaceRoot: string,
  root: string,
  type: 'd' | 'f',
  deep: boolean,
): Promise<readonly string[]> => {
  const result = await sandbox.exec({
    cwd: workspaceRoot,
    cmd: [
      'find',
      root,
      ...(deep ? [] : ['-maxdepth', '1']),
      '(',
      '-name',
      '.git',
      ')',
      '-prune',
      '-o',
      '-type',
      type,
      '-print',
    ],
  });

  if (result.exitCode !== 0) {
    return [];
  }

  return lines(result.stdout).map(normalize).sort();
};

/** Byte sizes for the named files, measured in one command per batch. */
const fileSizes = async (
  sandbox: Sandbox,
  files: readonly string[],
): Promise<ReadonlyMap<string, number>> => {
  const sizes = new Map<string, number>();

  for (let index = 0; index < files.length; index += SIZE_BATCH) {
    const result = await sandbox.exec({
      cmd: ['wc', '-c', ...files.slice(index, index + SIZE_BATCH)],
    });

    if (result.exitCode !== 0) {
      continue;
    }

    for (const line of lines(result.stdout)) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      const size = match?.[1];
      const file = match?.[2];

      if (size !== undefined && file !== undefined) {
        sizes.set(file, Number(size));
      }
    }
  }

  return sizes;
};

/**
 * Every `.gitignore` from the workspace root down to `dir`, inclusive. A pattern
 * applies to the directory that holds its file and everything below it, so the
 * ancestors of the listed directory are part of listing it.
 */
const ancestorIgnores = async (
  sandbox: Sandbox,
  workspaceRoot: string,
  dir: string,
): Promise<readonly IgnorePattern[]> => {
  const relative = path.relative(workspaceRoot, dir);
  const parts = relative === '' ? [] : relative.split('/');
  const dirs = [
    workspaceRoot,
    ...parts.map((_, index) =>
      path.join(workspaceRoot, ...parts.slice(0, index + 1)),
    ),
  ];

  const groups = await Promise.all(
    dirs.map(async (value) =>
      parseIgnores(value, await ignoreText(sandbox, value)),
    ),
  );

  return groups.flat();
};

/** Every `.gitignore` in the subtree, so one recursive listing reads them once. */
const nestedIgnores = async (
  sandbox: Sandbox,
  workspaceRoot: string,
  root: string,
): Promise<readonly IgnorePattern[]> => {
  const result = await sandbox.exec({
    cwd: workspaceRoot,
    cmd: [
      'find',
      root,
      '(',
      '-name',
      '.git',
      ')',
      '-prune',
      '-o',
      '-type',
      'f',
      '-name',
      '.gitignore',
      '-print',
    ],
  });

  if (result.exitCode !== 0) {
    return [];
  }

  const files = lines(result.stdout).map(normalize).sort();

  const groups = await Promise.all(
    files.map(async (file) =>
      parseIgnores(
        path.dirname(file),
        await ignoreText(sandbox, path.dirname(file)),
      ),
    ),
  );

  return groups.flat();
};

const ignoreText = (sandbox: Sandbox, dir: string): Promise<string> =>
  sandbox.readFile(`${dir}/.gitignore`).catch(() => '');

const parseIgnores = (base: string, text: string): readonly IgnorePattern[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => ({
      base,
      pattern: line.startsWith('!') ? line.slice(1) : line,
      negated: line.startsWith('!'),
    }))
    .filter((ignore) => ignore.pattern !== '');

const isHidden = (root: string, fullPath: string): boolean =>
  path
    .relative(root, fullPath)
    .split('/')
    .some((part) => part.startsWith('.') && !HIDDEN_EXCEPTIONS.has(part));

const isIgnoredWithAncestors = (
  root: string,
  fullPath: string,
  isDirectory: boolean,
  ignores: readonly IgnorePattern[],
): boolean => {
  const ignoredAncestor = ancestors(root, fullPath).some((ancestor) =>
    isIgnored(ancestor, true, ignores),
  );

  return ignoredAncestor || isIgnored(fullPath, isDirectory, ignores);
};

const ancestors = (root: string, fullPath: string): readonly string[] => {
  const values: string[] = [];
  let current = path.dirname(fullPath);

  while (contains(root, current) && current !== root) {
    values.unshift(current);

    current = path.dirname(current);
  }

  return values;
};

const isIgnored = (
  fullPath: string,
  isDirectory: boolean,
  ignores: readonly IgnorePattern[],
): boolean => {
  let ignored = false;

  for (const ignore of ignores) {
    const pattern = ignore.pattern.endsWith('/')
      ? ignore.pattern.slice(0, -1)
      : ignore.pattern;

    if (ignore.pattern.endsWith('/') && !isDirectory) {
      continue;
    }

    if (!contains(ignore.base, fullPath)) {
      continue;
    }

    const glob = compileGlob(pattern);
    const relative = path.relative(ignore.base, fullPath);

    const matched =
      glob instanceof RegExp
        ? glob.test(relative) || glob.test(path.basename(fullPath))
        : relative === pattern || path.basename(fullPath) === pattern;

    if (matched) {
      ignored = !ignore.negated;
    }
  }

  return ignored;
};

const isExcluded = (fullPath: string, excludes: readonly RegExp[]): boolean => {
  const name = path.basename(fullPath);

  return excludes.some(
    (pattern) => pattern.test(name) || pattern.test(fullPath),
  );
};

const compileExcludes = (
  patterns: readonly string[],
): readonly RegExp[] | string => {
  const compiled: RegExp[] = [];

  for (const pattern of patterns) {
    const glob = compileGlob(pattern);

    if (typeof glob === 'string') {
      return glob;
    }

    compiled.push(glob);
  }

  return compiled;
};

const compileGlob = (pattern: string): RegExp | string => {
  if (pattern.includes('[') || pattern.includes(']')) {
    const reason =
      pattern.includes('[') && !pattern.includes(']')
        ? 'unclosed character class'
        : 'unsupported character classes';

    return `Error: invalid exclude pattern '${pattern}': ${reason}`;
  }

  const source = pattern
    .replace(/[\\^$+?.()|{}]/g, '\\$&')
    .replaceAll('**', '\0')
    .replaceAll('*', '[^/]*')
    .replaceAll('?', '[^/]')
    .replaceAll('\0', '.*');

  return new RegExp(`^${source}$`);
};

const resolve = (
  workspaceRoot: string,
  value: string,
): { readonly path: string; readonly relative: string } | string => {
  const root = normalize(workspaceRoot);

  const resolved = normalize(
    path.isAbsolute(value) ? value : path.join(root, value),
  );

  if (!contains(root, resolved)) {
    return `Path escapes workspace: ${value}`;
  }

  return {
    path: resolved,
    relative: resolved === root ? '' : resolved.slice(root.length + 1),
  };
};

const relative = (workspaceRoot: string, fullPath: string): string => {
  const root = normalize(workspaceRoot);

  return fullPath === root ? '' : fullPath.slice(root.length + 1);
};

const pathKind = async (
  sandbox: Sandbox,
  workspaceRoot: string,
  value: string,
): Promise<WorkspacePathKind> => {
  const result = await sandbox.exec({
    cwd: workspaceRoot,
    cmd: [
      'sh',
      '-c',
      'if [ -d "$1" ]; then printf directory; elif [ -f "$1" ]; then printf file; elif [ -e "$1" ]; then printf other; else printf missing; fi',
      'sh',
      value,
    ],
  });

  if (result.exitCode !== 0) {
    return 'missing';
  }

  return parsePathKind(result.stdout);
};

const parsePathKind = (value: string): WorkspacePathKind => {
  const normalized = value.trim();

  if (
    normalized === 'directory' ||
    normalized === 'file' ||
    normalized === 'missing' ||
    normalized === 'other'
  ) {
    return normalized;
  }

  return 'missing';
};

const contains = (root: string, child: string): boolean =>
  child === root || child.startsWith(`${root}/`);

const lines = (value: string): readonly string[] =>
  value.split(/\r?\n/).filter((line) => line !== '');

const normalize = (value: string): string => {
  const resolved = path.normalize(path.isAbsolute(value) ? value : `/${value}`);

  return resolved === '/' ? resolved : resolved.replace(/\/+$/, '');
};
