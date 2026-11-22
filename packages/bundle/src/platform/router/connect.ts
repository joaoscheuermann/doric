// The token check of every RPC the router listener takes, and the
// `BundleHostService/Connect` entry that opens a control stream (spec
// `docs/designs/grpc-processes.md`, section 2, "The router listener and the
// instance token").

import type { HandlerContext } from '@connectrpc/connect';

import { ContractError, toContractError } from '../../contracts/error.js';
import type {
  ConnectRequest,
  ConnectResponse,
} from '../../contracts/gen/doric/platform/v1/control_pb.js';
import { toConnectError } from '../../contracts/status.js';
import {
  type InstanceRecord,
  type InstanceTable,
  instanceKey,
  revokedStates,
} from './instances.js';
import { ControlStream, type StreamEnv } from './stream.js';

/**
 * The instance an RPC's `authorization` header names; throws the
 * ContractError of the first check that fails (see {@link Router}).
 */
export const authenticate = (
  instances: InstanceTable,
  authorization: string | null | undefined,
  isConnect: boolean,
): InstanceRecord => {
  const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
  const record = token === undefined ? undefined : instances.byToken(token);

  if (record === undefined) {
    throw new ContractError(
      'invalid_instance_token',
      'The instance token is missing or unknown.',
    );
  }

  if (revokedStates.has(record.state)) {
    throw new ContractError(
      'instance_revoked',
      `The token of ${instanceKey(record)} is revoked.`,
    );
  }

  if (!isConnect && record.state === 'spawned') {
    throw new ContractError(
      'not_connected',
      `The instance ${instanceKey(record)} has no accepted control stream.`,
    );
  }

  return record;
};

/** The `BundleHostService/Connect` implementation: authenticate, then serve. */
export async function* serveControl(
  env: StreamEnv,
  requests: AsyncIterable<ConnectRequest>,
  context: HandlerContext,
): AsyncGenerator<ConnectResponse> {
  let record: InstanceRecord;

  try {
    record = authenticate(
      env.instances,
      context.requestHeader.get('authorization'),
      true,
    );
  } catch (error) {
    throw toConnectError(toContractError(error));
  }

  const key = instanceKey(record);

  if (env.streams.has(key)) {
    throw toConnectError(
      new ContractError(
        'control_stream_open',
        `The instance ${key} already has an open control stream.`,
      ),
    );
  }

  const stream = new ControlStream(env, key, record);

  env.streams.set(key, stream);
  context.signal.addEventListener('abort', () =>
    stream.end('reset', 'The control stream was reset.'),
  );
  void stream.read(requests);

  try {
    yield* stream.responses();
  } finally {
    stream.end('reset', 'The control stream ended at the transport.');
  }
}
