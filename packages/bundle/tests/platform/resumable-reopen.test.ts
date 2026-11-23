// Resumable streams across a publish (spec `docs/designs/grpc-processes.md`,
// section 4, "Resumable streams"; section 6, "Drain"; section 10; T2.6, its
// last clause): when the provider of a resumable server stream begins to
// drain, the router ends the stream with `generation_lost`, and the caller's
// SDK opens it again on the new generation with the `resume` request built
// from the last item, so the caller's next item is generation N+1's snapshot.
// One platform runs both callers: a client part through `bundle/client` and
// the gateway, and a host part through `context.services.use` (the fixture's
// `watch-demo` mode). `demo/v1` is built at run time with its `Watch`
// resumable; the fixture's `serve-demo` mode serves it.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { file_doric_settings_v1_settings } from '../../src/contracts/gen/doric/settings/v1/settings_pb.js';
import { file_doric_tools_v1_tools } from '../../src/contracts/gen/doric/tools/v1/tools_pb.js';
import { createCatalogIndex } from '../../src/platform/catalog-index.js';
import { createClientPart } from '../../src/sdk/client/index.js';
import {
  type DemoClient,
  type DemoMessage,
  demoFile,
  serviceOf,
} from '../support/demo-contract.js';
import {
  type FixtureBundle,
  resolveHost,
  setupPlatform,
  sleep,
  within,
} from '../support/scripted-host.js';

const demo = demoFile({ id: 'demo/v1', package: 'demo.v1', resumable: true });
const DemoService = serviceOf(demo, 'DemoService');
const index = createCatalogIndex([
  file_doric_tools_v1_tools,
  file_doric_settings_v1_settings,
  demo,
]);

const bundles: Readonly<Record<string, FixtureBundle>> = {
  demo: {
    mode: 'serve-demo',
    provides: ['demo/v1@1.0.0'],
    clientRequires: ['demo/v1@^1.0.0'],
  },
  watcher: { mode: 'watch-demo', requires: ['demo/v1@^1.0.0'] },
};

/** Waits until `predicate` holds or `timeoutMs` passed; never fails. */
const settle = async (
  predicate: () => boolean,
  timeoutMs = 1_500,
): Promise<void> => {
  const deadline = performance.now() + timeoutMs;

  while (!predicate() && performance.now() < deadline) {
    await sleep(5);
  }
};

describe('a resumable stream across a publish (T2.6)', () => {
  test('is opened again on generation N+1 with the resume request, by the client SDK and by services.use', async (t) => {
    const env = await setupPlatform(t, bundles, {
      publicAddress: '127.0.0.1:0',
      index,
    });
    const port = env.platform.publicPort;

    assert.equal(typeof port, 'number', 'the platform has a public port');

    // The client part `demo` watches through the gateway.
    const clientItems: string[] = [];
    let clientFailure: unknown;
    const stop = new AbortController();
    const collecting = (async () => {
      try {
        const resume = {
          watch: (last: DemoMessage) => ({ text: `after-${last.text}` }),
        };
        const client = createClientPart({
          bundleId: 'demo',
          baseUrl: `http://127.0.0.1:${port}`,
        }).use(DemoService, { resume }) as unknown as DemoClient;

        for await (const item of client.watch(
          { text: 'c' },
          { signal: stop.signal },
        )) {
          clientItems.push(item.text);
        }
      } catch (error) {
        clientFailure = error;
      }
    })();
    const watcherItems = (): string[] =>
      env.log
        .eventsOf('watcher')
        .filter(
          (event) => event.startsWith('item:') || event.startsWith('watch-'),
        );

    try {
      await settle(
        () =>
          (clientItems.length > 0 || clientFailure !== undefined) &&
          watcherItems().length > 0,
      );

      env.digests.set('demo', 'v2');

      const published = await within(
        env.platform.publish(resolveHost(bundles)),
        'the publish',
      );

      assert.equal(published.status, 'published');
      await settle(
        () =>
          (clientItems.length > 1 || clientFailure !== undefined) &&
          watcherItems().length > 1,
      );

      await t.test(
        'the client SDK: the first item after the reopening is N+1 snapshot of resume(last)',
        () => {
          assert.equal(
            clientFailure,
            undefined,
            `the stream failed: ${clientFailure}`,
          );
          assert.deepEqual(clientItems, [
            'g1:snapshot:c',
            'g2:snapshot:after-g1:snapshot:c',
          ]);
        },
      );
      await t.test(
        "a host part's services.use: the first item after the reopening is N+1 snapshot of resume(last)",
        () => {
          assert.deepEqual(watcherItems(), [
            'item:g1:snapshot:h',
            'item:g2:snapshot:after-g1:snapshot:h',
          ]);
        },
      );
    } finally {
      stop.abort();
      await within(collecting, 'the client stream to end');
    }
  });
});
