// Regression for the read leak of `@connectrpc/connect` 2.3.0, which
// `patches/@connectrpc+connect+2.3.0.patch` fixes with a backport of
// connect-es #1873 (spec `docs/designs/grpc-processes.md`, RK4): the client's
// `runStreamingCall` raced every read against a promise that settles only
// when the call ends, so a long-lived server stream, such as a bundle's
// control stream, kept every message it had read until it ended. The test
// reads a stream that stays open through `createRouterTransport` and counts,
// after a full garbage collection, how many of the messages read are alive.

import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as macrotask } from 'node:timers/promises';
import { queryObjects } from 'node:v8';

import type { DescService } from '@bufbuild/protobuf';
import {
  createClient,
  createRouterTransport,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';

import {
  type DemoClient,
  type DemoMessage,
  demoFile,
  serviceOf,
} from './support/demo-contract.js';

const DemoService = serviceOf(
  demoFile({ id: 'retention/v1', package: 'retention.v1' }),
  'DemoService',
);

/** Messages read while the stream stays open. */
const reads = 200;

/**
 * No instance is ever made: `queryObjects` runs a full garbage collection
 * before it counts, and the count is not used.
 */
class FullCollection {}

const collectGarbage = async (): Promise<void> => {
  // A WeakRef keeps its target alive until the job that made it ends.
  await macrotask();
  queryObjects(FullCollection, { format: 'count' });
};

void test('a server stream that stays open keeps none of the messages it has read', async () => {
  const transport = createRouterTransport((router) => {
    router.service(DemoService, {
      watch: async function* (_request: DemoMessage, context: HandlerContext) {
        for (let index = 0; index < reads; index += 1) {
          yield { text: `${index}:${'x'.repeat(1024)}` };
        }
        // The stream stays open until the client cancels it.
        await new Promise((resolve) => {
          context.signal.addEventListener('abort', resolve, { once: true });
        });
      },
    } as unknown as ServiceImpl<DescService>);
  });
  const client = createClient(DemoService, transport) as unknown as DemoClient;
  const controller = new AbortController();
  const stream = client
    .watch({ text: '' }, { signal: controller.signal })
    [Symbol.asyncIterator]();
  const read: WeakRef<DemoMessage>[] = [];

  try {
    for (let index = 0; index < reads; index += 1) {
      const result = await stream.next();

      assert.equal(result.done, false);
      read.push(new WeakRef(result.value));
    }
    await collectGarbage();

    const alive = read.filter((ref) => ref.deref() !== undefined).length;

    // Read-ahead may hold the last few; the leak held all of them.
    assert.ok(alive < reads / 10, `${alive} of ${reads} read messages alive`);
  } finally {
    controller.abort();
    await stream.return?.().catch(() => undefined);
  }
});
