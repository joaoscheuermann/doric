// What the adapters of `storage/rpc` share: the `call` a served backend gets,
// the Connect options of a client call, and the `ContractError` a failed
// client call rejects with.

import {
  type CallOptions as ConnectCallOptions,
  Code,
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

/** The `ContractError` a client call that threw `error` rejects with. */
export const clientFailure = (error: unknown): ContractError => {
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

/** Runs a client call, rejecting with the `ContractError` it failed with. */
export const calling = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    throw clientFailure(error);
  }
};
