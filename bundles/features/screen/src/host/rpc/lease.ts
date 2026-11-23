// `runtime.lease/v1` (1.4.0) as the `ScreenLease` the sessions run on, for
// the router path (spec "Sandbox leases"; phase 3, slice S49).

import { type Client, ConnectError } from '@connectrpc/connect';
import { fromConnectError, isContractError } from 'bundle/contracts';
import type { LeaseOutcome } from 'runtime/contracts';
import type { LeaseService } from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import type { SandboxExecInput, SandboxExecResult } from 'sandbox';

import type { ScreenLease } from '../provider.js';
import type { ScreenSandbox } from '../session.js';

type LeaseStatus = Exclude<LeaseOutcome<unknown>['status'], 'ready'>;

const LEASE_STATUSES: readonly string[] = [
  'pending',
  'unavailable',
  'expired',
  'missing',
];

/** A routed call's failure as `fromConnectError` reads it; else unchanged. */
export const routedError = (error: unknown): unknown =>
  error instanceof ConnectError ? fromConnectError(error) : error;

/** The `leaseStatus` of a not-ready lease's `UNAVAILABLE` failure. */
const leaseStatusOf = (failure: unknown): LeaseStatus | undefined => {
  if (!isContractError(failure) || failure.code !== 'unavailable') {
    return undefined;
  }

  const { details } = failure;
  const status =
    typeof details === 'object' && details !== null
      ? (details as { leaseStatus?: unknown }).leaseStatus
      : undefined;

  return typeof status === 'string' && LEASE_STATUSES.includes(status)
    ? (status as LeaseStatus)
    : undefined;
};

/** The `SandboxExecInput` message of `input`, without its `signal`. */
const execRequestOf = (input: SandboxExecInput) => ({
  cmd: [...input.cmd],
  env: [...(input.env ?? [])],
  ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  ...(input.user === undefined ? {} : { user: input.user }),
  ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  ...(input.tty === undefined ? {} : { tty: input.tty }),
});

/**
 * A `ScreenLease` over `runtime.lease/v1` (1.4.0), for the router path. The
 * spec's replacement of a `withLease` task (A6): `withLease(task)`
 * 1. calls `Describe({ target: {} })` once;
 * 2. runs `task` with a `ScreenSandbox` whose `id` is the described `id` and
 *    whose `exec(input)` calls `Exec({ target: { expectSandboxId: id },
 *    request: input })` (`cmd`, `cwd`, `env`, `user`, `timeoutMs`, `tty`;
 *    `signal` is not sent: the call's own signal applies) and answers
 *    `{ exitCode (absent → null), stdout, stderr, stdoutBytes, stderrBytes }`;
 * 3. answers `{ status: 'ready', value }`.
 *
 * Every call inherits the scope, deadline and signal of the handler's call
 * (`currentCall()`); `call` is ignored. When `Describe` or any `Exec` fails
 * `UNAVAILABLE` with details `{ leaseStatus }` (one of `pending`,
 * `unavailable`, `expired`, `missing`), the task's remaining steps do not
 * run and it answers `{ status: leaseStatus }`. Any other failure rejects:
 * a `ConnectError` as the `ContractError` `fromConnectError` reads (code and
 * details kept), anything else unchanged.
 */
export const routedScreenLease = (
  lease: Client<typeof LeaseService>,
): ScreenLease => ({
  withLease: async <T>(
    task: (sandbox: ScreenSandbox) => Promise<T>,
  ): Promise<LeaseOutcome<T>> => {
    // The first lease failure ends the run: the manager swallows some steps'
    // failures, so it is kept here, later steps fail with it without a call,
    // and the outcome is that status whatever the task answered.
    let failure:
      | { readonly status: LeaseStatus; readonly error: unknown }
      | undefined;

    const routed = async <R>(work: () => Promise<R>): Promise<R> => {
      try {
        return await work();
      } catch (error) {
        const routedFailure = routedError(error);
        const status = leaseStatusOf(routedFailure);

        if (status !== undefined) {
          failure ??= { status, error: routedFailure };
        }

        throw routedFailure;
      }
    };

    const outcomeOf = (error: unknown): LeaseOutcome<T> => {
      if (failure !== undefined) {
        return { status: failure.status };
      }

      throw error;
    };

    let id: string;

    try {
      ({ id } = await routed(() => lease.describe({ target: {} })));
    } catch (error) {
      return outcomeOf(error);
    }

    const sandbox: ScreenSandbox = {
      id,
      exec: async (input): Promise<SandboxExecResult> => {
        if (failure !== undefined) {
          throw failure.error;
        }

        const { response } = await routed(() =>
          lease.exec({
            target: { expectSandboxId: id },
            request: execRequestOf(input),
          }),
        );

        return {
          exitCode: response?.exitCode ?? null,
          stdout: response?.stdout ?? '',
          stderr: response?.stderr ?? '',
          stdoutBytes: response?.stdoutBytes ?? new Uint8Array(),
          stderrBytes: response?.stderrBytes ?? new Uint8Array(),
        };
      },
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
