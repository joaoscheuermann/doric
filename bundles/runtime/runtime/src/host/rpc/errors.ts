// Domain errors at the router edge (phase 3, slice S46a).

import { AsyncLocalStorage } from 'node:async_hooks';

import { ConnectError } from '@connectrpc/connect';
import {
  ContractError,
  fromConnectError,
  isContractError,
} from 'bundle/contracts';
import type { z } from 'zod';

/** `'Doric is shutting down.'` (`CreateProject` and every mutation after `Dispose`): FAILED_PRECONDITION. */
export const SHUTTING_DOWN = 'shutting_down';
/** `'Thread control is no longer active.'` (`runtime.threads/v1` controls): FAILED_PRECONDITION. */
export const THREAD_CONTROL_INACTIVE = 'thread_control_inactive';

/**
 * The error a routed handler throws for `error`:
 * - a `ContractError`, unchanged;
 * - a `ConnectError` from a routed call, as `fromConnectError` reads it
 *   (code, message and details kept);
 * - a plain `Error` whose message is exactly one of the two above, as
 *   `ContractError(<code>, <same message>)`;
 * - anything else unchanged (the SDK answers it as `internal`).
 * Never throws.
 */
export const routedError = (error: unknown): unknown => {
  if (isContractError(error)) return error;
  if (error instanceof ConnectError) return fromConnectError(error);
  if (error instanceof Error) {
    const code = plainErrorCodes.get(error.message);
    if (code !== undefined) return new ContractError(code, error.message);
  }
  return error;
};

/** The domain's plain `Error` messages and the codes they travel with. */
const plainErrorCodes: ReadonlyMap<string, string> = new Map([
  ['Doric is shutting down.', SHUTTING_DOWN],
  ['Thread control is no longer active.', THREAD_CONTROL_INACTIVE],
]);

/** Runs `work`, rethrowing its failure as {@link routedError} does. */
export const routed = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw routedError(error);
  }
};

/**
 * `value` parsed by today's input `schema` of `method`; `invalid_input` with
 * the zod issues otherwise, as the kernel's dispatch reports them.
 */
export const parseInput = <S extends z.ZodType>(
  method: string,
  schema: S,
  value: unknown,
): z.output<S> => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ContractError(
    'invalid_input',
    `Invalid input for ${method}: ${parsed.error.issues
      .map(
        ({ path, message }) =>
          `${path.length > 0 ? `${path.map(String).join('.')}: ` : ''}${message}`,
      )
      .join('; ')}`,
    {
      method,
      issues: parsed.error.issues.map(({ code, path, message }) => ({
        code,
        path: path.map((part) => (typeof part === 'symbol' ? String(part) : part)),
        message,
      })),
    },
  );
};

/** The asynchronous context at load: outside every handler's call. */
const outside = AsyncLocalStorage.snapshot();

/**
 * Runs `work` outside the call whose handler is running, as the kernel ran the
 * domain: the work the domain starts and leaves running (a Project's
 * acquisition, a resumed prompt) does not inherit the request's signal,
 * deadline or scope, so it outlives the call that started it.
 */
export const detached = <T>(work: () => T): T => outside(work);
