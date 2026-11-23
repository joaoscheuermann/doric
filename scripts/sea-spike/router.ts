/**
 * The stub router of the phase 0 spike (T0.1): a cleartext HTTP/2 gRPC server
 * that serves `doric.platform.v1.BundleHostService/Connect` with the options of
 * the spec's implementation notes, records each instance's `Hello`, answers
 * `Accepted`, and holds the stream open until it closes.
 */
import { createServer } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';

import { create } from '@bufbuild/protobuf';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import {
  BundleHostService,
  type ConnectResponse,
  ConnectResponseSchema,
  type Hello,
} from 'bundle/contracts/gen/doric/platform/v1/control_pb.js';

export interface HelloRecord {
  readonly token: string;
  readonly hello: Hello;
  /** `performance.now()` when the Hello arrived. */
  readonly at: number;
}

export interface StubRouter {
  readonly url: string;
  /** Resolves with the Hello of the instance holding `token`. */
  readonly helloOf: (token: string) => Promise<HelloRecord>;
  readonly close: () => Promise<void>;
}

const MAX_BYTES = 4_194_304;

export const startRouter = async (): Promise<StubRouter> => {
  const hellos = new Map<string, HelloRecord>();
  const waiters = new Map<string, (record: HelloRecord) => void>();
  const closing = new AbortController();

  const handler = connectNodeAdapter({
    grpc: true,
    connect: false,
    grpcWeb: false,
    readMaxBytes: MAX_BYTES,
    writeMaxBytes: MAX_BYTES,
    routes: (router) =>
      router.service(BundleHostService, {
        async *connect(requests, context): AsyncGenerator<ConnectResponse> {
          const token = (
            context.requestHeader.get('authorization') ?? ''
          ).replace(/^Bearer /, '');
          const iterator = requests[Symbol.asyncIterator]();
          const first = await iterator.next();
          if (first.done || first.value.frame.case !== 'hello') {
            yield create(ConnectResponseSchema, {
              frame: {
                case: 'rejected',
                value: {
                  reason: 'protocol_violation',
                  message: 'The first frame is not a Hello.',
                },
              },
            });
            return;
          }
          const record = {
            token,
            hello: first.value.frame.value,
            at: performance.now(),
          };
          hellos.set(token, record);
          waiters.get(token)?.(record);
          yield create(ConnectResponseSchema, {
            frame: { case: 'accepted', value: { protocolVersion: 1 } },
          });
          // Hold the stream until the bundle or the spike closes it.
          await new Promise<void>((resolve) => {
            if (closing.signal.aborted) resolve();
            closing.signal.addEventListener('abort', () => resolve(), {
              once: true,
            });
            context.signal.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
        },
      }),
  });

  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    helloOf: (token) =>
      new Promise((resolve) => {
        const record = hellos.get(token);
        if (record) resolve(record);
        else waiters.set(token, resolve);
      }),
    close: async () => {
      closing.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
