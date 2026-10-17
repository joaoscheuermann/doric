import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import {
  type Activate,
  type Call,
  ContractError,
  defineMethod,
  defineService,
  generationOf,
  type HostContext,
  ref,
  ToolsV1,
} from '../src/contracts/index.js';
import { catalogSnapshot, type EmbeddedBundle } from '../src/index.js';
import { providePlatformServices } from '../src/loader/platform.js';
import {
  activateEnvironment,
  type CatalogCandidate,
  catalogView,
  createPrincipal,
  DiagnosticsStore,
  manifestV1Schema,
  type ResolvedEnvironment,
  resolveEnvironment,
  ServiceDirectory,
  type ServiceRuntime,
} from '../src/runtime/index.js';
import { captureSink, embedded, manifest } from './support/fixtures.js';
import { fakeTool, observeActivations } from './support/host.js';
import { minimalCore } from './support/minimal-core.js';

// Operation generation ---------------------------------------------------------

const inner = defineService('inner.api/v1', {
  inspect: defineMethod({
    input: z.tuple([]),
    output: z.number(),
    execute: (_input, call) => generationOf(call),
  }),
});
const InnerV1 = ref<typeof inner>('inner.api/v1');

const outer = defineService('outer.api/v1', {
  run: defineMethod({
    input: z.tuple([]),
    output: z.object({
      received: z.number(),
      forwarded: z.number(),
      fresh: z.number(),
    }),
    execute: (_input, call, services) => ({
      received: generationOf(call),
      forwarded: services.use(InnerV1).inspect(call),
      fresh: services.use(InnerV1).inspect({ signal: call.signal }),
    }),
  }),
});
const OuterV1 = ref<typeof outer>('outer.api/v1');

const runtimeOver = (
  directory: ServiceDirectory,
  operationGeneration?: number,
): ServiceRuntime => ({
  directory,
  catalog: { cardinality: () => undefined, activeProvider: () => undefined },
  environment: 'host',
  generation: 1,
  generationSignal: new AbortController().signal,
  report: () => undefined,
  ...(operationGeneration === undefined ? {} : { operationGeneration }),
});

const principalIn = (runtime: ServiceRuntime, bundleId: string) =>
  createPrincipal(runtime, {
    bundleId,
    version: '1.0.0',
    provides: 'any',
    requires: 'any',
  });

void test('a call chain stays pinned to the generation of the runtime that started it', () => {
  const directory = new ServiceDirectory();
  const kernel = runtimeOver(directory, 0);

  principalIn(kernel, 'inner').services.provide(inner);
  principalIn(kernel, 'outer').services.provide(outer);

  const fromView = principalIn(runtimeOver(directory, 5), 'consumer');
  const fromKernel = principalIn(kernel, 'consumer');

  // The provider runs in the kernel runtime, but a forwarded parent call keeps
  // the caller's generation; a call it starts itself uses its own runtime's.
  assert.deepEqual(fromView.services.use(OuterV1).run(), {
    received: 5,
    forwarded: 5,
    fresh: 0,
  });
  assert.deepEqual(fromKernel.services.use(OuterV1).run(), {
    received: 0,
    forwarded: 0,
    fresh: 0,
  });
});

void test('a runtime without an operation generation pins its calls to 0', () => {
  const directory = new ServiceDirectory();
  const runtime = runtimeOver(directory);

  principalIn(runtime, 'inner').services.provide(inner);

  assert.equal(
    principalIn(runtime, 'consumer').services.use(InnerV1).inspect(),
    0,
  );
});

// Activation options -------------------------------------------------------------

const candidateOf = (bundle: EmbeddedBundle): CatalogCandidate => ({
  id: bundle.manifest.id,
  source: { kind: 'embedded' },
  manifest: manifestV1Schema.parse(bundle.manifest),
  ...(bundle.descriptor === undefined ? {} : { descriptor: bundle.descriptor }),
  errors: [],
});

const resolve = (bundles: readonly EmbeddedBundle[]): ResolvedEnvironment =>
  resolveEnvironment(
    {
      candidates: bundles.map(candidateOf),
      composition: {
        core: 'mincore',
        enabled: bundles.map(({ manifest: source }) => source.id),
        providers: {},
      },
      platformVersion: '1.0.0',
      generation: 1,
    },
    'host',
  );

/** The same resolved catalog restricted to some entries, as one process sees it. */
const only = (
  resolved: ResolvedEnvironment,
  ids: readonly string[],
): ResolvedEnvironment => ({
  ...resolved,
  entries: resolved.entries.filter(({ id }) => ids.includes(id)),
  order: resolved.order.filter((id) => ids.includes(id)),
});

interface Harness {
  readonly resolved: ResolvedEnvironment;
  readonly runtime: ServiceRuntime;
  readonly diagnostics: DiagnosticsStore;
  readonly platform: ReturnType<typeof principalIn>;
  readonly loadPart: (entry: { id: string }) => Promise<Activate | undefined>;
}

const harness = (bundles: readonly EmbeddedBundle[]): Harness => {
  const resolved = resolve(bundles);
  const diagnostics = new DiagnosticsStore({ generation: 1 });

  diagnostics.load(resolved);

  const runtime: ServiceRuntime = {
    ...runtimeOver(new ServiceDirectory(), 0),
    catalog: catalogView(resolved),
    report: (entry) => diagnostics.report(entry),
  };
  const parts = new Map(
    bundles.map((bundle) => [bundle.manifest.id, bundle.host?.activate]),
  );

  const platform = principalIn(runtime, 'doric');

  providePlatformServices(platform, {
    snapshot: () => catalogSnapshot(resolved, diagnostics),
    diagnostics,
    sink: captureSink(),
  });

  return {
    resolved,
    runtime,
    diagnostics,
    platform,
    loadPart: async ({ id }) => parts.get(id) as Activate | undefined,
  };
};

