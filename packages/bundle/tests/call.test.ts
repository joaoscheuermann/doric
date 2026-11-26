import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import {
  type Activate,
  type Call,
  defineMethod,
  defineService,
  type HostContext,
  ref,
} from '../src/contracts/index.js';
import type { EmbeddedBundle } from '../src/index.js';
import {
  activateEnvironment,
  catalogView,
  createHopCall,
  createPrincipal,
  DiagnosticsStore,
  manifestV1Schema,
  PLATFORM_VERSION,
  resolveEnvironment,
  ServiceDirectory,
  type ServiceRuntime,
} from '../src/runtime/index.js';
import { embedded, manifest } from './support/fixtures.js';

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

const desktopMain = { environment: 'desktopMain' } as const;

/** One desktopMain environment of `bundles`, activated in this process. */
const activate = async (bundles: readonly EmbeddedBundle[]) => {
  const resolved = resolveEnvironment(
    {
      candidates: bundles.map((bundle) => ({
        id: bundle.manifest.id,
        source: { kind: 'embedded' },
        manifest: manifestV1Schema.parse(bundle.manifest),
        ...(bundle.descriptor === undefined
          ? {}
          : { descriptor: bundle.descriptor }),
        errors: [],
      })),
      composition: {
        core: 'deskcore',
        enabled: bundles.map(({ manifest: source }) => source.id),
        providers: {},
      },
      platformVersion: PLATFORM_VERSION,
      generation: 1,
    },
    'desktopMain',
  );
  const controller = new AbortController();
  const diagnostics = new DiagnosticsStore({ generation: 1 });

  diagnostics.load(resolved);

  const runtime: ServiceRuntime = {
    directory: new ServiceDirectory(),
    catalog: catalogView(resolved),
    environment: 'desktopMain',
    generation: 1,
    generationSignal: controller.signal,
    report: (entry) => diagnostics.report(entry),
  };
  const platform = createPrincipal(runtime, {
    bundleId: 'doric',
    version: PLATFORM_VERSION,
    provides: 'any',
    requires: 'any',
  });
  const parts = new Map(
    bundles.map((bundle) => [bundle.manifest.id, bundle.host?.activate]),
  );
  const activation = await activateEnvironment({
    resolved,
    runtime,
    platform,
    diagnostics,
    loadPart: async ({ id }) => parts.get(id) as Activate | undefined,
  });

  return {
    activation,
    platform,
    /** A call of principal `doric` without a parent, as the host starts one. */
    call: (options: {
      readonly scope?: Call['scope'];
      readonly signal?: AbortSignal;
    }) =>
      createHopCall({
        caller: platform.caller,
        ...(options.scope === undefined ? {} : { useScope: options.scope }),
        arg: options.signal === undefined ? {} : { signal: options.signal },
        generationSignal: controller.signal,
      }),
  };
};

void test('call.caller is the bundle of each hop even when the parent call is forwarded', async () => {
  const { activation, platform, call } = await activate([
    embedded(manifest('deskcore')),
    embedded(
      manifest('alpha', {
        provides: ['alpha.api/v1@1.0.0'],
        requires: ['beta.api/v1@^1.0.0'],
      }),
      ({ services }: HostContext) => {
        services.provide(alpha);
      },
      { 'alpha.api/v1': desktopMain },
    ),
    embedded(
      manifest('beta', { provides: ['beta.api/v1@1.0.0'] }),
      ({ services }: HostContext) => {
        services.provide(beta);
      },
      { 'beta.api/v1': desktopMain },
    ),
  ]);

  assert.deepEqual(activation.active, ['deskcore', 'beta', 'alpha']);

  const controller = new AbortController();
  const parent = call({
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

  await activation.stop();
});
