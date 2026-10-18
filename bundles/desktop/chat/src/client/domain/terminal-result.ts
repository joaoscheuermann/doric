/**
 * Reading the prompt a background terminal writes into its Thread into the
 * fields a block renders: the command, how it finished and the two streams the
 * host kept.
 *
 * The host frames a settled background command as Markdown and enqueues it as a
 * `terminal`-sourced prompt, so the durable text carries a header, three
 * identifiers, the outcome and two `## ` sections. Display keeps those fields
 * and drops the framing, and only when the header is present — anything else is
 * shown as the plain text it is rather than guessed at, the way a delegated
 * result reads (`delegated.ts`).
 */

import {
  isTerminationReason,
  type TerminationReason,
} from './terminal-tool.js';

/** A settled background command, as the host wrote it into the Thread. */
export type TerminalResult = {
  readonly terminalId: string;
  /** The prompt that started the command. */
  readonly promptId: string;
  readonly command: string;
  /** The exit code the process reported; negative for a signal. */
  readonly exitCode: number;
  readonly reason: TerminationReason;
  readonly durationMs: number;
  /** The last of the stream the host kept, verbatim. */
  readonly stdout: string;
  readonly stderr: string;
};

const HEADER = '# Background terminal result';

/** The one blank line the host writes between a section's heading and lines. */
const SECTION_BREAK = 2;

const OUTPUT_HEADING = '## Standard output';
const ERROR_HEADING = '## Standard error';

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** One `Label: value` line of the header, as it was written. */
const readField = (
  header: readonly string[],
  label: string,
): string | undefined => {
  const prefix = `${label}: `;
  const line = header.find((value) => value.startsWith(prefix));
  return line?.slice(prefix.length);
};

/** A line that opens another field of the header, which ends the one before it. */
const FIELD_LINE = /^[A-Z][^\n]*: /u;

/**
 * The command, which is the one field the shell may wrap over lines — a loop or
 * a here-document — so it reads to the next field rather than to its line's end.
 */
const readCommand = (header: readonly string[]): string | undefined => {
  const prefix = 'Command: ';
  const start = header.findIndex((line) => line.startsWith(prefix));
  if (start < 0) return undefined;
  const wrapped: string[] = [header[start].slice(prefix.length)];
  for (let index = start + 1; index < header.length; index += 1) {
    const line = header[index] ?? '';
    if (FIELD_LINE.test(line)) break;
    wrapped.push(line);
  }
  return wrapped.join('\n');
};

/** The lines between a section's heading and the next one, without their cap. */
const readSection = (
  lines: readonly string[],
  heading: string,
): string | undefined => {
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start < 0) return undefined;
  const end = lines.findIndex(
    (line, index) => index > start && line.startsWith('## '),
  );
  const content = lines.slice(
    start + SECTION_BREAK,
    end < 0 ? lines.length : end,
  );
  // The host writes one blank line before the next heading; the stream's own
  // trailing blank lines are lost in the same way, so they are trimmed here.
  return content.join('\n').replace(/\n+$/u, '');
};

/**
 * The background terminal result the host framed in `text`, or `undefined`
 * when `text` is not one. A field the header lacks leaves the text unread
 * rather than half-read: the transcript then draws the prompt as written.
 */
export const parseTerminalResult = (
  text: string,
): TerminalResult | undefined => {
  if (!text.startsWith(`${HEADER}\n`)) return undefined;

  const lines = text.split('\n');
  const terminalId = readField(lines, 'Terminal');
  const promptId = readField(lines, 'Originating prompt');
  const command = readCommand(lines);
  const exitCode = Number(readField(lines, 'Exit code'));
  const reason = readField(lines, 'Reason');
  const duration = /^(\d+) ms$/u.exec(readField(lines, 'Duration') ?? '');
  const stdout = readSection(lines, OUTPUT_HEADING);
  const stderr = readSection(lines, ERROR_HEADING);
  const durationMs = Number(duration?.[1]);

  if (
    terminalId === undefined ||
    terminalId.length === 0 ||
    promptId === undefined ||
    command === undefined ||
    !Number.isFinite(exitCode) ||
    !isTerminationReason(reason) ||
    !Number.isFinite(durationMs) ||
    stdout === undefined ||
    stderr === undefined
  )
    return undefined;

  return {
    terminalId,
    promptId,
    command,
    exitCode,
    reason,
    durationMs,
    stdout,
    stderr,
  };
};

/**
 * The background result of a turn written by a terminal, or `undefined` for
 * every other prompt: the human's, another Thread's, or a terminal prompt the
 * host did not frame.
 */
export const terminalResultInput = (
  source: unknown,
  text: string,
): TerminalResult | undefined =>
  record(source)?.kind === 'terminal' ? parseTerminalResult(text) : undefined;

/** Whether the command ended any way but a clean exit. */
export const terminalResultFailed = (result: TerminalResult): boolean =>
  result.reason !== 'exited' || result.exitCode !== 0;

/** Whether two readings of one result say the same thing. */
export const terminalResultEquals = (
  left: TerminalResult,
  right: TerminalResult,
): boolean =>
  left.terminalId === right.terminalId &&
  left.promptId === right.promptId &&
  left.command === right.command &&
  left.exitCode === right.exitCode &&
  left.reason === right.reason &&
  left.durationMs === right.durationMs &&
  left.stdout === right.stdout &&
  left.stderr === right.stderr;
