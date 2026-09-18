import { posix as path } from 'node:path';

import { z } from 'zod';

import type { Sandbox } from 'sandbox';
import { defineTool } from 'tool';

const DEFAULT_LIMIT = 100;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_LINE_LENGTH = 500;
const description =
  'Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars.';

export const input = z
  .object({
    pattern: z.string(),
    path: z.string().optional(),
    glob: z.string().optional(),
    ignoreCase: z.boolean().optional(),
    literal: z.boolean().optional(),
    context: z.number().int().nonnegative().optional(),
    limit: z.number().int().nonnegative().optional(),
  })
  .strict();

const match = z
  .object({
    file: z.string(),
    line: z.number(),
    text: z.string(),
    context_before: z.array(z.string()),
    context_after: z.array(z.string()),
  })
  .strict();

export const output = z
  .object({
    matches: z.array(match),
    total: z.number(),
    truncated: z.boolean(),
    lines_truncated: z.boolean(),
    error: z.string().optional(),
  })
  .strict();

export type GrepMatch = z.output<typeof match>;

export type GrepOutput = z.output<typeof output>;

type Input = z.output<typeof input>;

type IgnorePattern = {
  readonly base: string;
  readonly pattern: string;
  readonly negated: boolean;
};

type PathKind = 'directory' | 'file' | 'missing' | 'other';

/** Creates the provider-neutral content search tool. */
const factory = defineTool({
  name: 'grep',
  description,
  input,
  output,
  execute: (sandbox, input): Promise<GrepOutput> =>
    execute(sandbox.root, sandbox, input),
});

export default factory;

const execute = async (
  workspaceRoot: string,
  sandbox: Sandbox,
  input: Input,
): Promise<GrepOutput> => {
  const searchDir = input.path ?? '.';
  const searchPath = resolvePath(workspaceRoot, searchDir);

  if (typeof searchPath === 'string') {
    return empty(searchPath);
  }

  const kind = await pathKind(sandbox, workspaceRoot, searchPath.path);

  if (kind === 'missing') {
    return empty(`Path not found: ${searchDir}`);
  }

  const regex = compileSearch(input);

  if (typeof regex === 'string') {
    return empty(`Invalid regex pattern: ${regex}`);
  }

  const glob = input.glob === undefined ? undefined : compileGlob(input.glob);

  if (typeof glob === 'string') {
    return empty(`Invalid glob pattern '${input.glob}': ${glob}`);
  }

  const files =
    kind === 'file'
      ? [searchPath.path]
      : await visibleFiles(sandbox, workspaceRoot, searchPath.path);

  return collect(
    sandbox,
    searchPath.path,
    files,
    kind === 'file',
    regex,
    glob,
    input.context ?? 0,
    Math.max(input.limit ?? DEFAULT_LIMIT, 1),
  );
};

const collect = async (
  sandbox: Sandbox,
  searchPath: string,
  files: readonly string[],
  isSingleFile: boolean,
  regex: RegExp,
  glob: RegExp | undefined,
  context: number,
  limit: number,
): Promise<GrepOutput> => {
  const matches: GrepMatch[] = [];
  let totalBytes = 0;
  let truncated = false;
  let linesTruncated = false;

  for (const file of files) {
    const relative = isSingleFile
      ? path.basename(file)
      : path.relative(searchPath, file);

    if (
      glob !== undefined &&
      !glob.test(relative) &&
      !glob.test(path.basename(file))
    ) {
      continue;
    }

    const text = await sandbox.readFile(file).catch(() => undefined);

    if (text === undefined) {
      continue;
    }

    const lines = text.split(/\r?\n/);

    for (const [index, line] of lines.entries()) {
      regex.lastIndex = 0;

      if (!regex.test(line)) {
        continue;
      }

      const [matched, matchTruncated] = truncateLine(line);
      const [before, beforeTruncated] = contextBefore(lines, index, context);
      const [after, afterTruncated] = contextAfter(lines, index, context);

      linesTruncated ||= matchTruncated || beforeTruncated || afterTruncated;

      const entryBytes = relative.length + matched.length + 20;

      if (
        totalBytes + entryBytes > MAX_OUTPUT_BYTES ||
        matches.length >= limit
      ) {
        truncated = true;

        break;
      }

      totalBytes += entryBytes;

      matches.push({
        file: relative,
        line: index + 1,
        text: matched,
        context_before: [...before],
        context_after: [...after],
      });
    }

    if (truncated) {
      break;
    }
  }

  return {
    matches,
    total: matches.length,
    truncated,
    lines_truncated: linesTruncated,
  };
};

const visibleFiles = async (
  sandbox: Sandbox,
  workspaceRoot: string,
  searchPath: string,
): Promise<readonly string[]> => {
  const files = await listFiles(sandbox, workspaceRoot, searchPath);
  const ignores = await readIgnores(sandbox, workspaceRoot, searchPath);

  return files.filter(
    (file) => !isIgnoredWithAncestors(searchPath, file, false, ignores),
  );
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

const compileSearch = (input: Input): RegExp | string => {
  const pattern =
    input.literal === true ? escapeRegExp(input.pattern) : input.pattern;

  try {
    return new RegExp(pattern, input.ignoreCase === true ? 'i' : undefined);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const contextBefore = (
  lines: readonly string[],
  index: number,
  count: number,
): [readonly string[], boolean] =>
  contextLines(lines.slice(Math.max(index - count, 0), index));

const contextAfter = (
  lines: readonly string[],
  index: number,
  count: number,
): [readonly string[], boolean] =>
  contextLines(lines.slice(index + 1, index + 1 + count));

const contextLines = (
  lines: readonly string[],
): [readonly string[], boolean] => {
  let truncated = false;

  const values = lines.map((line) => {
    const [value, wasTruncated] = truncateLine(line);

    truncated ||= wasTruncated;

    return value;
  });

  return [values, truncated];
};

const truncateLine = (line: string): [string, boolean] => {
  if (line.length <= MAX_LINE_LENGTH) {
    return [line, false];
  }

  return [`${line.slice(0, MAX_LINE_LENGTH)}... [truncated]`, true];
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
  if (pattern.includes('[') || pattern.includes(']')) {
    return pattern.includes('[') && !pattern.includes(']')
      ? 'unclosed character class'
      : 'unsupported character classes';
  }

  const source = pattern
    .split('')
    .map((char, index, chars) => {
      if (char === '*' && chars[index + 1] === '*') {
        return '\0';
      }

      if (char === '*' && chars[index - 1] === '*') {
        return '';
      }

      if (char === '*') {
        return '[^/]*';
      }

      if (char === '?') {
        return '[^/]';
      }

      if (char === '\0') {
        return '.*';
      }

      return escapeRegExp(char);
    })
    .join('')
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

const empty = (error: string): GrepOutput => ({
  matches: [],
  total: 0,
  truncated: false,
  lines_truncated: false,
  error,
});

const escapeRegExp = (value: string): string =>
  value.replace(/[\\^$+?.()|{}]/g, '\\$&');
