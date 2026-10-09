import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import {
  type Call,
  defineMethod,
  defineService,
  type HostContext,
  ref,
} from '../src/contracts/index.js';
import { embedded, manifest, withRoot } from './support/fixtures.js';
import { start } from './support/host.js';
import { minimalCore } from './support/minimal-core.js';

const beta = defineService('beta.api/v1', {
  inspect: defineMethod({
    input: z.tuple([]),
    output: z.custom<Call>(),
    execute: (_input, call) => call,
  }),
});
const BetaV1 = ref<typeof beta>('beta.api/v1');

const alpha = defineService('alpha.api/v1', {
  run: defineMethod({
    input: z.tuple([]),
    output: z.custom<{ received: Call; forwarded: Call; fresh: Call }>(),
    execute: (_input, call, services) => ({
      received: call,
      forwarded: services.use(BetaV1).inspect(call),
      fresh: services.use(BetaV1).inspect({ signal: call.signal }),
    }),
  }),
});
const AlphaV1 = ref<typeof alpha>('alpha.api/v1');

const traceId = (call: Call) => call.trace.traceparent.split('-')[1];
const spanId = (call: Call) => call.trace.traceparent.split('-')[2];

void test('call.caller is the bundle of each hop even when the parent call is forwarded', async () => {
  await withRoot(async (root) => {
    const { platform } = await start({
      bundlesPath: root,
      composition: {},
      embedded: [
        minimalCore(),
        embedded(
          manifest('alpha', {
            provides: ['alpha.api/v1@1.0.0'],
            requires: ['beta.api/v1@^1.0.0'],
          }),
          ({ services }: HostContext) => {
            services.provide(alpha);
          },
        ),
        embedded(
          manifest('beta', { provides: ['beta.api/v1@1.0.0'] }),
          ({ services }: HostContext) => {
            services.provide(beta);
          },
        ),
      ],
    });
    const controller = new AbortController();
    const parent = platform.call({
      scope: { projectId: 'p', threadId: 't' },
      signal: controller.signal,
    });
    const { received, forwarded, fresh } = platform.services
      .use(AlphaV1)
      .run(parent);

    assert.equal(received.caller.bundleId, 'doric');
    assert.equal(forwarded.caller.bundleId, 'alpha');
    assert.deepEqual(forwarded.scope, { projectId: 'p', threadId: 't' });
    assert.equal(traceId(forwarded), traceId(parent));
    assert.notEqual(spanId(forwarded), spanId(received));
    assert.equal(fresh.scope, undefined);
    assert.notEqual(traceId(fresh), traceId(parent));

    controller.abort();

    assert.equal(forwarded.signal.aborted, true);

    await platform.stop();
  });
});
