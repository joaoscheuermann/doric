import { posix as path } from 'node:path';

import { z } from 'zod';

import type { Sandbox } from 'sandbox';
import { defineTool } from 'tool';

const description =
  "Edit a file using exact text replacement. Each edit's oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit.";

const entry = z
  .object({
    oldText: z.string(),
    newText: z.string(),
  })
  .strict();

export const input = z
  .object({
    path: z.string(),
    edits: z.array(entry),
  })
  .strict();

export const output = z
  .object({
    success: z.boolean(),
    diff: z.string(),
    first_changed_line: z.number().optional(),
    error: z.string().optional(),
  })
  .strict();

export type EditOutput = z.output<typeof output>;

type Input = z.output<typeof input>;

type NormalizedEdit = {
  readonly oldText: string;
  readonly newText: string;
};

type MatchedEdit = {
  readonly editIndex: number;
  readonly matchIndex: number;
  readonly matchLength: number;
  readonly newText: string;
};

type ReadResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly error: string };

/** Creates the provider-neutral exact replacement edit tool. */
const factory = defineTool({
  name: 'edit',
  description,
  input,
  output,
  execute: (sandbox, input): Promise<EditOutput> =>
    execute(sandbox.root, sandbox, input),
});

export default factory;

const execute = async (
  workspaceRoot: string,
  sandbox: Sandbox,
  input: Input,
): Promise<EditOutput> => {
  const filePath = resolvePath(workspaceRoot, input.path);
  const readResult = await readTarget(sandbox, filePath, input.path);

  if (!readResult.ok) {
    return errorOutput(readResult.error);
  }

  if (input.edits.length === 0) {
    return errorOutput('edits must contain at least one replacement.');
  }

  const [bom, content] = stripBom(readResult.content);
  const ending = detectLineEnding(content);
  const normalized = normalizeToLf(content);
  const edits = input.edits.map(normalizeEntry);
  const validation = validate(input.path, edits);

  if (validation !== undefined) {
    return errorOutput(validation);
  }

  const anyFuzzy = edits.some((edit) => !normalized.includes(edit.oldText));
  const baseContent = anyFuzzy ? normalizeForFuzzy(normalized) : normalized;
  const matched = locate(input.path, edits, baseContent);

  if (typeof matched === 'string') {
    return errorOutput(matched);
  }

  const newContent = apply(baseContent, matched);

  if (newContent === baseContent) {
    return errorOutput(
      `No changes made to ${input.path}. The replacement produced identical content.`,
    );
  }

  const writeError = await sandbox
    .writeFile(filePath, `${bom}${restoreLineEndings(newContent, ending)}`)
    .then(
      () => undefined,
      (error: unknown) => `Failed to write file: ${errorMessage(error)}`,
    );

  if (writeError !== undefined) {
    return errorOutput(writeError);
  }

  return {
    success: true,
    diff: diffPreview(baseContent, newContent).lines,
    first_changed_line: firstChangedLine(baseContent, newContent),
  };
};

const readTarget = async (
  sandbox: Sandbox,
  filePath: string,
  displayPath: string,
): Promise<ReadResult> => {
  try {
    return { ok: true, content: await sandbox.readFile(filePath) };
  } catch (error) {
    return { ok: false, error: readFailure(displayPath, error) };
  }
};

const normalizeEntry = (edit: z.output<typeof entry>): NormalizedEdit => ({
  oldText: normalizeForFuzzy(normalizeToLf(edit.oldText)),
  newText: normalizeForFuzzy(normalizeToLf(edit.newText)),
});

const validate = (
  filePath: string,
  edits: readonly NormalizedEdit[],
): string | undefined => {
  for (const [index, edit] of edits.entries()) {
    if (edit.oldText === '') {
      return edits.length === 1
        ? `oldText must not be empty in ${filePath}.`
        : `edits[${index}].oldText must not be empty in ${filePath}.`;
    }

    if (edit.oldText === edit.newText) {
      return edits.length === 1
        ? `No changes made to ${filePath}. The replacement produced identical content.`
        : `No changes made by edits[${index}] in ${filePath}. The replacement produced identical content.`;
    }
  }

  return undefined;
};

