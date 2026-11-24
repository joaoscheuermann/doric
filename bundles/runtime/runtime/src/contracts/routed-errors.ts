// Domain errors at the router edge (phase 3, slice S46a; moved here in S62b,
// A72, so `executor-serving.ts` needs no host module). Browser-safe. Not
// re-exported from `index.ts`: `runtime`'s own files import it; the host keeps
// importing it through `src/host/rpc/errors.ts`.

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
        path: path.map((part) =>
          typeof part === 'symbol' ? String(part) : part,
        ),
        message,
      })),
    },
  );
};
