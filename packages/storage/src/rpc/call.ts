// What the adapters of `storage/rpc` share: the `call` a served backend gets,
// the Connect options of a client call, and the `ContractError` a failed
// client call rejects with.

import {
  Code,
  type CallOptions as ConnectCallOptions,
  ConnectError,
  type HandlerContext,
} from '@connectrpc/connect';
import {
  type CallArg,
  type CallOptions,
  ContractError,
  callOf,
  deadlineOf,
  fromConnectError,
  isCall,
  isContractError,
  toContractError,
} from 'bundle/contracts';

/** The `call` a served backend gets: the handler call's signal and deadline. */
export const backendCallOf = (context: HandlerContext): CallOptions => {
  const call = callOf(context);
  const deadline = deadlineOf(call);

  return deadline > 0
    ? { signal: call.signal, deadline }
    : { signal: call.signal };
};

/**
 * The Connect options of a client call made for `call`. Throws
 * `cancelled` when its signal already aborted: no call is made then.
 */
export const connectOptionsOf = (call?: CallArg): ConnectCallOptions => {
  if (call === undefined) {
    return {};
  }

  const signal = call.signal;

  if (signal?.aborted === true) {
    throw new ContractError('cancelled', 'The call was cancelled.');
  }
  const deadline = isCall(call) ? deadlineOf(call) : (call.deadline ?? 0);

  return {
    ...(signal === undefined ? {} : { signal }),
    ...(deadline > 0
      ? { timeoutMs: Math.max(1, Math.ceil(deadline - Date.now())) }
      : {}),
  };
};

/** The Doric codes of the transport's own failures, which carry no ErrorInfo. */
const transportCodes = new Map<Code, string>([
  [Code.Canceled, 'cancelled'],
  [Code.DeadlineExceeded, 'deadline_exceeded'],
  [Code.Unavailable, 'unavailable'],
]);

/**
 * The `ContractError` a client call made for `call` that threw `error`
 * rejects with. An `internal` or `cancelled` failure of a call whose signal
 * has aborted is `cancelled`, and of a call whose deadline has passed
 * `deadline_exceeded`: the peer may end such a call first, with its own code.
 */
export const clientFailure = (
  error: unknown,
  call?: CallArg,
): ContractError => {
  const failure = failureOf(error);
  const ended =
    failure.code === 'internal' || failure.code === 'cancelled'
      ? endedCodeOf(call)
      : undefined;

  return ended === undefined || ended === failure.code
    ? failure
    : new ContractError(ended, failure.message);
};

/** The `ContractError` of `error` as the transport reported it. */
const failureOf = (error: unknown): ContractError => {
  if (isContractError(error)) {
    return error;
  }

  if (error instanceof ConnectError) {
    const failure = fromConnectError(error);
    const transport = transportCodes.get(error.code);

    return failure.code === 'internal' && transport !== undefined
      ? new ContractError(transport, failure.message)
      : failure;
  }

  return toContractError(error);
};

/**
 * `cancelled` once the signal of `call` has aborted, `deadline_exceeded` once
 * its deadline has passed, otherwise `undefined`.
 */
const endedCodeOf = (call?: CallArg): string | undefined => {
  if (call === undefined) {
    return undefined;
  }

  if (call.signal?.aborted === true) {
    return 'cancelled';
  }
  const deadline = isCall(call) ? deadlineOf(call) : (call.deadline ?? 0);

  return deadline > 0 && Date.now() >= deadline
    ? 'deadline_exceeded'
    : undefined;
};

/** Runs a client call, rejecting with the `ContractError` it failed with. */
export const calling = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    throw clientFailure(error);
  }
};
