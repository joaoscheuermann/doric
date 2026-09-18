import { posix as path } from 'node:path';

import { z } from 'zod';

import type { Sandbox } from 'sandbox';
import { defineTool } from 'tool';

const DEFAULT_LIMIT = 1000;
const MAX_OUTPUT_BYTES = 50 * 1024;
const description =
  'Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first).';

export const input = z
  .object({
    pattern: z.string(),
    path: z.string().optional(),
    limit: z.number().int().nonnegative().optional(),
  })
  .strict();

export const output = z
  .object({
    results: z.array(z.string()),
    total: z.number(),
    truncated: z.boolean(),
    error: z.string().optional(),
  })
  .strict();

export type FindOutput = z.output<typeof output>;

type Input = z.output<typeof input>;

type IgnorePattern = {
  readonly base: string;
  readonly pattern: string;
  readonly negated: boolean;
};

type PathKind = 'directory' | 'file' | 'missing' | 'other';

/** Creates the provider-neutral file search tool. */
const factory = defineTool({
  name: 'find',
  description,
  input,
  output,
  execute: (sandbox, input): Promise<FindOutput> =>
    execute(sandbox.root, sandbox, input),
});

export default factory;

const execute = async (
  workspaceRoot: string,
  sandbox: Sandbox,
  input: Input,
): Promise<FindOutput> => {
  const searchDir = input.path ?? '.';
  const searchPath = resolvePath(workspaceRoot, searchDir);

  if (typeof searchPath === 'string') {
    return empty(searchPath);
  }

  const kind = await pathKind(sandbox, workspaceRoot, searchPath.path);

  if (kind === 'missing') {
    return empty(`Path not found: ${searchDir}`);
  }

  if (kind !== 'directory') {
    return { results: [], total: 0, truncated: false };
  }

  const glob = compileGlob(input.pattern);

  if (typeof glob === 'string') {
    return empty(`Invalid glob pattern '${input.pattern}': ${glob}`);
  }

  const files = await listFiles(sandbox, workspaceRoot, searchPath.path);
  const ignores = await readIgnores(sandbox, workspaceRoot, searchPath.path);

  const visible = files.filter(
    (file) => !isIgnoredWithAncestors(searchPath.path, file, false, ignores),
  );

  return collect(searchPath.path, visible, glob, input.limit ?? DEFAULT_LIMIT);
};

const collect = async (
  searchPath: string,
  files: readonly string[],
  glob: RegExp,
  limit: number,
): Promise<FindOutput> => {
  const results: string[] = [];
  let totalBytes = 0;
  let totalMatched = 0;
  let truncated = false;

  for (const file of files) {
    const relative = path.relative(searchPath, file);
    const name = path.basename(file);

    if (!glob.test(relative) && !glob.test(name)) {
      continue;
    }

    totalMatched += 1;

    const lineBytes = relative.length + 1;

    if (totalBytes + lineBytes > MAX_OUTPUT_BYTES || results.length >= limit) {
      truncated = true;

      break;
    }

    totalBytes += lineBytes;

    results.push(relative);
  }

  return {
    results,
    total: truncated ? totalMatched : results.length,
    truncated,
  };
};

const listFiles = async (
  sandbox: Sandbox,
  workspaceRoot: string,
  searchPath: string,
): Promise<readonly string[]> => {
  const result = await sandbox.exec({
    cwd: workspaceRoot,
    cmd: [
      'find',
      searchPath,
      '(',
      '-name',
      '.git',
      '-o',
      '-name',
      'node_modules',
      ')',
      '-prune',
      '-o',
      '-type',
      'f',
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
  searchPath: string,
): Promise<readonly IgnorePattern[]> => {
  const result = await sandbox.exec({
    cwd: workspaceRoot,
    cmd: [
      'find',
      searchPath,
      '(',
      '-name',
      '.git',
      '-o',
      '-name',
      'node_modules',
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
      parseIgnores(path.dirname(file), await readFile(sandbox, file)),
    ),
  );

  return groups.flat();
};

const readFile = async (sandbox: Sandbox, file: string): Promise<string> =>
  sandbox.readFile(file).catch(() => '');

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

    const glob = compileGlob(pattern);

    if (!contains(ignore.base, fullPath)) {
      continue;
    }

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

const compileGlob = (pattern: string): RegExp | string => {
  let source = '^';

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === '[') {
      return pattern.includes(']', index + 1)
        ? 'unsupported character classes'
        : 'unclosed character class';
    }

    if (char === '*' && next === '*') {
      source += '.*';

      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(char);
    }
  }

  return new RegExp(`${source}$`);
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

const ancestors = (root: string, fullPath: string): readonly string[] => {
  const values: string[] = [];
  let current = path.dirname(fullPath);

  while (contains(root, current) && current !== root) {
    values.unshift(current);

    current = path.dirname(current);
  }

  return values;
};

const contains = (root: string, child: string): boolean =>
  child === root || child.startsWith(`${root}/`);

const lines = (value: string): readonly string[] =>
  value.split(/\r?\n/).filter((line) => line !== '');

const normalizePath = (value: string): string => {
  const resolved = path.normalize(path.isAbsolute(value) ? value : `/${value}`);

  return resolved === '/' ? resolved : resolved.replace(/\/+$/, '');
};

const empty = (error: string): FindOutput => ({
  results: [],
  total: 0,
  truncated: false,
  error,
});

const escapeRegExp = (value: string): string =>
  value.replace(/[\\^$+?.()|{}]/g, '\\$&');
