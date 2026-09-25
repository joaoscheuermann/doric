import { posix as path } from 'node:path';

import { z } from 'zod';

import { listSandboxTree, type SandboxTreeNode } from 'sandbox';
import { defineTool } from 'tool';

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

/** Creates the provider-neutral ASCII tree tool. */
const factory = defineTool({
  name: 'tree',
  description,
  input,
  output,
  execute: (sandbox, host, input): Promise<TreeOutput> =>
    execute(sandbox.root, sandbox, input),
});

export default factory;

/**
 * Renders what `packages/sandbox` decided is visible. Confinement, `.gitignore`,
 * hidden entries and ordering live there, so this tool only prints the answer.
 */
const execute = async (
  workspaceRoot: string,
  sandbox: Parameters<typeof listSandboxTree>[0],
  input: Input,
): Promise<TreeOutput> => {
  const displayPath =
    input.path === undefined || input.path === '' ? '.' : input.path;
  const result = await listSandboxTree(sandbox, {
    path: input.path ?? '',
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

  appendTree(result.entries, '', lines);

  return `${lines.join('\n')}\n`;
};

const appendTree = (
  entries: readonly SandboxTreeNode[],
  prefix: string,
  lines: string[],
): void => {
  for (const [index, entry] of entries.entries()) {
    const isLast = index === entries.length - 1;
    const connector = isLast ? '`-- ' : '|-- ';

    if (entry.type === 'file') {
      lines.push(`${prefix}${connector}${entry.name}`);

      continue;
    }

    const mark = lines.length;

    lines.push(`${prefix}${connector}${entry.name}/`);

    const childPrefix = isLast ? `${prefix}    ` : `${prefix}|   `;

    appendTree(entry.children ?? [], childPrefix, lines);

    if (lines.length === mark + 1) {
      lines[mark] = `${lines[mark]} (empty)`;
    }
  }
};
