import { posix as path } from 'node:path';

import { defineTool } from 'tool';
import { z } from 'zod';

import {
  currentDirectory,
  type LeaseSandbox,
  leaseSandbox,
} from '../sandbox.js';
import { visibleFiles } from './visible-files.js';

const DEFAULT_LIMIT = 1000;
const MAX_OUTPUT_BYTES = 50 * 1024;
const description =
  'Search for files by glob pattern. Returns matching file paths relative to the search directory. A relative path resolves against the current working directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first).';

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

type PathKind = 'directory' | 'file' | 'missing' | 'other';

/** Creates the provider-neutral file search tool. */
export const tool = defineTool({
  name: 'find',
  description,
  input,
  output,
  execute: async (input, call, services): Promise<FindOutput> => {
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
): Promise<FindOutput> => {
  const searchDir = input.path ?? '.';
  const searchPath = resolvePath(workspaceRoot, cwd, searchDir);

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

  const visible = await visibleFiles(sandbox, workspaceRoot, searchPath.path);

  return collect(searchPath.path, visible, glob, input.limit ?? DEFAULT_LIMIT);
};

const collect = (
  searchPath: string,
  files: readonly string[],
  glob: RegExp,
  limit: number,
): FindOutput => {
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

const empty = (error: string): FindOutput => ({
  results: [],
  total: 0,
  truncated: false,
  error,
});

const escapeRegExp = (value: string): string =>
  value.replace(/[\\^$+?.()|{}]/g, '\\$&');
