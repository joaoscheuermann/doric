import { posix as path } from 'node:path';

import { defineTool } from 'tool';
import { z } from 'zod';

import {
  currentDirectory,
  type LeaseSandbox,
  leaseSandbox,
} from '../sandbox.js';
import { visibleFiles } from './visible-files.js';

const DEFAULT_LIMIT = 100;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_LINE_LENGTH = 500;
const description =
  'Search file contents for a pattern. Returns matching lines with file paths and line numbers. A relative path resolves against the current working directory. Respects .gitignore. Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars.';

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

type PathKind = 'directory' | 'file' | 'missing' | 'other';

/** Creates the provider-neutral content search tool. */
export const tool = defineTool({
  name: 'grep',
  description,
  input,
  output,
  execute: async (input, call, services): Promise<GrepOutput> => {
    const cwd = await currentDirectory(services, call);
    const sandbox = await leaseSandbox(services, call);

    return execute(sandbox.root, cwd, sandbox, input);
  },
});

const execute = async (
  workspaceRoot: string,
  cwd: string,
  sandbox: LeaseSandbox,
  input: Input,
): Promise<GrepOutput> => {
  const searchDir = input.path ?? '.';
  const searchPath = resolvePath(workspaceRoot, cwd, searchDir);

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
  sandbox: LeaseSandbox,
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
  cwd: string,
  value: string,
): { readonly path: string } | string => {
  const root = normalizePath(workspaceRoot);

  const resolved = normalizePath(
    path.isAbsolute(value) ? value : path.join(cwd, value),
  );

  if (!contains(root, resolved)) {
    return `Path escapes workspace: ${value}`;
  }

  return { path: resolved };
};

const pathKind = async (
  sandbox: LeaseSandbox,
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
