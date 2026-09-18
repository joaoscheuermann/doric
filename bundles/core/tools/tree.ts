import { posix as path } from 'node:path';

import { z } from 'zod';

import type { Sandbox } from 'sandbox';
import { defineTool } from 'tool';

const HIDDEN_EXCEPTIONS = new Set(['.agents']);
const description =
  'Display directory structure as an ASCII tree. Directories are listed first, then files, both sorted alphabetically. Respects .gitignore and excludes hidden files except .agents.';

export const input = z
  .object({
    path: z.string().optional(),
    exclude: z.array(z.string()).optional(),
  })
  .strict();
export const output = z.string();

export type TreeOutput = z.output<typeof output>;

type Input = z.output<typeof input>;

type Entry = {
  readonly path: string;
  readonly isDirectory: boolean;
};

type IgnorePattern = {
  readonly base: string;
  readonly pattern: string;
  readonly negated: boolean;
};

type PathKind = 'directory' | 'file' | 'missing' | 'other';

/** Creates the provider-neutral ASCII tree tool. */
const factory = defineTool({
  name: 'tree',
  description,
  input,
  output,
  execute: (sandbox, input): Promise<TreeOutput> =>
    execute(sandbox.root, sandbox, input),
});

export default factory;

const execute = async (
  workspaceRoot: string,
  sandbox: Sandbox,
  input: Input,
): Promise<TreeOutput> => {
  const rawPath = input.path ?? '';
  const displayPath = rawPath === '' ? '.' : rawPath;
  const root = resolvePath(workspaceRoot, displayPath);

  if (typeof root === 'string') {
    return `Error: ${root}`;
  }

  const kind = await pathKind(sandbox, workspaceRoot, root.path);

  if (kind === 'missing') {
    return `Error: path not found: ${displayPath}`;
  }

  if (kind !== 'directory') {
    return `Error: path is not a directory: ${displayPath}`;
  }

  const excludes = input.exclude?.map(compileGlob) ?? [];

  const invalid = excludes.find(
    (value): value is string => typeof value === 'string',
  );

  if (invalid !== undefined) {
    return invalid;
  }

  const rootName = path.basename(root.path);

  if ((excludes as RegExp[]).some((pattern) => pattern.test(rootName))) {
    return `Error: exclude pattern matches the root directory: ${rootName}`;
  }

  const entries = await visibleEntries(
    sandbox,
    workspaceRoot,
    root.path,
    excludes as RegExp[],
  );
  const children = groupEntries(entries);
  const lines = [root.path];

  appendTree(root.path, '', children, lines);

  return `${lines.join('\n')}\n`;
};

const appendTree = (
  dir: string,
  prefix: string,
  children: ReadonlyMap<string, readonly Entry[]>,
  lines: string[],
): void => {
  const entries = children.get(dir) ?? [];

  for (const [index, entry] of entries.entries()) {
    const isLast = index === entries.length - 1;
    const connector = isLast ? '`-- ' : '|-- ';
    const name = path.basename(entry.path);

    if (!entry.isDirectory) {
      lines.push(`${prefix}${connector}${name}`);

      continue;
    }

    const mark = lines.length;

    lines.push(`${prefix}${connector}${name}/`);

    const childPrefix = isLast ? `${prefix}    ` : `${prefix}|   `;

    appendTree(entry.path, childPrefix, children, lines);

    if (lines.length === mark + 1) {
      lines[mark] = `${lines[mark]} (empty)`;
    }
  }
};

const visibleEntries = async (
  sandbox: Sandbox,
  workspaceRoot: string,
  root: string,
  excludes: readonly RegExp[],
): Promise<readonly Entry[]> => {
  const [directories, files, ignores] = await Promise.all([
    listPaths(sandbox, workspaceRoot, root, 'd'),
    listPaths(sandbox, workspaceRoot, root, 'f'),
    readIgnores(sandbox, workspaceRoot, root),
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

const groupEntries = (
  entries: readonly Entry[],
): ReadonlyMap<string, readonly Entry[]> => {
  const groups = new Map<string, Entry[]>();

  for (const entry of entries) {
    const parent = path.dirname(entry.path);

    groups.set(parent, [...(groups.get(parent) ?? []), entry]);
  }

  return new Map(
    [...groups.entries()].map(([parent, values]) => [parent, sorted(values)]),
  );
};

const sorted = (entries: readonly Entry[]): readonly Entry[] =>
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
): Promise<readonly string[]> => {
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
      type,
      '-print',
    ],
  });

  if (result.exitCode !== 0) {
    return [];
  }

  return lines(result.stdout).map(normalizePath).sort();
};

const readIgnores = async (
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

  const files = lines(result.stdout).map(normalizePath).sort();

  const groups = await Promise.all(
    files.map(async (file) =>
      parseIgnores(
        path.dirname(file),
        await sandbox.readFile(file).catch(() => ''),
      ),
    ),
  );

  return groups.flat();
};

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

const resolvePath = (
  workspaceRoot: string,
  value: string,
): { readonly path: string } | string => {
  const root = normalizePath(workspaceRoot);

  const resolved = normalizePath(
    path.isAbsolute(value) ? value : path.join(root, value),
  );

  if (!contains(root, resolved)) {
    return `Path escapes workspace: ${value}`;
  }

  return { path: resolved };
};

const pathKind = async (
  sandbox: Sandbox,
  workspaceRoot: string,
  value: string,
): Promise<PathKind> => {
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

const parsePathKind = (value: string): PathKind => {
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

const normalizePath = (value: string): string => {
  const resolved = path.normalize(path.isAbsolute(value) ? value : `/${value}`);

  return resolved === '/' ? resolved : resolved.replace(/\/+$/, '');
};
