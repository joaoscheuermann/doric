import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { Host } from 'host';
import type { Sandbox } from 'sandbox';
import { defineTool, type ToolFactory } from 'tool';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const SHORT_OUTPUT_BYTE_LIMIT = 12_000;
const HEAD_LINE_LIMIT = 24;
const TAIL_LINE_LIMIT = 48;
const MAX_LINE_CHARS = 1000;
const DIAGNOSTIC_LINE_LIMIT = 20;
const DIAGNOSTIC_CONTEXT_RADIUS = 2;
const description =
  'Executes tracked shell commands in the current working directory. Foreground returns compact output and exit status. Set background to continue working immediately; the host delivers the terminal result to this Thread when it ends. Set pty for interactive commands (stdout and stderr are combined). A relative working_directory resolves against the current directory.';

export const input = z
  .object({
    command: z.string(),
    working_directory: z.string().optional(),
    timeout_ms: z.number().int().nonnegative().optional(),
    background: z.boolean().optional(),
    pty: z.boolean().optional(),
  })
  .strict();

const compactStreamSchema = z
  .object({
    bytes: z.number(),
    lines: z.number(),
    head: z.array(z.string()),
    tail: z.array(z.string()),
    omitted_lines: z.number(),
    omitted_bytes: z.number(),
    truncated: z.boolean(),
  })
  .strict();

const diagnosticContext = z
  .object({ line: z.number(), text: z.string() })
  .strict();

const terminalDiagnostic = z
  .object({
    kind: z.string(),
    stream: z.enum(['stdout', 'stderr']),
    line: z.number(),
    text: z.string(),
    context: z.array(diagnosticContext),
    repeat_count: z.number().optional(),
  })
  .strict();

const completedOutput = z
  .object({
    schema: z.literal('terminal.compact.v1'),
    trace_id: z.string().nullable(),
    command: z.string(),
    working_directory: z.string(),
    exit_code: z.number(),
    duration_ms: z.number(),
    termination_reason: z
      .enum(['exited', 'timeout', 'terminated', 'failed'])
      .optional(),
    success: z.boolean(),
    stdout: compactStreamSchema,
    stderr: compactStreamSchema,
    diagnostics: z.array(terminalDiagnostic),
    truncation: z
      .object({ truncated: z.boolean(), message: z.string() })
      .strict(),
    raw_output_ref: z.string().nullable(),
    trace_error: z.string().optional(),
  })
  .strict();
export const output = z.union([
  completedOutput,
  z.object({ terminal_id: z.string(), background: z.literal(true) }).strict(),
]);

export type CompactStream = z.output<typeof compactStreamSchema>;

export type TerminalDiagnostic = z.output<typeof terminalDiagnostic>;

export type TerminalOutput = z.output<typeof completedOutput>;

type Input = z.output<typeof input>;

interface Options {
  readonly traceDir?: string;
}

interface Execution {
  readonly command: string;
  readonly workingDirectory: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly reason?: 'exited' | 'timeout' | 'terminated' | 'failed';
}

/** Creates the provider-neutral sandbox terminal tool. */
export const createTool = (
  options: Options = {},
): ToolFactory<typeof input, typeof output> =>
  defineTool({
    name: 'terminal',
    description,
    input,
    output,
    execute: (sandbox, host, input) =>
      execute(host.workspace.cwd(), sandbox, options.traceDir, input, host),
  });

export default createTool();

const execute = async (
  cwd: string,
  sandbox: Sandbox,
  traceDir: string | undefined,
  input: Input,
  host: Host,
): Promise<z.output<typeof output>> => {
  const workingDirectory = resolvePath(
    cwd,
    input.working_directory?.trim() === ''
      ? '.'
      : (input.working_directory ?? '.'),
  );

  const timeoutMs = Math.min(
    input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );

  if (host.terminals !== undefined) {
    const result = await host.terminals.run({
      command: input.command,
      cwd: workingDirectory,
      timeoutMs,
      ...(input.background === undefined
        ? {}
        : { background: input.background }),
      ...(input.pty === undefined ? {} : { pty: input.pty }),
    });
    if ('background' in result)
      return { terminal_id: result.terminalId, background: true };
    const execution = { ...result, command: input.command, workingDirectory };
    return compact(execution, await writeTrace(traceDir, execution));
  }
  if (input.background || input.pty)
    throw new Error('This host does not support live terminals.');
  const execution = await runCommand(
    sandbox,
    input.command,
    workingDirectory,
    timeoutMs,
  );

  return compact(execution, await writeTrace(traceDir, execution));
};

