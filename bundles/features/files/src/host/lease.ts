// `files/v1` over the router (phase 3, S53b): the routed Project lease. Each
// former `withLease` task runs on the sandbox one `runtime.lease/v1.Describe`
// names, every later step bound to it with `expectSandboxId`, and the first
// lease failure becomes the outcome's status (D3). The lease is the calling
// Project's, never the prompt's (D2).

import { Buffer } from 'node:buffer';

import type { Client } from '@connectrpc/connect';
import { type Call, ContractError, isContractError } from 'bundle/contracts';
import { contractErrorOf, type HostServices } from 'bundle/host';
import { type LeaseOutcome, leaseScopeMessage } from 'runtime/contracts';
import { LeaseService } from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import type { Sandbox, SandboxExecInput, SandboxExecResult } from 'sandbox';

import type { ProjectBytesSandbox } from './reads.js';

/**
 * The part of a Project sandbox the `files/v1` reads and writes use: its
 * id, root and command execution with the output as text and bytes. A
 * live `Sandbox` satisfies it, and so does `routedProjectLease`'s sandbox.
 */
export type ProjectSandbox = Pick<Sandbox, 'id' | 'root' | 'exec'>;

/** Runs `withLease`-shaped tasks on a Project's current sandbox over `runtime.lease/v1`. */
export interface ProjectLease {
  /**
   * Calls `Describe{target: {}}` once. Then it runs `task` with a
   * `ProjectBytesSandbox` whose `id`/`root` are the described ones:
   * - `exec(input)` is `Exec{target: {expectSandboxId: id}, request}`
   *   (`cmd`, `cwd`, `env`, `user`, `timeoutMs`, `tty`; `signal` is not
   *   sent). It answers `{exitCode (absent → null), stdout, stderr,
   *   stdoutBytes, stderrBytes}`.
   * - `fileBytes(path, max)` reads `ReadFileBytes{target: {expectSandboxId:
   *   id}, request: {path}}` and cancels the stream once `max` bytes arrived.
   *
   * Answers:
   * - `{status: 'ready', value}` when every step succeeded;
   * - `{status: leaseStatus}` (no `value`) when any step failed `unavailable`
   *   with the detail `leaseStatus` (`pending`, `unavailable`, `expired`,
   *   `missing`). The first such failure ends the run: later steps fail
   *   with it without a call, whatever `task` does with the rejection.
   *
   * Rejects with any other failure as `contractErrorOf` reads it (code and
   * details kept): `invalid_input` (no scope, protovalidate), `unavailable`
   * without `leaseStatus` (runtime unreachable), `limit_exceeded`, and the
   * sandbox's codes. Never acquires a sandbox.
   */
  run<T>(
    task: (sandbox: ProjectBytesSandbox) => Promise<T>,
  ): Promise<LeaseOutcome<T>>;
}

type LeaseStatus = Exclude<LeaseOutcome<unknown>['status'], 'ready'>;

/** The lease states `runtime.lease/v1` names in a not-ready failure. */
const LEASE_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'unavailable',
  'expired',
  'missing',
]);

/** The `leaseStatus` detail of a not-ready lease failure, when it is one. */
const leaseStatusOf = (failure: unknown): LeaseStatus | undefined => {
  if (!isContractError(failure) || failure.code !== 'unavailable') {
    return undefined;
  }

  const { details } = failure;
  const status: unknown =
    typeof details === 'object' && details !== null
      ? (details as { leaseStatus?: unknown }).leaseStatus
      : undefined;

  return typeof status === 'string' && LEASE_STATUSES.has(status)
    ? (status as LeaseStatus)
    : undefined;
};

/** The `SandboxExecInput` message of `input`, without its `signal`. */
export const execRequestOf = (input: SandboxExecInput) => ({
  cmd: [...input.cmd],
  env: [...(input.env ?? [])],
  ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  ...(input.user === undefined ? {} : { user: input.user }),
  ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  ...(input.tty === undefined ? {} : { tty: input.tty }),
});

/** A `ProjectLease` over `lease`; makes no call until `run`. */
export const routedProjectLease = (
  lease: Client<typeof LeaseService>,
): ProjectLease => ({
  run: async <T>(
    task: (sandbox: ProjectBytesSandbox) => Promise<T>,
  ): Promise<LeaseOutcome<T>> => {
    // The first lease failure ends the run: later steps fail with it without
    // a call, and the outcome is that status whatever the task answered.
    let failure:
      | { readonly status: LeaseStatus; readonly error: unknown }
      | undefined;

    const routed = async <R>(work: () => Promise<R>): Promise<R> => {
      if (failure !== undefined) throw failure.error;

      try {
        return await work();
      } catch (error) {
        const routedFailure = contractErrorOf(error);
        const status = leaseStatusOf(routedFailure);

        if (status !== undefined) failure ??= { status, error: routedFailure };

        throw routedFailure;
      }
    };

    const outcomeOf = (error: unknown): LeaseOutcome<T> => {
      if (failure !== undefined) return { status: failure.status };

      throw error;
    };

    let described: { readonly id: string; readonly root: string };

    try {
      described = await routed(() => lease.describe({ target: {} }));
    } catch (error) {
      return outcomeOf(error);
    }

    const { id, root } = described;
    const target = { expectSandboxId: id };

    const sandbox: ProjectBytesSandbox = {
      id,
      root,
      exec: async (input): Promise<SandboxExecResult> => {
        const { response } = await routed(() =>
          lease.exec({ target, request: execRequestOf(input) }),
        );

        return {
          exitCode: response?.exitCode ?? null,
          stdout: response?.stdout ?? '',
          stderr: response?.stderr ?? '',
          stdoutBytes: response?.stdoutBytes ?? new Uint8Array(),
          stderrBytes: response?.stderrBytes ?? new Uint8Array(),
        };
      },
      fileBytes: (path, max) =>
        routed(async () => {
          const reading = new AbortController();
          const chunks: Uint8Array[] = [];
          let size = 0;

          try {
            for await (const { chunk } of lease.readFileBytes(
              { target, request: { path } },
              { signal: reading.signal },
            )) {
              chunks.push(chunk);
              size += chunk.length;
              if (size >= max) break;
            }
          } finally {
            // Cancels the read when it stopped before the stream ended.
            reading.abort();
          }

          return Buffer.concat(chunks).subarray(0, max);
        }),
    };

    try {
      const value = await task(sandbox);

      return failure === undefined
        ? { status: 'ready', value }
        : { status: failure.status };
    } catch (error) {
      return outcomeOf(error);
    }
  },
});

/**
 * The `ProjectLease` of the Project `call` names: `routedProjectLease(services.use(LeaseService,
 * {scope: {projectId}}))`, where `projectId` is `call.scope.projectId`
 * (D2). Every lease call carries only that scope, never the caller's
 * `threadId`/`promptId`, and inherits the call's deadline and signal.
 *
 * Throws `ContractError('invalid_input', leaseScopeMessage)` when the scope
 * has no `projectId`; nothing is called.
 */
export const projectLeaseOf = (
  services: HostServices,
  call: Call,
): ProjectLease => {
  const projectId = call.scope?.projectId;

  if (projectId === undefined) {
    throw new ContractError('invalid_input', leaseScopeMessage);
  }

  return routedProjectLease(
    services.use(LeaseService, { scope: { projectId } }),
  );
};
