// The routed Project lease from the caller's side (phase 3, S55a): one
// `runtime.lease/v1.Describe`, every later step bound to the described sandbox
// with `expectSandboxId`, and the first lease failure as the outcome's status.
// Shared by the bundles that read a Project's sandbox over the router.

import { type Client, ConnectError } from '@connectrpc/connect';
import { fromConnectError, isContractError } from 'bundle/contracts';
import type { SandboxExecInput, SandboxExecResult } from 'sandbox';

import type {
  ExecResponse,
  LeaseService,
} from './gen/doric/runtime/lease/v1/lease_pb.js';
import type { LeaseOutcome } from './lease.js';

/** A lease state that is not `ready`: the `leaseStatus` of a lease failure. */
export type LeaseFailureStatus = Exclude<
  LeaseOutcome<unknown>['status'],
  'ready'
>;

/** The lease states `runtime.lease/v1` names in a not-ready failure. */
const LEASE_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'unavailable',
  'expired',
  'missing',
]);

/** `error` as a caller rethrows it: a `ConnectError` as `fromConnectError` reads it, anything else unchanged. */
const failureOf = (error: unknown): unknown =>
  error instanceof ConnectError ? fromConnectError(error) : error;

/**
 * The `leaseStatus` of a `runtime.lease/v1` failure: `pending`,
 * `unavailable`, `expired` or `missing` when `failure` is an `unavailable`
 * failure with that `ErrorDetails.leaseStatus` (a `ContractError`, or a
 * `ConnectError` as `fromConnectError` reads it); `undefined` for anything
 * else, including `unavailable` without the detail. Pure; never throws.
 */
export const leaseStatusOf = (
  failure: unknown,
): LeaseFailureStatus | undefined => {
  const error = failureOf(failure);

  if (!isContractError(error) || error.code !== 'unavailable') {
    return undefined;
  }

  const { details } = error;
  const status: unknown =
    typeof details === 'object' && details !== null
      ? (details as { leaseStatus?: unknown }).leaseStatus
      : undefined;

  return typeof status === 'string' && LEASE_STATUSES.has(status)
    ? (status as LeaseFailureStatus)
    : undefined;
};

/**
 * The `request` of `runtime.lease/v1.Exec` for `input`: `cmd`, `env` (empty
 * when absent), and `cwd`, `user`, `timeoutMs`, `tty` when present.
 * `signal` is never sent. Pure.
 */
export const execRequestOf = (
  input: SandboxExecInput,
): {
  readonly cmd: string[];
  readonly env: string[];
  readonly cwd?: string;
  readonly user?: string;
  readonly timeoutMs?: number;
  readonly tty?: boolean;
} => ({
  cmd: [...input.cmd],
  env: [...(input.env ?? [])],
  ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  ...(input.user === undefined ? {} : { user: input.user }),
  ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  ...(input.tty === undefined ? {} : { tty: input.tty }),
});

/**
 * `ExecResponse.response` as a `SandboxExecResult`: an absent `exitCode` is
 * `null`; absent text is `''` and absent bytes are empty. Pure.
 */
export const execResultOf = ({
  response,
}: ExecResponse): SandboxExecResult => ({
  exitCode: response?.exitCode ?? null,
  stdout: response?.stdout ?? '',
  stderr: response?.stderr ?? '',
  stdoutBytes: response?.stdoutBytes ?? new Uint8Array(),
  stderrBytes: response?.stderrBytes ?? new Uint8Array(),
});

/** The steps of one `runOnProjectLease` run, all bound to one sandbox. */
export interface ProjectLeaseSteps {
  /** The described sandbox's id. */
  readonly id: string;
  /** The described sandbox's workspace root, absolute. */
  readonly root: string;
  /** `{expectSandboxId: id}`: the target every step of the run must send. */
  readonly target: { readonly expectSandboxId: string };
  /**
   * Runs one lease call. Resolves with its answer. Rejects with the call's
   * failure as `contractErrorOf` reads it. The first failure that carries a
   * `leaseStatus` is kept: from then on every `step` rejects with it without
   * running `work`.
   */
  step<R>(work: () => Promise<R>): Promise<R>;
}

/**
 * Runs `task` on the current sandbox `lease` resolves, never acquiring one.
 *
 * Calls `lease.describe({target: {}})` once (as a `step`), then
 * `task(steps)`. Answers:
 * - `{status: 'ready', value}` when the task resolved and no step failed
 *   with a `leaseStatus`;
 * - `{status}` (no `value`) when `Describe` or any step failed `unavailable`
 *   with a `leaseStatus` (the first such status), whatever the task did with
 *   the rejection.
 *
 * Rejects with any other failure of `Describe` or of the task, as
 * `contractErrorOf` reads it: `invalid_input` (no scope, protovalidate),
 * `unavailable` without `leaseStatus`, `limit_exceeded`, the sandbox's codes.
 * Which Project is used is `lease`'s scope; the caller chooses it.
 */
export const runOnProjectLease = async <T>(
  lease: Pick<Client<typeof LeaseService>, 'describe'>,
  task: (steps: ProjectLeaseSteps) => Promise<T>,
): Promise<LeaseOutcome<T>> => {
  // The first lease failure ends the run: later steps fail with it without
  // a call, and the outcome is that status whatever the task answered.
  let failure:
    | { readonly status: LeaseFailureStatus; readonly error: unknown }
    | undefined;

  const step = async <R>(work: () => Promise<R>): Promise<R> => {
    if (failure !== undefined) throw failure.error;

    try {
      return await work();
    } catch (error) {
      const routedFailure = failureOf(error);
      const status = leaseStatusOf(routedFailure);

      if (status !== undefined) failure ??= { status, error: routedFailure };

      throw routedFailure;
    }
  };

  const outcomeOf = (error: unknown): LeaseOutcome<T> => {
    if (failure !== undefined) return { status: failure.status };

    throw failureOf(error);
  };

  let described: { readonly id: string; readonly root: string };

  try {
    described = await step(() => lease.describe({ target: {} }));
  } catch (error) {
    return outcomeOf(error);
  }

  const { id, root } = described;

  try {
    const value = await task({
      id,
      root,
      target: { expectSandboxId: id },
      step,
    });

    return failure === undefined
      ? { status: 'ready', value }
      : { status: failure.status };
  } catch (error) {
    return outcomeOf(error);
  }
};
