import { posix as path } from 'node:path';

import { listSandboxTree, type SandboxTreeNode } from 'sandbox';
import { defineTool } from 'tool';
import { z } from 'zod';

import { currentDirectory, leaseSandbox } from '../sandbox.js';

const description =
  'Display directory structure as an ASCII tree. Directories are listed first, then files, both sorted alphabetically. Respects .gitignore, ignores node_modules and __pycache__ unless a .gitignore negation brings them back, and excludes hidden files except .agents. A relative path resolves against the current working directory. Shows `depth` levels below the path (default 3); a directory at the last level shows how many entries it holds instead of its children, so call tree on it to look deeper.';

/** Levels shown below the listed directory when the call names no `depth`. */
const DEFAULT_DEPTH = 3;

export const input = z
  .object({
    path: z.string().optional(),
    exclude: z.array(z.string()).optional(),
    depth: z.number().int().positive().optional(),
  })
  .strict();
export const output = z.string();

export type TreeOutput = z.output<typeof output>;

type Input = z.output<typeof input>;

/** Creates the provider-neutral ASCII tree tool. */
export const tool = defineTool({
  name: 'tree',
  description,
  input,
  output,
  execute: async (input, call, services): Promise<TreeOutput> => {
    const cwd = await currentDirectory(services, call);
    const sandbox = await leaseSandbox(services, call);

    return execute(sandbox.root, cwd, sandbox, input);
  },
});

/**
 * Renders what `packages/sandbox` decided is visible. Confinement, `.gitignore`,
 * hidden entries and ordering live there, so this tool only prints the answer.
 */
const execute = async (
  workspaceRoot: string,
  cwd: string,
  sandbox: Parameters<typeof listSandboxTree>[0],
  input: Input,
): Promise<TreeOutput> => {
  const displayPath =
    input.path === undefined || input.path === '' ? '.' : input.path;
  const result = await listSandboxTree(sandbox, {
    path: resolvePath(cwd, input.path ?? ''),
    ...(input.exclude === undefined ? {} : { exclude: input.exclude }),
  });

  if (result.status === 'escaped') {
    return `Error: ${result.message}`;
  }

  if (result.status === 'missing') {
    return `Error: path not found: ${displayPath}`;
  }

  if (result.status === 'not_directory') {
    return `Error: path is not a directory: ${displayPath}`;
  }

  if (result.status === 'invalid_exclude') {
    return result.message;
  }

  if (result.status === 'excluded_root') {
    return `Error: exclude pattern matches the root directory: ${result.name}`;
  }

  const lines = [path.join(workspaceRoot, result.path)];

  appendTree(result.entries, '', lines, input.depth ?? DEFAULT_DEPTH);

  return `${lines.join('\n')}\n`;
};

/** Absolute paths stay absolute; a relative one names a place inside `cwd`. */
const resolvePath = (cwd: string, value: string): string =>
  path.isAbsolute(value) ? path.normalize(value) : path.join(cwd, value);

const appendTree = (
  entries: readonly SandboxTreeNode[],
  prefix: string,
  lines: string[],
  depth: number,
): void => {
  for (const [index, entry] of entries.entries()) {
    const isLast = index === entries.length - 1;
    const connector = isLast ? '`-- ' : '|-- ';

    if (entry.type === 'file') {
      lines.push(`${prefix}${connector}${entry.name}`);

      continue;
    }

    const children = entry.children ?? [];

    if (depth === 1 && children.length > 0) {
      lines.push(
        `${prefix}${connector}${entry.name}/ (${children.length} ${children.length === 1 ? 'entry' : 'entries'} not shown)`,
      );

      continue;
    }

    const mark = lines.length;

    lines.push(`${prefix}${connector}${entry.name}/`);

    const childPrefix = isLast ? `${prefix}    ` : `${prefix}|   `;

    appendTree(children, childPrefix, lines, depth - 1);

    if (lines.length === mark + 1) {
      lines[mark] = `${lines[mark]} (empty)`;
    }
  }
};
