import { Buffer } from 'node:buffer';
import { posix as path } from 'node:path';

import { z } from 'zod';

import type { Sandbox, SandboxExecResult } from 'sandbox';
import { defineTool, type ToolFactory } from 'tool';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const STREAM_EDGE_BYTES = 12_000;
const description =
  'Runs one non-interactive Git command in the sandbox from structured arguments, without shell interpretation. Supports repository inspection and mutation, including clone, worktree, commit, fetch, push, rebase, and conflict workflows.';

export const input = z
  .object({
    args: z.array(z.string().max(8192)).min(1).max(128),
    working_directory: z.string().optional(),
    timeout_ms: z.number().int().nonnegative().optional(),
  })
  .strict();

const stream = z
  .object({
    bytes: z.number().int().nonnegative(),
    text: z.string(),
    truncated: z.boolean(),
    omitted_bytes: z.number().int().nonnegative(),
  })
  .strict();

export const output = z
  .object({
    schema: z.literal('git.command.v1'),
    working_directory: z.string(),
    exit_code: z.number().int(),
    duration_ms: z.number().int().nonnegative(),
    success: z.boolean(),
    stdout: stream,
    stderr: stream,
  })
  .strict();

export type GitOutput = z.output<typeof output>;

type Input = z.output<typeof input>;

const environment = [
  'GIT_TERMINAL_PROMPT=0',
  'GIT_EDITOR=true',
  'GIT_SEQUENCE_EDITOR=true',
  'GCM_INTERACTIVE=Never',
] as const;

/** Creates the provider-neutral, non-interactive Git command tool. */
export const createTool = (): ToolFactory<typeof input, typeof output> =>
  defineTool({
    name: 'git',
    description,
    input,
    output,
    execute: (sandbox, input): Promise<GitOutput> => execute(sandbox, input),
  });

export default createTool();

const execute = async (sandbox: Sandbox, input: Input): Promise<GitOutput> => {
  const started = Date.now();

  const requested =
    input.working_directory?.trim() === ''
      ? sandbox.root
      : (input.working_directory ?? sandbox.root);
  let workingDirectory = requested;

  try {
    workingDirectory = resolvePath(sandbox.root, requested);

    const result = await sandbox.exec({
      cmd: ['git', ...input.args],
      cwd: workingDirectory,
      env: environment,
      timeoutMs: Math.min(
        input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
      ),
    });

    return finish(workingDirectory, result, started);
  } catch (error) {
    return finish(workingDirectory, failed(error), started);
  }
};

const finish = (
  workingDirectory: string,
  result: Pick<SandboxExecResult, 'exitCode' | 'stdout' | 'stderr'>,
  started: number,
): GitOutput => {
  const exitCode = result.exitCode ?? -1;

  return {
    schema: 'git.command.v1',
    working_directory: workingDirectory,
    exit_code: exitCode,
    duration_ms: Date.now() - started,
    success: exitCode === 0,
    stdout: compact(result.stdout),
    stderr: compact(result.stderr),
  };
};

const failed = (
  error: unknown,
): Pick<SandboxExecResult, 'exitCode' | 'stdout' | 'stderr'> => ({
  exitCode: -1,
  stdout: '',
  stderr: `Failed to execute Git in sandbox: ${message(error)}`,
});

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const compact = (value: string): z.output<typeof stream> => {
  const bytes = Buffer.from(value);
  const retainedBytes = STREAM_EDGE_BYTES * 2;

  if (bytes.byteLength <= retainedBytes) {
    return {
      bytes: bytes.byteLength,
      text: value,
      truncated: false,
      omitted_bytes: 0,
    };
  }

  const omittedBytes = bytes.byteLength - retainedBytes;
  const head = bytes.subarray(0, STREAM_EDGE_BYTES).toString('utf8');
  const tail = bytes.subarray(-STREAM_EDGE_BYTES).toString('utf8');

  return {
    bytes: bytes.byteLength,
    text: `${head}\n[${omittedBytes} bytes omitted]\n${tail}`,
    truncated: true,
    omitted_bytes: omittedBytes,
  };
};

const resolvePath = (root: string, value: string): string => {
  const workspace = path.normalize(root);

  const resolved = path.normalize(
    path.isAbsolute(value) ? value : path.join(workspace, value),
  );

  if (resolved !== workspace && !resolved.startsWith(`${workspace}/`)) {
    throw new Error(`Git working directory must stay under ${workspace}.`);
  }

  return resolved;
};