const usesTools = ['tools/v1@^1.0.0'];
const usesHooks = ['hooks/v1@^1.0.0'];

const toolOwner = (id: string, tool: string) =>
  embedded(
    manifest(id, { requires: usesTools }),
    ({ services }: HostContext) => {
      services
        .use(ToolsV1)
        .register(fakeTool(tool), { alwaysAvailable: false });
    },
  );

void test('a settle rejection with a registration refusal quarantines like the same refusal in-process', async () => {
  const bundles = [
    minimalCore(),
    toolOwner('first', 'read'),
    toolOwner('second', 'read'),
  ];

  // In-process: the second bundle's register throws duplicate_tool.
  const inProcess = harness(bundles);

  await activateEnvironment({ ...inProcess, resolved: inProcess.resolved });

  const expected = inProcess.diagnostics.reasons('second');

  assert.equal(expected[0]?.code, 'registration_failed');

  // Optimistic: register succeeds locally (a distinct name), and the refusal
  // arrives through settle with the same ContractError.
  const refusal = new ContractError(
    'duplicate_tool',
    expected[0]?.message ?? '',
  );
  const optimistic = harness([
    minimalCore(),
    toolOwner('first', 'read'),
    toolOwner('second', 'other'),
  ]);
  const result = await activateEnvironment({
    ...optimistic,
    settle: async (entry) => {
      if (entry.id === 'second') {
        throw refusal;
      }
    },
  });

  assert.deepEqual(optimistic.diagnostics.reasons('second'), expected);
  assert.equal(optimistic.diagnostics.state('second'), 'quarantined');
  assert.deepEqual(result.active, ['mincore', 'first']);
  // The partial registration of the quarantined bundle was rolled back.
  assert.deepEqual(
    optimistic.platform.services
      .use(ToolsV1)
      .list()
      .map(({ tool }) => tool.name),
    ['read'],
  );
});

void test('a settle rejection that is not a registration refusal is activate_failed', async () => {
  const setup = harness([minimalCore(), toolOwner('first', 'read')]);

  await activateEnvironment({
    ...setup,
    settle: async (entry) => {
      if (entry.id === 'first') {
        throw new Error('link closed');
      }
    },
  });

  assert.deepEqual(setup.diagnostics.reasons('first'), [
    { code: 'activate_failed', message: 'link closed' },
  ]);
});

void test('settle runs again after afterActivate, and its refusal there is registration_failed', async () => {
  const setup = harness([minimalCore(), toolOwner('first', 'read')]);
  const settled: string[] = [];

  await activateEnvironment({
    ...setup,
    afterActivate: async (entry) => {
      settled.push(`after:${entry.id}`);
    },
    settle: async (entry) => {
      settled.push(`settle:${entry.id}`);

      if (entry.id === 'first' && settled.includes('after:first')) {
        throw new Error('skill refused');
      }
    },
  });

  assert.deepEqual(settled, [
    'settle:mincore',
    'after:mincore',
    'settle:mincore',
    'settle:first',
    'after:first',
    'settle:first',
  ]);
  assert.deepEqual(setup.diagnostics.reasons('first'), [
    { code: 'registration_failed', message: 'skill refused' },
  ]);
});

void test('preActive bundles satisfy dependencies of bundles activated in another loop', async () => {
  const bundles = [minimalCore(), toolOwner('first', 'read')];
  const without = harness(bundles);

  await activateEnvironment({
    ...without,
    resolved: only(without.resolved, ['first']),
  });

  assert.equal(
    without.diagnostics.reasons('first')[0]?.code,
    'dependency_quarantined',
  );

  const withPreActive = harness(bundles);

  // The core is activated by a first loop over the same directory.
  await activateEnvironment({
    ...withPreActive,
    resolved: only(withPreActive.resolved, ['mincore']),
  });

  const result = await activateEnvironment({
    ...withPreActive,
    resolved: only(withPreActive.resolved, ['first']),
    preActive: ['mincore'],
  });

  assert.deepEqual(result.active, ['first']);
  assert.equal(withPreActive.diagnostics.state('first'), 'active');
});

void test('hooksProvider remote observes every bundle of a loop that has no hooks/v1 provider', async () => {
  const run = async (hooksProvider: 'local' | 'remote' | undefined) => {
    const seen: string[] = [];
    const setup = harness([
      minimalCore(),
      embedded(
        manifest('observer', { requires: usesHooks }),
        observeActivations(seen),
      ),
      embedded(manifest('zlater', { requires: usesHooks }), () => undefined),
    ]);

    // Kernel loop: the core activates, AppHooksV1 is defined.
    await activateEnvironment({
      ...setup,
      resolved: only(setup.resolved, ['mincore']),
    });

    // Generation loop: hooks/v1 lives outside it.
    const generation = await activateEnvironment({
      ...setup,
      resolved: only(setup.resolved, ['observer', 'zlater']),
      preActive: ['mincore'],
      ...(hooksProvider === undefined ? {} : { hooksProvider }),
    });

    return { seen, generation };
  };

  const remote = await run('remote');

  assert.deepEqual(remote.seen, ['observer', 'zlater']);
  assert.notEqual(remote.generation.appHooks(), undefined);

  const local = await run(undefined);

  assert.deepEqual(local.seen, []);
  assert.equal(local.generation.appHooks(), undefined);
});

void test('generationOf reads 0 from a call that carries no generation', () => {
  assert.equal(generationOf({} as Call), 0);
});
