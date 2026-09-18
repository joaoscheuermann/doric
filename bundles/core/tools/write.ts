import { posix as path } from 'node:path';

import { z } from 'zod';

import type { Sandbox } from 'sandbox';
import { defineTool } from 'tool';

const description =
  "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.";

export const input = z
  .object({
    path: z.string(),
    content: z.string(),
  })
  .strict();

export const output = z
  .object({
    success: z.boolean(),
    bytes_written: z.number(),
    diff: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();

export type WriteOutput = z.output<typeof output>;

type Input = z.output<typeof input>;

/** Creates the provider-neutral file write tool. */
const factory = defineTool({
  name: 'write',
  description,
  input,
  output,
  execute: (sandbox, input): Promise<WriteOutput> =>
    execute(sandbox.root, sandbox, input),
});

export default factory;

const execute = async (
  workspaceRoot: string,
  sandbox: Sandbox,
  input: Input,
): Promise<WriteOutput> => {
  if (input.path === '') {
    return writeError('Path must not be empty');
  }

  const filePath = resolvePath(workspaceRoot, input.path);
  const oldContent = await sandbox.readFile(filePath).catch(() => '');

  try {
    await sandbox.writeFile(filePath, input.content);
  } catch (error) {
    return writeError(`Failed to write file: ${message(error)}`);
  }

  const diff = diffPreview(oldContent, input.content);

  return {
    success: true,
    bytes_written: Buffer.byteLength(input.content),
    diff: `Edited ${input.path} (+${diff.added} -${diff.removed})\n${diff.lines}`,
  };
};

const writeError = (error: string): WriteOutput => ({
  success: false,
  bytes_written: 0,
  error,
});

const diffPreview = (
  oldContent: string,
  newContent: string,
): {
  readonly added: number;
  readonly removed: number;
  readonly lines: string;
} => {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const prefix = commonPrefix(oldLines, newLines);
  const suffix = commonSuffix(oldLines.slice(prefix), newLines.slice(prefix));
  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix);
  const newChanged = newLines.slice(prefix, newLines.length - suffix);
  const start = Math.max(prefix - 3, 0);
  const endOld = Math.min(oldLines.length, prefix + oldChanged.length + 3);
  const endNew = Math.min(newLines.length, prefix + newChanged.length + 3);
  const width = String(Math.max(endOld, endNew, 1)).length;
  const lines: string[] = [];

  for (let index = start; index < prefix; index += 1) {
    lines.push(formatLine(index + 1, ' ', oldLines[index] ?? '', width));
  }

  for (const [index, line] of oldChanged.entries()) {
    lines.push(formatLine(prefix + index + 1, '-', line, width));
  }

  for (const [index, line] of newChanged.entries()) {
    lines.push(formatLine(prefix + index + 1, '+', line, width));
  }

  for (let index = prefix + oldChanged.length; index < endOld; index += 1) {
    lines.push(formatLine(index + 1, ' ', oldLines[index] ?? '', width));
  }

  return {
    added: newChanged.length,
    removed: oldChanged.length,
    lines: lines.length === 0 ? '' : lines.join('\n'),
  };
};

const splitLines = (value: string): readonly string[] =>
  value === ''
    ? []
    : value.endsWith('\n')
      ? value.slice(0, -1).split(/\r?\n/)
      : value.split(/\r?\n/);

const commonPrefix = (
  left: readonly string[],
  right: readonly string[],
): number => {
  let index = 0;

  while (
    index < left.length &&
    index < right.length &&
    left[index] === right[index]
  ) {
    index += 1;
  }

  return index;
};

const commonSuffix = (
  left: readonly string[],
  right: readonly string[],
): number => {
  let count = 0;

  while (
    count < left.length &&
    count < right.length &&
    left[left.length - count - 1] === right[right.length - count - 1]
  ) {
    count += 1;
  }

  return count;
};

const formatLine = (
  line: number,
  marker: string,
  text: string,
  width: number,
): string => `${String(line).padStart(width, ' ')} ${marker}${text}`;

const resolvePath = (workspaceRoot: string, value: string): string =>
  path.normalize(
    path.isAbsolute(value) ? value : path.join(workspaceRoot, value),
  );

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
