/**
 * Reading a `terminal` tool call's serialized input and output into the fields
 * a terminal block renders: the command, its working directory, how it exited,
 * how long it ran, and the lines its streams kept.
 *
 * Both strings come from the log, so malformed JSON or an unexpected shape
 * falls back to whatever raw text is present rather than throwing.
 */

export type TerminalStream = {
  readonly bytes: number;
  readonly lines: number;
  readonly head: readonly string[];
  readonly tail: readonly string[];
  readonly omittedLines: number;
  readonly omittedBytes: number;
  readonly truncated: boolean;
};

export type TerminationReason = 'exited' | 'timeout' | 'terminated' | 'failed';

export type ParsedTerminalCall = {
  readonly command?: string;
  readonly workingDirectory?: string;
  readonly background?: boolean;
  readonly pty?: boolean;
  readonly terminalId?: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly terminationReason?: TerminationReason;
  readonly success?: boolean;
  readonly stdout?: TerminalStream;
  readonly stderr?: TerminalStream;
  readonly truncationMessage?: string;
  /** Raw result text when the output is not a `terminal.compact.v1` record. */
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

const readStringArray = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

const readStream = (value: unknown): TerminalStream | undefined => {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  if (!Array.isArray(record.head) || !Array.isArray(record.tail)) {
    return undefined;
  }
  return {
    bytes: typeof record.bytes === 'number' ? record.bytes : 0,
    lines: typeof record.lines === 'number' ? record.lines : 0,
    head: readStringArray(record.head),
    tail: readStringArray(record.tail),
    omittedLines:
      typeof record.omitted_lines === 'number' ? record.omitted_lines : 0,
    omittedBytes:
      typeof record.omitted_bytes === 'number' ? record.omitted_bytes : 0,
    truncated: record.truncated === true,
  };
};

export const isTerminationReason = (
  value: unknown,
): value is TerminationReason =>
  value === 'exited' ||
  value === 'timeout' ||
  value === 'terminated' ||
  value === 'failed';

/** Parses a `terminal` tool call's `args` and `result` JSON strings. */
export const parseTerminalCall = (
  args: string,
  result?: string,
): ParsedTerminalCall => {
  const input = parseJsonRecord(args);
  const commandFromInput =
    typeof input?.command === 'string' ? input.command : undefined;
  const cwdFromInput =
    typeof input?.working_directory === 'string'
      ? input.working_directory
      : undefined;
  const bgFromInput =
    typeof input?.background === 'boolean' ? input.background : undefined;
  const pty = typeof input?.pty === 'boolean' ? input.pty : undefined;

  if (result === undefined || result.trim().length === 0) {
    return {
      ...(commandFromInput === undefined ? {} : { command: commandFromInput }),
      ...(cwdFromInput === undefined ? {} : { workingDirectory: cwdFromInput }),
      ...(bgFromInput === undefined ? {} : { background: bgFromInput }),
      ...(pty === undefined ? {} : { pty }),
    };
  }

  const output = parseJsonRecord(result);
  if (output?.schema === 'terminal.compact.v1') {
    const command =
      typeof output.command === 'string' ? output.command : commandFromInput;
    const workingDirectory =
      typeof output.working_directory === 'string'
        ? output.working_directory
        : cwdFromInput;
    const exitCode =
      typeof output.exit_code === 'number' ? output.exit_code : undefined;
    const durationMs =
      typeof output.duration_ms === 'number' ? output.duration_ms : undefined;
    const terminationReason = isTerminationReason(output.termination_reason)
      ? output.termination_reason
      : undefined;
    const success =
      typeof output.success === 'boolean' ? output.success : undefined;
    const stdout = readStream(output.stdout);
    const stderr = readStream(output.stderr);
    const truncation = asRecord(output.truncation);
    const truncationMessage =
      truncation?.truncated === true && typeof truncation.message === 'string'
        ? truncation.message
        : undefined;

    return {
      ...(command === undefined ? {} : { command }),
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
      ...(bgFromInput === undefined ? {} : { background: bgFromInput }),
      ...(pty === undefined ? {} : { pty }),
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(terminationReason === undefined ? {} : { terminationReason }),
      ...(success === undefined ? {} : { success }),
      ...(stdout === undefined ? {} : { stdout }),
      ...(stderr === undefined ? {} : { stderr }),
      ...(truncationMessage === undefined ? {} : { truncationMessage }),
    };
  }

  if (output?.background === true && typeof output.terminal_id === 'string') {
    return {
      ...(commandFromInput === undefined ? {} : { command: commandFromInput }),
      ...(cwdFromInput === undefined ? {} : { workingDirectory: cwdFromInput }),
      background: true,
      terminalId: output.terminal_id,
      ...(pty === undefined ? {} : { pty }),
    };
  }

  return {
    ...(commandFromInput === undefined ? {} : { command: commandFromInput }),
    ...(cwdFromInput === undefined ? {} : { workingDirectory: cwdFromInput }),
    ...(bgFromInput === undefined ? {} : { background: bgFromInput }),
    ...(pty === undefined ? {} : { pty }),
    rawOutput: result,
  };
};

/** One-line preview of a shell command for the block's header. */
export const formatCommandPreview = (
  command: string | undefined,
  maxChars = 72,
): string => {
  if (command === undefined) return '';
  const collapsed = command.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars - 1)}…`;
};

/**
 * A whole output text as a stream a terminal card can draw: every line kept, so
 * nothing reads as omitted and the two halves of a stream are just its lines.
 * A text with no lines left once its trailing newlines are trimmed is no stream
 * at all, which is what a card draws as nothing.
 */
export const wholeStream = (text: string): TerminalStream | undefined => {
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return undefined;

  const lines = trimmed.split('\n');
  return {
    bytes: new TextEncoder().encode(text).length,
    lines: lines.length,
    head: lines,
    tail: [],
    omittedLines: 0,
    omittedBytes: 0,
    truncated: false,
  };
};

/** Human-readable duration for a completed terminal command. */
export const formatDuration = (durationMs: number): string => {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '';
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1).replace(/\.0$/, '')}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.round(seconds % 60);
  return remSeconds > 0 ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
};
