/**
 * Reading an `edit` or `write` tool call's serialized input and output into the
 * fields a file-diff block renders: the target path, the line counts
 * (+added / -removed), the parsed diff lines, and any failure message.
 */

export type DiffLineKind = 'context' | 'add' | 'remove';

export type DiffLine = {
  readonly kind: DiffLineKind;
  readonly lineNumber: number | null;
  readonly text: string;
};

export type EditEntry = {
  readonly oldText: string;
  readonly newText: string;
};

export type ParsedEditCall = {
  readonly path?: string;
  readonly fileName?: string;
  readonly directory?: string;
  readonly edits: readonly EditEntry[];
  readonly success?: boolean;
  readonly firstChangedLine?: number;
  readonly diffLines: readonly DiffLine[];
  readonly added: number;
  readonly removed: number;
  readonly error?: string;
  /** Raw result text when the output is not a JSON `EditOutput`/`WriteOutput` record. */
  readonly rawOutput?: string;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const parseJsonRecord = (text: string): Record<string, unknown> | undefined => {
  if (text.trim().length === 0) return undefined;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
};

const splitLines = (value: string): readonly string[] => {
  if (value === '') return [];
  const normalized = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  return normalized.endsWith('\n')
    ? normalized.slice(0, -1).split('\n')
    : normalized.split('\n');
};

const NUMBERED_DIFF_LINE = /^\s*(\d+)\s([ +-])(.*)$/;
const DIFF_SUMMARY_HEADER = /^Edited\s+.+\s+\(\+(\d+)\s+-(\d+)\)$/;

/**
 * Parses the numbered diff preview produced by `files`'s `edit` and `write`
 * tools (`"  12 -old"` / `"  12 +new"` / `"  10  context"`), stripping the
 * leading `"Edited <path> (+N -M)"` summary line when present.
 */
export const parseDiffLines = (diff: string): readonly DiffLine[] => {
  const rawLines = splitLines(diff);
  const parsed: DiffLine[] = [];

  for (const [index, raw] of rawLines.entries()) {
    if (index === 0 && DIFF_SUMMARY_HEADER.test(raw)) {
      continue;
    }

    const match = raw.match(NUMBERED_DIFF_LINE);
    if (match !== null) {
      const lineNumber = Number(match[1]);
      const marker = match[2];
      const text = match[3] ?? '';
      const kind: DiffLineKind =
        marker === '+' ? 'add' : marker === '-' ? 'remove' : 'context';
      parsed.push({ kind, lineNumber, text });
      continue;
    }

    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      parsed.push({ kind: 'add', lineNumber: null, text: raw.slice(1) });
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      parsed.push({ kind: 'remove', lineNumber: null, text: raw.slice(1) });
    } else if (raw.startsWith(' ')) {
      parsed.push({ kind: 'context', lineNumber: null, text: raw.slice(1) });
    } else {
      parsed.push({ kind: 'context', lineNumber: null, text: raw });
    }
  }

  return parsed;
};

const parseHeaderCounts = (
  diff: string,
): { readonly added: number; readonly removed: number } | undefined => {
  const firstLine = splitLines(diff)[0];
  if (firstLine === undefined) return undefined;
  const match = firstLine.match(DIFF_SUMMARY_HEADER);
  if (match === null) return undefined;
  return { added: Number(match[1]), removed: Number(match[2]) };
};

/** Builds preview diff lines from `input.edits` or `input.content` while running. */
const previewLinesFromInput = (
  edits: readonly EditEntry[],
  content?: string,
): readonly DiffLine[] => {
  if (edits.length > 0) {
    const lines: DiffLine[] = [];
    for (const edit of edits) {
      for (const line of splitLines(edit.oldText)) {
        lines.push({ kind: 'remove', lineNumber: null, text: line });
      }
      for (const line of splitLines(edit.newText)) {
        lines.push({ kind: 'add', lineNumber: null, text: line });
      }
    }
    return lines;
  }
  if (content !== undefined && content.length > 0) {
    return splitLines(content).map((line, index) => ({
      kind: 'add' as const,
      lineNumber: index + 1,
      text: line,
    }));
  }
  return [];
};