const runCommand = async (
  sandbox: Sandbox,
  command: string,
  workingDirectory: string,
  timeoutMs: number,
): Promise<Execution> => {
  const started = Date.now();

  try {
    const result = await sandbox.exec({
      cmd: ['sh', '-lc', command],
      cwd: workingDirectory,
      timeoutMs,
    });

    return {
      command,
      workingDirectory,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? -1,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      command,
      workingDirectory,
      stdout: '',
      stderr: `Failed to execute command in sandbox: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: -1,
      durationMs: Date.now() - started,
    };
  }
};

const compact = (
  execution: Execution,
  trace: {
    readonly traceId: string | null;
    readonly rawOutputRef: string | null;
    readonly error?: string;
  },
): TerminalOutput => {
  const stdout = compactStream(execution.stdout);
  const stderr = compactStream(execution.stderr);
  const truncated = stdout.truncated || stderr.truncated;

  return {
    schema: 'terminal.compact.v1',
    trace_id: trace.traceId,
    command: execution.command,
    working_directory: execution.workingDirectory,
    exit_code: execution.exitCode,
    duration_ms: execution.durationMs,
    ...(execution.reason === undefined
      ? {}
      : { termination_reason: execution.reason }),
    success:
      execution.exitCode === 0 &&
      (execution.reason === undefined || execution.reason === 'exited'),
    stdout,
    stderr,
    diagnostics: [...reduceDiagnostics(execution)],
    truncation: {
      truncated,
      message: truncated
        ? 'terminal output compacted; full raw output is available at raw_output_ref'
        : 'terminal output fits in compact payload',
    },
    raw_output_ref: trace.rawOutputRef,
    ...(trace.error === undefined ? {} : { trace_error: trace.error }),
  };
};

const compactStream = (text: string): CompactStream => {
  const lines = splitLines(text).map(capLine);
  const stats = { bytes: Buffer.byteLength(text), lines: lines.length };

  if (stats.bytes <= SHORT_OUTPUT_BYTE_LIMIT) {
    return {
      bytes: stats.bytes,
      lines: stats.lines,
      head: lines,
      tail: [],
      omitted_lines: 0,
      omitted_bytes: 0,
      truncated: false,
    };
  }

  const head = lines.slice(0, HEAD_LINE_LIMIT);

  const tail = lines.slice(
    Math.max(lines.length - TAIL_LINE_LIMIT, HEAD_LINE_LIMIT),
  );

  const omitted = lines.slice(
    HEAD_LINE_LIMIT,
    Math.max(lines.length - TAIL_LINE_LIMIT, HEAD_LINE_LIMIT),
  );

  return {
    bytes: stats.bytes,
    lines: stats.lines,
    head,
    tail,
    omitted_lines: omitted.length,
    omitted_bytes: Buffer.byteLength(omitted.join('\n')),
    truncated: true,
  };
};

const writeTrace = async (
  traceDir: string | undefined,
  execution: Execution,
): Promise<{
  readonly traceId: string | null;
  readonly rawOutputRef: string | null;
  readonly error?: string;
}> => {
  if (traceDir === undefined) {
    return { traceId: null, rawOutputRef: null };
  }

  const traceId = randomUUID();
  const file = path.join(traceDir, `${traceId}.json`);

  try {
    await mkdir(traceDir, { recursive: true });

    await writeFile(file, JSON.stringify(execution, null, 2), 'utf8');

    return { traceId, rawOutputRef: file };
  } catch (error) {
    return {
      traceId,
      rawOutputRef: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const reduceDiagnostics = (
  execution: Execution,
): readonly TerminalDiagnostic[] => {
  const diagnostics = extractDiagnostics(execution.stdout, execution.stderr);

  return isCargoVerification(execution.command)
    ? appendCargoFailures(diagnostics, execution.stdout)
    : diagnostics;
};

const extractDiagnostics = (
  stdout: string,
  stderr: string,
): readonly TerminalDiagnostic[] =>
  [
    ...streamDiagnostics('stdout', stdout),
    ...streamDiagnostics('stderr', stderr),
  ]
    .sort(
      (left, right) =>
        diagnosticPriority(left.kind) - diagnosticPriority(right.kind) ||
        left.stream.localeCompare(right.stream) ||
        left.line - right.line,
    )
    .slice(0, DIAGNOSTIC_LINE_LIMIT);

const streamDiagnostics = (
  stream: 'stdout' | 'stderr',
  text: string,
): readonly TerminalDiagnostic[] => {
  const lines = splitLines(text);

  return lines.reduce<TerminalDiagnostic[]>((diagnostics, line, index) => {
    const kind = classifyDiagnostic(line);

    if (kind === undefined) {
      return diagnostics;
    }

    return mergeDiagnostic(diagnostics, {
      kind,
      stream,
      line: index + 1,
      text: capLine(line),
      context: contextLines(lines, index),
    });
  }, []);
};

const mergeDiagnostic = (
  diagnostics: readonly TerminalDiagnostic[],
  diagnostic: TerminalDiagnostic,
): TerminalDiagnostic[] => {
  const existing = diagnostics.findIndex(
    (value) =>
      value.kind === diagnostic.kind &&
      value.stream === diagnostic.stream &&
      value.text === diagnostic.text,
  );

  if (existing < 0) {
    return [...diagnostics, diagnostic];
  }

  return diagnostics.map((value, index) =>
    index === existing
      ? { ...value, repeat_count: (value.repeat_count ?? 1) + 1 }
      : value,
  );
};

const contextLines = (
  lines: readonly string[],
  index: number,
): TerminalDiagnostic['context'] => {
  const start = Math.max(index - DIAGNOSTIC_CONTEXT_RADIUS, 0);
  const end = Math.min(index + DIAGNOSTIC_CONTEXT_RADIUS + 1, lines.length);

  return lines.slice(start, end).map((line, offset) => ({
    line: start + offset + 1,
    text: capLine(line),
  }));
};

const classifyDiagnostic = (line: string): string | undefined => {
  const lower = line.toLowerCase();

  const checks: readonly [string, boolean][] = [
    ['rust_error', line.includes('error[E')],
    [
      'test_failure',
      lower.includes('test result: failed') ||
        lower === 'failures:' ||
        lower.includes(' failures') ||
        line.includes('FAILED'),
    ],
    [
      'cargo_error',
      lower.includes('could not compile') || lower.includes('test failed'),
    ],
    ['panic', lower.includes('panicked at') || lower.includes(' panicked')],
    [
      'exception',
      line.includes('Traceback') ||
        line.includes('Exception') ||
        line.includes('Caused by:'),
    ],
    ['typescript_error', line.includes('error TS') || /\bTS\d{4}\b/.test(line)],
    [
      'eslint_error',
      lower.includes('parsing error') ||
        lower.includes('no-unused-vars') ||
        lower.includes('problems'),
    ],
    [
      'error',
      lower.startsWith('error:') ||
        lower.includes(' error:') ||
        line.includes('ERROR') ||
        line.includes('Error:'),
    ],
    [
      'warning',
      lower.startsWith('warning:') ||
        lower.includes(' warning:') ||
        line.includes('WARN') ||
        line.includes('Warning:'),
    ],
  ];

  return checks.find(([, matches]) => matches)?.[0];
};

const diagnosticPriority = (kind: string): number =>
  kind === 'warning' ? 2 : kind === 'eslint_error' || kind === 'error' ? 1 : 0;

const appendCargoFailures = (
  diagnostics: readonly TerminalDiagnostic[],
  stdout: string,
): readonly TerminalDiagnostic[] => {
  const current = [...diagnostics];

  for (const [index, line] of splitLines(stdout).entries()) {
    if (line.startsWith('test ') && line.includes('FAILED')) {
      current.push({
        kind: 'cargo_test_failure',
        stream: 'stdout',
        line: index + 1,
        text: capLine(line),
        context: [],
      });
    }
  }

  return current;
};

const isCargoVerification = (command: string): boolean => {
  const normalized = command
    .replace(/["']/g, '')
    .replace(/\\/g, '/')
    .toLowerCase();

  return /(?:^|[\s;/])cargo(?:\.exe)?\s+(test|check|clippy)\b/.test(normalized);
};

const splitLines = (value: string): readonly string[] =>
  value === ''
    ? []
    : value.endsWith('\n') || value.endsWith('\r')
      ? value.trimEnd().split(/\r?\n/)
      : value.split(/\r?\n/);

const capLine = (line: string): string =>
  line.length <= MAX_LINE_CHARS
    ? line
    : `${line.slice(0, MAX_LINE_CHARS)} [line truncated; ${line.length - MAX_LINE_CHARS} chars omitted]`;

const resolvePath = (cwd: string, value: string): string =>
  path.posix.normalize(
    path.posix.isAbsolute(value) ? value : path.posix.join(cwd, value),
  );