const locate = (
  filePath: string,
  edits: readonly NormalizedEdit[],
  baseContent: string,
): readonly MatchedEdit[] | string => {
  const matched = edits.map((edit, index) => {
    const matchIndex = baseContent.indexOf(edit.oldText);

    if (matchIndex < 0) {
      return missingMatch(filePath, index, edits.length);
    }

    const occurrences = countOccurrences(baseContent, edit.oldText);

    if (occurrences > 1) {
      return duplicateMatch(filePath, index, edits.length, occurrences);
    }

    return {
      editIndex: index,
      matchIndex,
      matchLength: edit.oldText.length,
      newText: edit.newText,
    };
  });

  const failure = matched.find(
    (value): value is string => typeof value === 'string',
  );

  if (failure !== undefined) {
    return failure;
  }

  const sorted = [...(matched as readonly MatchedEdit[])].sort(
    (left, right) => left.matchIndex - right.matchIndex,
  );

  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];

    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      return `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${filePath}. Merge them into one edit.`;
    }
  }

  return sorted;
};

const apply = (baseContent: string, edits: readonly MatchedEdit[]): string =>
  [...edits]
    .reverse()
    .reduce(
      (content, edit) =>
        `${content.slice(0, edit.matchIndex)}${edit.newText}${content.slice(
          edit.matchIndex + edit.matchLength,
        )}`,
      baseContent,
    );

const missingMatch = (
  filePath: string,
  index: number,
  count: number,
): string =>
  count === 1
    ? `Could not find the exact text in ${filePath}. The old text must match exactly including all whitespace and newlines.`
    : `Could not find edits[${index}] in ${filePath}. The oldText must match exactly including all whitespace and newlines.`;

const duplicateMatch = (
  filePath: string,
  index: number,
  count: number,
  occurrences: number,
): string =>
  count === 1
    ? `Found ${occurrences} occurrences of the text in ${filePath}. The text must be unique. Please provide more context.`
    : `Found ${occurrences} occurrences of edits[${index}] in ${filePath}. Each oldText must be unique. Please provide more context.`;

const countOccurrences = (content: string, needle: string): number => {
  let count = 0;
  let index = content.indexOf(needle);

  while (index >= 0) {
    count += 1;

    index = content.indexOf(needle, index + needle.length);
  }

  return count;
};

const diffPreview = (
  oldContent: string,
  newContent: string,
): { readonly lines: string } => {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const prefix = commonPrefix(oldLines, newLines);
  const suffix = commonSuffix(oldLines.slice(prefix), newLines.slice(prefix));
  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix);
  const newChanged = newLines.slice(prefix, newLines.length - suffix);
  const start = Math.max(prefix - 3, 0);
  const width = String(Math.max(oldLines.length, newLines.length, 1)).length;
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

  for (
    let index = prefix + oldChanged.length;
    index < Math.min(oldLines.length, prefix + oldChanged.length + 3);
    index += 1
  ) {
    lines.push(formatLine(index + 1, ' ', oldLines[index] ?? '', width));
  }

  return { lines: lines.join('\n') };
};

const firstChangedLine = (
  oldContent: string,
  newContent: string,
): number | undefined => {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const prefix = commonPrefix(oldLines, newLines);

  return prefix < oldLines.length || prefix < newLines.length
    ? prefix + 1
    : undefined;
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

const normalizeToLf = (value: string): string =>
  value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');

const detectLineEnding = (value: string): string =>
  value.indexOf('\r\n') >= 0 ? '\r\n' : '\n';

const restoreLineEndings = (value: string, ending: string): string =>
  ending === '\r\n' ? value.replaceAll('\n', '\r\n') : value;

const stripBom = (value: string): readonly [string, string] =>
  value.startsWith('\uFEFF') ? ['\uFEFF', value.slice(1)] : ['', value];

const normalizeForFuzzy = (value: string): string =>
  splitLines(value)
    .map((line) => line.trimEnd())
    .join('\n');

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

const readFailure = (filePath: string, error: unknown): string =>
  hasCode(error, 'ENOENT')
    ? `File not found: ${filePath}`
    : `Failed to read file: ${errorMessage(error)}`;

const hasCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === code;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const errorOutput = (error: string): EditOutput => ({
  success: false,
  diff: '',
  error,
});