/** Splits a file path into its trailing file name and leading directory. */
export const splitFilePath = (
  filePath: string,
): { readonly fileName: string; readonly directory?: string } => {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const slash = normalized.lastIndexOf('/');
  if (slash === -1) return { fileName: normalized };
  if (slash === 0) return { fileName: normalized.slice(1), directory: '/' };
  return {
    fileName: normalized.slice(slash + 1),
    directory: normalized.slice(0, slash),
  };
};

const readEdits = (value: unknown): readonly EditEntry[] => {
  if (!Array.isArray(value)) return [];
  const entries: EditEntry[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (typeof rec?.oldText === 'string' && typeof rec?.newText === 'string') {
      entries.push({ oldText: rec.oldText, newText: rec.newText });
    }
  }
  return entries;
};

/** Parses an `edit` or `write` tool call's `args` and `result` JSON strings. */
export const parseEditCall = (
  args: string,
  result?: string,
  toolError?: string,
): ParsedEditCall => {
  const input = parseJsonRecord(args);
  const path =
    typeof input?.path === 'string' && input.path.trim().length > 0
      ? input.path.trim()
      : undefined;
  const parts = path === undefined ? undefined : splitFilePath(path);
  const edits = readEdits(input?.edits);
  const content =
    typeof input?.content === 'string' ? input.content : undefined;

  if (result === undefined || result.trim().length === 0) {
    const diffLines = previewLinesFromInput(edits, content);
    const added = diffLines.filter((line) => line.kind === 'add').length;
    const removed = diffLines.filter((line) => line.kind === 'remove').length;
    return {
      ...(path === undefined ? {} : { path }),
      ...(parts?.fileName === undefined ? {} : { fileName: parts.fileName }),
      ...(parts?.directory === undefined ? {} : { directory: parts.directory }),
      edits,
      diffLines,
      added,
      removed,
      ...(toolError === undefined ? {} : { error: toolError }),
    };
  }

  const output = parseJsonRecord(result);
  if (
    output !== undefined &&
    (typeof output.diff === 'string' || typeof output.success === 'boolean')
  ) {
    const success =
      typeof output.success === 'boolean' ? output.success : undefined;
    const firstChangedLine =
      typeof output.first_changed_line === 'number'
        ? output.first_changed_line
        : undefined;
    const outputError =
      typeof output.error === 'string' && output.error.trim().length > 0
        ? output.error
        : undefined;
    const error = toolError ?? outputError;
    const rawDiff = typeof output.diff === 'string' ? output.diff : '';
    const diffLines =
      rawDiff.length > 0
        ? parseDiffLines(rawDiff)
        : previewLinesFromInput(edits, content);
    const headerCounts =
      rawDiff.length > 0 ? parseHeaderCounts(rawDiff) : undefined;
    const added =
      headerCounts?.added ??
      diffLines.filter((line) => line.kind === 'add').length;
    const removed =
      headerCounts?.removed ??
      diffLines.filter((line) => line.kind === 'remove').length;

    return {
      ...(path === undefined ? {} : { path }),
      ...(parts?.fileName === undefined ? {} : { fileName: parts.fileName }),
      ...(parts?.directory === undefined ? {} : { directory: parts.directory }),
      edits,
      ...(success === undefined ? {} : { success }),
      ...(firstChangedLine === undefined ? {} : { firstChangedLine }),
      diffLines,
      added,
      removed,
      ...(error === undefined ? {} : { error }),
    };
  }

  const diffLines = previewLinesFromInput(edits, content);
  const added = diffLines.filter((line) => line.kind === 'add').length;
  const removed = diffLines.filter((line) => line.kind === 'remove').length;

  return {
    ...(path === undefined ? {} : { path }),
    ...(parts?.fileName === undefined ? {} : { fileName: parts.fileName }),
    ...(parts?.directory === undefined ? {} : { directory: parts.directory }),
    edits,
    diffLines,
    added,
    removed,
    rawOutput: result,
    ...(toolError === undefined ? {} : { error: toolError }),
  };
};
