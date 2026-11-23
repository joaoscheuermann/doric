// `sandbox/v1` content messages ⇄ the `sandbox` package's types (phase 3,
// slice S47a). Pure, never throw (except `sshOf`). Each pair is lossless for
// every field both sides declare; absent stays absent.

import type { MessageInitShape } from '@bufbuild/protobuf';
import { ContractError } from 'bundle/contracts';
import type {
  ClonedRepo,
  CloneRepoInput,
  SandboxDiffInput,
  SandboxExecInput,
  SandboxExecResult,
  SandboxProcessInput,
  SandboxProcessOutput,
  SandboxSshAccess,
  SandboxStats,
} from 'sandbox';

import type {
  ClonedRepo as ClonedRepoMessage,
  CloneRepoInputSchema,
  SandboxDiffInput as DiffInputMessage,
  SandboxExecInput as ExecInputMessage,
  SandboxExecResult as ExecResultMessage,
  SandboxProcessInput as ProcessInputMessage,
  SandboxProcessOutput as ProcessOutputMessage,
  SandboxDiffInputSchema,
  SandboxExecInputSchema,
  SandboxExecResultSchema,
  SandboxProcessInputSchema,
  SandboxSshAccessSchema,
  SandboxStatsSchema,
  SandboxSshAccess as SshMessage,
  SandboxStats as StatsMessage,
} from '../../contracts/gen/doric/sandbox/v1/sandbox_pb.js';

