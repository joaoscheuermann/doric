// Pieces of the router harness (`./router.ts`) of `openui`'s host part
// (phase 3, S56): the scopes and sources the tests use, reading a failed
// client call's `ContractError`, and waiting on real timers.

import type { MessageInitShape } from '@bufbuild/protobuf';
import { ConnectError } from '@connectrpc/connect';
import {
  type Caller,
  type CallScope,
  type ContractError,
  fromConnectError,
} from 'bundle/contracts';
import type { InputSourceSchema } from 'runtime/contracts/gen/doric/runtime/v2/runtime_pb.js';

export const projectId = 'project-1';
export const otherProjectId = 'project-2';
export const threadId = 'thread-1';
/** The scope a window's call of `openui`'s services carries. */
export const windowScope: CallScope = { projectId, threadId };

/** `core`, as the router stamps it on its calls to the handler service. */
export const core: Caller = {
  bundleId: 'core',
  version: '1.0.0',
  generation: 1,
};

export type InputSourceInit = MessageInitShape<typeof InputSourceSchema>;

/** A prompt the reader started. */
export const USER: InputSourceInit = { kind: { case: 'user', value: {} } };
/** A prompt this bundle's validation instruct queued. */
export const VALIDATION: InputSourceInit = {
  kind: { case: 'bundle', value: { bundleId: 'openui', reason: 'validation' } },
};

/** The `ContractError` a failed client call carries. */
export const contractErrorFrom = (error: unknown): ContractError =>
  fromConnectError(ConnectError.from(error));

/** The `ContractError` of `call`, which must fail. */
export const failureOf = async (
  call: () => Promise<unknown>,
): Promise<ContractError> => {
  try {
    await call();
  } catch (error) {
    return contractErrorFrom(error);
  }
  throw new Error('The call did not fail.');
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `ready()` holds, failing with `what` after `ms`. */
export const until = async (
  ready: () => boolean,
  what: string,
  ms = 2000,
): Promise<void> => {
  const end = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(5);
  }
};