/** `{ [key]: value }`, or nothing when `value` is undefined: absent stays absent. */
const present = <K extends string, V>(
  key: K,
  value: V | undefined,
): { [P in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

/** `SandboxExecInput` as a message; `signal` is not carried (the caller passes it as the call's signal). Empty `env` stays empty. */
export const execInputMessage = (
  input: SandboxExecInput,
): MessageInitShape<typeof SandboxExecInputSchema> => ({
  cmd: [...input.cmd],
  ...present('cwd', input.cwd),
  env: [...(input.env ?? [])],
  ...present('user', input.user),
  ...present('timeoutMs', input.timeoutMs),
  ...present('tty', input.tty),
});

/** A request's exec input; an empty `env` is absent, as docker's `execInputOf` reads it. */
export const execInputOf = (message: ExecInputMessage): SandboxExecInput => ({
  cmd: [...message.cmd],
  ...present('cwd', message.cwd),
  ...(message.env.length === 0 ? {} : { env: [...message.env] }),
  ...present('user', message.user),
  ...present('timeoutMs', message.timeoutMs),
  ...present('tty', message.tty),
});

/** `exitCode: null` is an absent `exit_code`; the byte fields are copied as is. */
export const execResultMessage = (
  result: SandboxExecResult,
): MessageInitShape<typeof SandboxExecResultSchema> => ({
  ...present('exitCode', result.exitCode ?? undefined),
  stdout: result.stdout,
  stderr: result.stderr,
  stdoutBytes: result.stdoutBytes,
  stderrBytes: result.stderrBytes,
});

/** An absent `exit_code` is `exitCode: null`; absent bytes are empty `Uint8Array`s. */
export const execResultOf = (
  message: ExecResultMessage,
): SandboxExecResult => ({
  exitCode: message.exitCode ?? null,
  stdout: message.stdout,
  stderr: message.stderr,
  stdoutBytes: message.stdoutBytes,
  stderrBytes: message.stderrBytes,
});

/** As `execInputMessage`, plus `cols`/`rows`; `onOutput` is not carried. */
export const processInputMessage = (
  input: SandboxProcessInput,
): MessageInitShape<typeof SandboxProcessInputSchema> => ({
  cmd: [...input.cmd],
  ...present('cwd', input.cwd),
  env: [...(input.env ?? [])],
  ...present('user', input.user),
  ...present('timeoutMs', input.timeoutMs),
  ...present('tty', input.tty),
  ...present('cols', input.cols),
  ...present('rows', input.rows),
});

/** A `StartHead`'s process input, without `onOutput`. */
export const processInputOf = (
  message: ProcessInputMessage,
): Omit<SandboxProcessInput, 'onOutput'> => ({
  cmd: [...message.cmd],
  ...present('cwd', message.cwd),
  ...(message.env.length === 0 ? {} : { env: [...message.env] }),
  ...present('user', message.user),
  ...present('timeoutMs', message.timeoutMs),
  ...present('tty', message.tty),
  ...present('cols', message.cols),
  ...present('rows', message.rows),
});

/** `{stream, data}`; a `stream` other than `stdout`/`stderr` cannot occur (protovalidate). */
export const processOutputOf = (
  message: ProcessOutputMessage,
): SandboxProcessOutput => ({
  stream: message.stream === 'stderr' ? 'stderr' : 'stdout',
  data: message.data,
});

export const statsMessage = (
  stats: SandboxStats,
): MessageInitShape<typeof SandboxStatsSchema> => ({
  ...present('cpuPercent', stats.cpuPercent),
  ...present('cpuCount', stats.cpuCount),
  ...present('memoryUsedBytes', stats.memoryUsedBytes),
  ...present('memoryLimitBytes', stats.memoryLimitBytes),
  at: stats.at,
});

export const statsOf = (message: StatsMessage): SandboxStats => ({
  ...present('cpuPercent', message.cpuPercent),
  ...present('cpuCount', message.cpuCount),
  ...present('memoryUsedBytes', message.memoryUsedBytes),
  ...present('memoryLimitBytes', message.memoryLimitBytes),
  at: message.at,
});

export const sshMessage = (
  ssh: SandboxSshAccess,
): MessageInitShape<typeof SandboxSshAccessSchema> => ({
  host: ssh.host,
  port: ssh.port,
  username: ssh.username,
  privateKey: ssh.privateKey,
  knownHosts: ssh.knownHosts,
  hostKeyFingerprint: ssh.hostKeyFingerprint,
});

/** Throws `ContractError('invalid_output')` when `username` is not `'root'` (today's type allows nothing else). */
export const sshOf = (message: SshMessage): SandboxSshAccess => {
  if (message.username !== 'root')
    throw new ContractError(
      'invalid_output',
      `Sandbox SSH access is for root, not ${message.username}.`,
    );
  return {
    host: message.host,
    port: message.port,
    username: 'root',
    privateKey: message.privateKey,
    knownHosts: message.knownHosts,
    hostKeyFingerprint: message.hostKeyFingerprint,
  };
};

export const diffInputMessage = (
  input: SandboxDiffInput,
): MessageInitShape<typeof SandboxDiffInputSchema> => ({
  ...present('cwd', input.cwd),
  paths: [...(input.paths ?? [])],
});

export const diffInputOf = (message: DiffInputMessage): SandboxDiffInput => ({
  ...present('cwd', message.cwd),
  ...(message.paths.length === 0 ? {} : { paths: [...message.paths] }),
});

/** `auth` as the `GitAuth` oneof (`token` / `basic`). */
export const cloneInputMessage = (
  input: CloneRepoInput,
): MessageInitShape<typeof CloneRepoInputSchema> => ({
  url: input.url,
  ...present('directory', input.directory),
  ...present('branch', input.branch),
  ...present('commit', input.commit),
  ...present('timeoutMs', input.timeoutMs),
  ...(input.auth === undefined
    ? {}
    : {
        auth: {
          kind:
            input.auth.kind === 'token'
              ? {
                  case: 'token' as const,
                  value: {
                    token: input.auth.token,
                    ...present('username', input.auth.username),
                  },
                }
              : {
                  case: 'basic' as const,
                  value: {
                    username: input.auth.username,
                    password: input.auth.password,
                  },
                },
        },
      }),
});

export const clonedOf = (message: ClonedRepoMessage): ClonedRepo => ({
  path: message.path,
  commit: message.commit,
});
