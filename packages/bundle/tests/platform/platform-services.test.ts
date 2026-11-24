// The platform contracts the host serves in process from phase 3 (spec
// `docs/designs/grpc-processes.md`, section 1, "The host process", A65):
// `doric.catalog/v1`, `doric.diagnostics/v1` and `doric.bundle/v1`.
//
// The first part calls them through a real router listener, whose routes come
// from a real host resolution (`tests/support/call-routes.ts`), from bundles
// started in this process with `startBundle` and raw gRPC clients carrying an
// instance's token; no fixture process is spawned. The second part boots a
// platform of fixture processes (`tests/support/scripted-host.ts`, at most
// four alive at once, A67) whose fixtures call the services and serve
// `storage.backend/v1`'s `Identity`; every platform is shut down in `after`.

import assert from 'node:assert/strict';
import test, { describe, type TestContext } from 'node:test';

import {
  create,
  createFileRegistry,
  type DescFile,
  type DescService,
  fromBinary,
  fromJson,
  toJson,
} from '@bufbuild/protobuf';
import {
  FieldDescriptorProto_Label,
  FieldDescriptorProto_Type,
  type FileDescriptorProto,
  FileDescriptorSetSchema,
  ValueSchema,
} from '@bufbuild/protobuf/wkt';
import {
  type Client,
  Code,
  ConnectError,
  createClient,
  type Interceptor,
} from '@connectrpc/connect';
import {
  createGrpcTransport,
  Http2SessionManager,
} from '@connectrpc/connect-node';

import { ContractError } from '../../src/contracts/error.js';
import { file_doric_events_v1_events } from '../../src/contracts/gen/doric/events/v1/events_pb.js';
import { file_doric_models_provider_v1_provider } from '../../src/contracts/gen/doric/models/provider/v1/provider_pb.js';
import {
  BundleService,
  file_doric_platform_bundle_v1_bundle,
} from '../../src/contracts/gen/doric/platform/bundle/v1/bundle_pb.js';
import {
  CatalogService,
  type CatalogSnapshot,
} from '../../src/contracts/gen/doric/platform/catalog/v1/catalog_pb.js';
import {
  DiagnosticsService,
  file_doric_platform_diagnostics_v1_diagnostics,
} from '../../src/contracts/gen/doric/platform/diagnostics/v1/diagnostics_pb.js';
import { file_doric_platform_generation_v1_generation } from '../../src/contracts/gen/doric/platform/generation/v1/generation_pb.js';
import { file_doric_platform_log_v1_log } from '../../src/contracts/gen/doric/platform/log/v1/log_pb.js';
import {
  file_doric_platform_startup_v1_startup,
  StartupService,
} from '../../src/contracts/gen/doric/platform/startup/v1/startup_pb.js';
import { file_doric_settings_v1_settings } from '../../src/contracts/gen/doric/settings/v1/settings_pb.js';
import { file_doric_storage_backend_v1_backend } from '../../src/contracts/gen/doric/storage/backend/v1/backend_pb.js';
import { file_doric_tools_v1_tools } from '../../src/contracts/gen/doric/tools/v1/tools_pb.js';
import { fromConnectError } from '../../src/contracts/status.js';
import {
  type CatalogIndex,
  createCatalogIndex,
} from '../../src/platform/catalog-index.js';
import {
  InstanceTable,
  instanceKey,
} from '../../src/platform/router/instances.js';
import { startRouter } from '../../src/platform/router/listener.js';
import {
  createBundleService,
  createCatalogService,
  createDiagnosticsService,
  createStartupService,
  type PlatformServiceImpl,
} from '../../src/platform/router/platform-services.js';
import { callRoutesOf } from '../../src/platform/router/route.js';
import {
  type Timings,
  timings,
} from '../../src/platform/supervisor/timings.js';
import {
  DiagnosticsStore,
  type ResolvedEnvironment,
} from '../../src/runtime/index.js';
import { startBundle } from '../../src/sdk/host/index.js';
import { resolveCallHost, resolveReplayHost } from '../support/call-routes.js';
import {
  bootPlatform,
  type FixtureBundle,
  fixtureIndex,
  isAlive,
  resolveHost,
  setupPlatform,
  until,
  within,
} from '../support/scripted-host.js';

// ---------------------------------------------------------------------------
// Helpers of the router part

const routerTimings: Timings = {
  ...timings,
  helloTimeoutMs: 5_000,
  activationTimeoutMs: 5_000,
  healthIntervalMs: 10_000,
  healthTimeoutMs: 10_000,
  stallThresholdMs: 10_000,
  stopTimeoutMs: 2_000,
  activeWaitMs: 5_000,
};

const routerIndex = createCatalogIndex([
  file_doric_settings_v1_settings,
  file_doric_models_provider_v1_provider,
  file_doric_tools_v1_tools,
  file_doric_events_v1_events,
  // Brings `doric.catalog/v1`, which it imports (through `bundle/contracts`,
  // so the copy of `src` would be a second file of the same name).
  file_doric_platform_diagnostics_v1_diagnostics,
  file_doric_platform_bundle_v1_bundle,
]);

/** The `ConnectError` `promise` rejects with; fails the test when it resolves. */
const failureOf = async (
  promise: Promise<unknown>,
  what = 'the call',
): Promise<ConnectError> => {
  try {
    await within(promise, what, 5_000);
  } catch (error) {
    assert.ok(
      error instanceof ConnectError,
      `expected a ConnectError: ${error}`,
    );

    return error;
  }

  return assert.fail(`${what} succeeded`);
};

interface RouterEnv {
  /** Starts `bundleId` in this process as `<generation>/1` and activates it; answers its token. */
  start(bundleId: string, generation?: number): Promise<string>;
  /** A raw gRPC client of `service` sending `token` and `headers`. */
  raw<S extends DescService>(
    service: S,
    token: string,
    headers?: Record<string, string>,
  ): Client<S>;
}

/** A router with the routes of `resolveCallHost()` and `services`; closed in `after`. */
const setupRouter = async (
  t: TestContext,
  services: readonly PlatformServiceImpl[],
  index: CatalogIndex = routerIndex,
): Promise<RouterEnv> => {
  const table = new InstanceTable();
  const router = await startRouter({
    index,
    routes: callRoutesOf(resolveCallHost()),
    platformServices: services,
    instances: table,
    timings: routerTimings,
    diagnostics: {
      health: () => {},
      hostStalled: () => {},
      registrationReplay: () => {},
    },
    onInvalid: () => {},
    onLost: () => {},
  });
  const baseUrl = `http://127.0.0.1:${router.port}`;
  const sessions: Http2SessionManager[] = [];

  t.after(async () => {
    await router.close();

    for (const session of sessions) {
      session.abort();
    }
  });

  return {
    start: async (bundleId, generation = 1) => {
      const instance = { bundleId, generation, incarnation: 1 };
      const { token } = table.issue({ ...instance, version: '1.0.0' });

      await startBundle<readonly DescService[]>(
        { services: [], activate: () => {} },
        {
          env: {
            DORIC_ROUTER_URL: baseUrl,
            DORIC_INSTANCE_TOKEN: token,
            DORIC_BUNDLE_ID: bundleId,
            DORIC_GENERATION: String(generation),
            DORIC_INCARNATION: '1',
          },
          exit: () => {},
        },
      );

      const status = await router.sendActivate(instanceKey(instance));

      assert.equal(status.code, 0, `activating ${bundleId}: ${status.message}`);

      return token;
    },
    raw: (service, token, headers = {}) => {
      const session = new Http2SessionManager(baseUrl);
      const stamp: Interceptor = (next) => (request) => {
        request.header.set('authorization', `Bearer ${token}`);

        for (const [name, value] of Object.entries(headers)) {
          request.header.set(name, value);
        }

        return next(request);
      };

      sessions.push(session);

      return createClient(
        service,
        createGrpcTransport({
          baseUrl,
          sessionManager: session,
          interceptors: [stamp],
        }),
      );
    },
  };
};

/** The diagnostics of a resolution, as the platform loads them at boot. */
const loaded = (resolved: ResolvedEnvironment): DiagnosticsStore => {
  const store = new DiagnosticsStore({ generation: resolved.generation });

  store.load(resolved);

  return store;
};

/** `doric.catalog/v1.Get` from the bundle `stranger`, which declares nothing. */
const catalogGet = async (
  t: TestContext,
  options: Omit<Parameters<typeof createCatalogService>[0], 'index'>,
): Promise<{ readonly get: () => Promise<CatalogSnapshot> }> => {
  const env = await setupRouter(t, [
    createCatalogService({ ...options, index: () => routerIndex }),
  ]);
  const token = await env.start('stranger');
  const client = env.raw(CatalogService, token);

  return {
    get: async () => {
      const { catalogSnapshot } = await within(client.get({}), 'catalog Get');

      assert.ok(catalogSnapshot !== undefined, 'Get answered no snapshot');

      return catalogSnapshot;
    },
  };
};

const bundleOf = (snapshot: CatalogSnapshot, id: string) => {
  const bundle = snapshot.bundles.find((entry) => entry.id === id);

  assert.ok(bundle !== undefined, `the snapshot has no bundle ${id}`);

  return bundle;
};

const providersOf = (snapshot: CatalogSnapshot, contract: string): string[] =>
  (
    snapshot.contracts.find((entry) => entry.id === contract)?.providers ?? []
  ).map(({ bundleId }) => bundleId);

const codesIn = (reasons: readonly { readonly code: string }[]): string[] =>
  reasons.map(({ code }) => code);

const identity = {
  hostId: '0b7e3c1a-5d2f-4e8a-9c6b-7a1d2e3f4b5c',
  storageGeneration: 4,
};

// ---------------------------------------------------------------------------
// doric.catalog/v1 (router)

describe('doric.catalog/v1 Get', () => {
  test("answers the resolution's generation, composition, order, bundles and contracts, the diagnostics' states, and no storage while there is none", async (t) => {
    const resolved = resolveCallHost();
    const diagnostics = loaded(resolved);

    diagnostics.setState('settings', 'active');
    diagnostics.setState('stranger', 'active');

    const catalog = await catalogGet(t, {
      resolved: () => resolved,
      diagnostics,
      storage: () => undefined,
    });
    const snapshot = await catalog.get();

    assert.equal(snapshot.generation, resolved.generation);
    assert.equal(snapshot.composition?.core, resolved.composition.core);
    assert.deepEqual(snapshot.composition?.enabled, [
      ...resolved.composition.enabled,
    ]);
    assert.deepEqual(
      { ...snapshot.composition?.providers },
      { ...resolved.composition.providers },
    );
    assert.deepEqual(snapshot.order, [...resolved.order]);
    assert.deepEqual(
      snapshot.bundles.map(({ id, version }) => ({ id, version })),
      resolved.entries.map(({ id, version }) => ({ id, version })),
    );
    assert.equal(bundleOf(snapshot, 'settings').state, 'active');
    assert.equal(bundleOf(snapshot, 'alpha').state, 'inactive');
    assert.equal(bundleOf(snapshot, 'broken').state, 'quarantined');
    assert.deepEqual(
      codesIn(bundleOf(snapshot, 'broken').reasons),
      codesIn(diagnostics.reasons('broken')),
    );
    assert.deepEqual(
      snapshot.contracts.map((contract) => ({
        id: contract.id,
        environment: contract.environment,
        cardinality: contract.cardinality,
        providers: contract.providers.map((provider) => ({
          bundleId: provider.bundleId,
          version: provider.version,
          bundleVersion: provider.bundleVersion,
        })),
      })),
      resolved.contracts.map((contract) => ({
        id: contract.id,
        environment: contract.environment,
        cardinality: contract.cardinality,
        providers: contract.providers.map((provider) => ({ ...provider })),
      })),
    );
    assert.equal(snapshot.storage, undefined);
  });

  test('answers the storage identity the getter returns', async (t) => {
    const resolved = resolveCallHost();
    const catalog = await catalogGet(t, {
      resolved: () => resolved,
      diagnostics: loaded(resolved),
      storage: () => identity,
    });
    const snapshot = await catalog.get();

    assert.deepEqual(
      {
        hostId: snapshot.storage?.hostId,
        storageGeneration: snapshot.storage?.storageGeneration,
      },
      identity,
    );
  });

  test("shows a bundle quarantined after a call quarantined with the reason, and leaves it out of its contracts' providers", async (t) => {
    const resolved = resolveCallHost();
    const diagnostics = loaded(resolved);
    const catalog = await catalogGet(t, {
      resolved: () => resolved,
      diagnostics,
      storage: () => undefined,
    });
    const before = await catalog.get();

    assert.deepEqual(providersOf(before, 'models.provider/v1'), [
      'alpha',
      'beta',
    ]);

    diagnostics.quarantine('alpha', {
      code: 'process_failed',
      message: 'fixture alpha failed',
    });

    const after = await catalog.get();
    const alpha = bundleOf(after, 'alpha');

    assert.equal(alpha.state, 'quarantined');
    assert.ok(
      alpha.reasons.some(
        ({ code, message }) =>
          code === 'process_failed' && message === 'fixture alpha failed',
      ),
      `alpha's reasons: ${JSON.stringify(codesIn(alpha.reasons))}`,
    );
    assert.deepEqual(providersOf(after, 'models.provider/v1'), ['beta']);
  });

  test('answers the resolution the getter returns at each call', async (t) => {
    const first = resolveCallHost();
    const next: ResolvedEnvironment = { ...resolveReplayHost(), generation: 2 };
    let current = first;
    const catalog = await catalogGet(t, {
      resolved: () => current,
      diagnostics: loaded(first),
      storage: () => undefined,
    });

    assert.equal((await catalog.get()).generation, first.generation);

    current = next;

    const snapshot = await catalog.get();

    assert.equal(snapshot.generation, 2);
    assert.deepEqual(
      snapshot.bundles.map(({ id }) => id),
      next.entries.map(({ id }) => id),
    );
    assert.deepEqual(snapshot.order, [...next.order]);
  });

  test("matches states by bundle id; a bundle the diagnostics do not hold is inactive with the resolution's reasons", async (t) => {
    const resolved = resolveCallHost();
    // The diagnostics of another resolution: `core` and `app` (at other
    // positions), not `settings` nor `broken`.
    const diagnostics = loaded(resolveReplayHost());

    diagnostics.setState('core', 'active');
    diagnostics.setState('app', 'active');

    const catalog = await catalogGet(t, {
      resolved: () => resolved,
      diagnostics,
      storage: () => undefined,
    });
    const snapshot = await catalog.get();
    const broken = resolved.entries.find(({ id }) => id === 'broken');

    assert.equal(bundleOf(snapshot, 'app').state, 'active');
    assert.equal(bundleOf(snapshot, 'core').state, 'active');
    assert.equal(bundleOf(snapshot, 'settings').state, 'inactive');
    assert.deepEqual(bundleOf(snapshot, 'settings').reasons, []);
    assert.equal(bundleOf(snapshot, 'broken').state, 'inactive');
    assert.deepEqual(
      codesIn(bundleOf(snapshot, 'broken').reasons),
      codesIn(broken?.reasons ?? []),
    );
  });
});

describe('doric.catalog/v1 methods not served yet', () => {
  test('Watch and Disable end with UNIMPLEMENTED, reason unknown_contract', async (t) => {
    const resolved = resolveCallHost();
    const env = await setupRouter(t, [
      createCatalogService({
        resolved: () => resolved,
        diagnostics: loaded(resolved),
        storage: () => undefined,
        index: () => routerIndex,
      }),
    ]);
    const token = await env.start('stranger');
    const client = env.raw(CatalogService, token);

    const watch = await failureOf(
      (async () => {
        for await (const _ of client.watch({})) {
          // Not served: no message is expected.
        }
      })(),
      'Watch',
    );
    const disable = await failureOf(
      client.disable({ bundleId: 'alpha' }),
      'Disable',
    );

    for (const error of [watch, disable]) {
      assert.equal(error.code, Code.Unimplemented, error.message);
      assert.equal(fromConnectError(error).code, 'unknown_contract');
    }
  });
});

// ---------------------------------------------------------------------------
// doric.catalog/v1 Descriptors (router)

/** The proto's bound on `DescriptorsResponse.chunk`: 1 MiB. */
const maxChunkBytes = 1_048_576;

/** The chunks of one `Descriptors` read and the set they concatenate to. */
interface DescriptorsRead {
  readonly chunks: readonly Uint8Array[];
  readonly bytes: Uint8Array;
  readonly files: readonly FileDescriptorProto[];
}

/** A `Descriptors` client from `stranger` over a catalog serving `index`. */
const descriptorsOf = async (
  t: TestContext,
  index: CatalogIndex,
): Promise<{ readonly read: () => Promise<DescriptorsRead> }> => {
  const resolved = resolveCallHost();
  const env = await setupRouter(t, [
    createCatalogService({
      resolved: () => resolved,
      diagnostics: loaded(resolved),
      storage: () => undefined,
      index: () => index,
    }),
  ]);
  const token = await env.start('stranger');
  const client = env.raw(CatalogService, token);

  return {
    read: async () => {
      const chunks: Uint8Array[] = [];

      await within(
        (async () => {
          for await (const { chunk } of client.descriptors({})) {
            chunks.push(chunk);
          }
        })(),
        'Descriptors',
      );

      const bytes = Buffer.concat(chunks);

      return {
        chunks,
        bytes,
        files: fromBinary(FileDescriptorSetSchema, bytes).file,
      };
    },
  };
};

/** Asserts that every chunk holds 1 byte to 1 MiB. */
const assertChunkSizes = (chunks: readonly Uint8Array[]): void => {
  for (const [position, chunk] of chunks.entries()) {
    assert.ok(
      chunk.length >= 1 && chunk.length <= maxChunkBytes,
      `chunk ${position} holds ${chunk.length} bytes`,
    );
  }
};

/** Asserts that each file is listed once, after every file it imports. */
const assertImportsFirst = (files: readonly FileDescriptorProto[]): void => {
  const names = files.map(({ name }) => name);

  assert.equal(new Set(names).size, names.length, `repeated: ${names}`);

  for (const [position, file] of files.entries()) {
    for (const dependency of file.dependency) {
      const at = names.indexOf(dependency);

      assert.ok(
        at !== -1 && at < position,
        `${file.name} imports ${dependency}, which is ${at === -1 ? 'missing' : 'after it'}`,
      );
    }
  }
};

const sortedNames = (files: Iterable<{ readonly name: string }>): string[] =>
  [...files].map(({ name }) => name).sort();

/** The `.proto` names of registry files, as a FileDescriptorSet holds them. */
const sortedProtoNames = (files: Iterable<DescFile>): string[] =>
  [...files].map(({ proto }) => proto.name).sort();

/**
 * A file of one message with `fields` string fields whose names are 64
 * characters long, so its descriptor outgrows 1 MiB from about 7 000 fields.
 */
const bulkyFile = (fields: number): DescFile => {
  const name = 'fixture/bulky.proto';
  const registry = createFileRegistry(
    create(FileDescriptorSetSchema, {
      file: [
        {
          name,
          package: 'fixture.bulky',
          syntax: 'proto3',
          messageType: [
            {
              name: 'Bulky',
              field: Array.from({ length: fields }, (_, position) => ({
                name: `field_${String(position + 1).padStart(6, '0')}_${'x'.repeat(51)}`,
                number: position + 1,
                label: FieldDescriptorProto_Label.OPTIONAL,
                type: FieldDescriptorProto_Type.STRING,
              })),
            },
          ],
        },
      ],
    }),
  );
  const file = registry.getFile(name);

  assert.ok(file !== undefined, `the registry has no ${name}`);

  return file;
};

describe('doric.catalog/v1 Descriptors', () => {
  test("streams the set of every file of the index's registry, imports first, in chunks of at most 1 MiB, and two calls give equal bytes", async (t) => {
    const catalog = await descriptorsOf(t, routerIndex);
    const first = await catalog.read();
    const second = await catalog.read();

    assert.ok(first.chunks.length >= 1, 'Descriptors streamed no item');
    assertChunkSizes(first.chunks);
    assert.deepEqual(
      sortedNames(first.files),
      sortedProtoNames(routerIndex.registry.files),
    );
    assertImportsFirst(first.files);
    assert.deepEqual(second.bytes, first.bytes);
  });

  test('splits a set of more than 1 MiB into several chunks of at most 1 MiB whose concatenation is the set', async (t) => {
    const bulky = bulkyFile(14_000);
    const index = createCatalogIndex([bulky, file_doric_tools_v1_tools]);
    const catalog = await descriptorsOf(t, index);
    const { chunks, bytes, files } = await catalog.read();

    assert.ok(bytes.length > maxChunkBytes, `the set is ${bytes.length} bytes`);
    assert.ok(chunks.length >= 2, `${chunks.length} chunk(s)`);
    assertChunkSizes(chunks);
    assert.deepEqual(sortedNames(files), sortedProtoNames(index.registry.files));
    assertImportsFirst(files);
    assert.equal(
      files.find(({ name }) => name === bulky.proto.name)?.messageType[0]?.field
        .length,
      14_000,
    );
  });

  test('an index without files answers a stream without items', async (t) => {
    const catalog = await descriptorsOf(t, createCatalogIndex([]));
    const { chunks, files } = await catalog.read();

    assert.deepEqual(chunks, []);
    assert.deepEqual(files, []);
  });
});

// ---------------------------------------------------------------------------
// doric.diagnostics/v1 (router)

describe('doric.diagnostics/v1', () => {
  test("Get answers the store's snapshot: generation, mode, issues, bundles, errors and consumers", async (t) => {
    const store = new DiagnosticsStore({
      generation: 2,
      now: () => Date.UTC(2026, 10, 22),
    });

    store.load(resolveCallHost());
    store.setState('settings', 'active', 12.5);
    store.report({
      bundleId: 'alpha',
      kind: 'fixture_report',
      message: 'something happened',
      details: { attempt: 2 },
    });

    const env = await setupRouter(t, [
      createDiagnosticsService({ diagnostics: store }),
    ]);
    const token = await env.start('stranger');
    const response = await within(
      env.raw(DiagnosticsService, token).get({}),
      'diagnostics Get',
    );
    const expected = store.snapshot();

    assert.equal(response.generation, 2);
    assert.equal(response.mode, 'normal');
    assert.equal(response.recovery, undefined);
    assert.deepEqual(response.issues, expected.issues);
    assert.deepEqual(
      response.bundles.map((bundle) => ({
        id: bundle.id,
        version: bundle.version,
        state: bundle.state,
        reasons: codesIn(bundle.reasons),
        activationMs: bundle.activationMs,
      })),
      expected.bundles.map((bundle) => ({
        id: bundle.id,
        version: bundle.version,
        state: bundle.state,
        reasons: codesIn(bundle.reasons),
        activationMs: bundle.activationMs,
      })),
    );
    assert.equal(
      response.bundles.find(({ id }) => id === 'settings')?.activationMs,
      12.5,
    );
    assert.deepEqual(
      response.errors.map((error) => ({
        at: error.at,
        bundleId: error.bundleId,
        kind: error.kind,
        message: error.message,
        details:
          error.details === undefined
            ? undefined
            : toJson(ValueSchema, error.details),
      })),
      [
        {
          at: '2026-11-22T00:00:00.000Z',
          bundleId: 'alpha',
          kind: 'fixture_report',
          message: 'something happened',
          details: { attempt: 2 },
        },
      ],
    );
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(response.consumers).map(([contract, consumers]) => [
          contract,
          [...consumers.bundleIds],
        ]),
      ),
      expected.consumers,
    );
  });

  test('Get in recovery mode answers the recovery reason', async (t) => {
    const store = loaded(resolveCallHost());

    store.enterRecovery('composition_invalid');

    const env = await setupRouter(t, [
      createDiagnosticsService({ diagnostics: store }),
    ]);
    const token = await env.start('stranger');
    const response = await within(
      env.raw(DiagnosticsService, token).get({}),
      'diagnostics Get',
    );

    assert.equal(response.mode, 'recovery');
    assert.equal(response.recovery?.reason, 'composition_invalid');
  });

  test('Report from a caller that declares nothing records the report as sent, and the next Get lists it', async (t) => {
    const store = loaded(resolveCallHost());
    const env = await setupRouter(t, [
      createDiagnosticsService({ diagnostics: store }),
    ]);
    const token = await env.start('stranger', 4);
    const client = env.raw(DiagnosticsService, token);

    const answer = await within(
      client.report({
        bundleId: 'other',
        kind: 'fixture_report',
        message: 'reported for other',
        details: fromJson(ValueSchema, { count: 3, tags: ['a', 'b'] }),
      }),
      'Report',
    );

    assert.ok(answer !== undefined);

    const recorded = store
      .snapshot()
      .errors.map(({ bundleId, kind, message, details }) => ({
        bundleId,
        kind,
        message,
        details,
      }));

    assert.deepEqual(recorded, [
      {
        bundleId: 'other',
        kind: 'fixture_report',
        message: 'reported for other',
        details: { count: 3, tags: ['a', 'b'] },
      },
    ]);

    const listed = await within(client.get({}), 'diagnostics Get');

    assert.deepEqual(
      listed.errors.map(({ bundleId, kind, message }) => ({
        bundleId,
        kind,
        message,
      })),
      [
        {
          bundleId: 'other',
          kind: 'fixture_report',
          message: 'reported for other',
        },
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// doric.bundle/v1 (router)

describe('doric.bundle/v1', () => {
  test('Describe answers the stamped caller and the environment host, a forged doric-caller aside', async (t) => {
    const env = await setupRouter(t, [createBundleService()]);
    const token = await env.start('app', 3);
    const client = env.raw(BundleService, token, {
      'doric-caller': 'core',
      'doric-caller-bundle-id': 'core',
      'doric-caller-version': '9.9.9',
    });

    const described = await within(client.describe({}), 'Describe');

    assert.deepEqual(
      {
        bundleId: described.bundleId,
        version: described.version,
        generation: described.generation,
        environment: described.environment,
      },
      {
        bundleId: 'app',
        version: '1.0.0',
        generation: 3,
        environment: 'host',
      },
    );
  });
});

// ---------------------------------------------------------------------------
// doric.startup/v1 (router)

describe('doric.startup/v1', () => {
  test('Log refuses a level outside the four and absent fields with invalid_input, and passes fields to the sink as a JSON object', async (t) => {
    const records: unknown[] = [];
    const env = await setupRouter(
      t,
      [
        createStartupService({
          stage: (name) => records.push({ stage: name }),
          log: ({ level, message, fields }) =>
            records.push({ level, message, fields: { ...fields } }),
        }),
      ],
      createCatalogIndex([file_doric_platform_startup_v1_startup]),
    );
    const token = await env.start('stranger');
    const client = env.raw(StartupService, token);

    await within(
      client.log({
        level: 'warn',
        message: 'pool configured',
        fields: { size: 3, image: 'doric', nested: { ok: true, ids: ['a'] } },
      }),
      'Log',
    );

    const badLevel = await failureOf(
      client.log({ level: 'fatal', message: 'never', fields: {} }),
    );
    const noFields = await failureOf(
      client.log({ level: 'info', message: 'never' }),
    );

    assert.equal(fromConnectError(badLevel).code, 'invalid_input');
    assert.equal(fromConnectError(noFields).code, 'invalid_input');
    assert.deepEqual(records, [
      {
        level: 'warn',
        message: 'pool configured',
        fields: { size: 3, image: 'doric', nested: { ok: true, ids: ['a'] } },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Through startPlatform (fixture processes)

const describer: FixtureBundle = { mode: 'describe-platform' };
const storageProvider: FixtureBundle = {
  mode: 'serve-storage-identity',
  provides: ['storage.backend/v1@1.0.0'],
};
/** `fixtureHostId` of `tests/fixtures/scripted/main.ts`, generation 3. */
const fixtureStorage = 'storage:6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60:3';

const storageIndex = () =>
  createCatalogIndex([
    file_doric_tools_v1_tools,
    file_doric_settings_v1_settings,
    file_doric_storage_backend_v1_backend,
  ]);

/** The `describe-platform` lines of `bundleId`, once it logged `described`. */
const describedBy = async (
  log: { eventsOf(bundleId: string): string[] },
  bundleId: string,
): Promise<string[]> => {
  await until(
    () => log.eventsOf(bundleId).includes('described'),
    `${bundleId} to describe the platform`,
    6_000,
  );

  return log
    .eventsOf(bundleId)
    .filter((event) =>
      /^(bundle|catalog|storage|diagnostics)(-failed)?:/.test(event),
    );
};

describe('the platform services of startPlatform', () => {
  test('a bundle process reaches doric.bundle/v1, doric.catalog/v1 and doric.diagnostics/v1 though the index lacks them', async (t) => {
    const bundles = { app: describer };
    const env = await setupPlatform(t, bundles);
    const lines = await describedBy(env.log, 'app');
    const ids = resolveHost(bundles).entries.map(({ id }) => id);

    assert.deepEqual(
      lines.filter((line) => !line.startsWith('storage')),
      [
        'bundle:app:1.0.0:1:host',
        `catalog:1:${ids.join(',')}`,
        'diagnostics:normal:1',
      ],
    );
  });

  test('without a storage.backend/v1 provider, catalog Get answers no storage', async (t) => {
    const env = await setupPlatform(t, { app: describer });
    const lines = await describedBy(env.log, 'app');

    assert.deepEqual(
      lines.filter((line) => line.startsWith('storage')),
      ['storage:none'],
    );
  });

  test('reads the storage identity once under the caller doric, and catalog Get answers it from then on', async (t) => {
    const bundles = {
      storage: storageProvider,
      app: { mode: 'alive' } as const,
    };
    const env = await setupPlatform(t, bundles, { index: storageIndex() });

    assert.deepEqual(
      env.log
        .eventsOf('storage')
        .filter((event) => event.startsWith('identity:')),
      ['identity:doric'],
    );

    // A new generation of `app`, started after the boot, describes the
    // platform; the publish does not read the identity again.
    env.scripts.app = describer;
    env.digests.set('app', 'v2');

    await within(env.platform.publish(resolveHost(bundles)), 'the publish');

    const lines = await describedBy(env.log, 'app');

    assert.deepEqual(
      lines.filter((line) => line.startsWith('storage')),
      [fixtureStorage],
    );
    assert.equal(env.log.countOf('storage', 'identity:doric'), 1);
  });

  test("a bundle process reads doric.catalog/v1 Descriptors: the staged and platform files, imports first, in chunks of at most 1 MiB, equal bytes at each call", async (t) => {
    const env = await setupPlatform(t, {
      app: { mode: 'read-descriptors' },
    });

    await until(
      () => env.log.eventsOf('app').includes('descriptors-read'),
      'app to read the descriptors',
      6_000,
    );

    const events = env.log
      .eventsOf('app')
      .filter((event) => event.startsWith('descriptors'));
    const valuesOf = (prefix: string): string[] =>
      events
        .filter((event) => event.startsWith(`${prefix}:`))
        .map((event) => event.slice(prefix.length + 1));

    assert.deepEqual(valuesOf('descriptors-failed'), []);

    const sizes = valuesOf('descriptors-chunks');
    const hashes = valuesOf('descriptors-sha256');
    const listed = valuesOf('descriptors-files');

    assert.equal(sizes.length, 2, `events: ${events}`);
    assert.equal(hashes.length, 2);
    assert.equal(hashes[0], hashes[1]);
    assert.equal(listed[0], listed[1]);

    for (const size of (sizes[0] ?? '').split(',').map(Number)) {
      assert.ok(size >= 1 && size <= maxChunkBytes, `a chunk of ${size}`);
    }

    const names = (listed[0] ?? '').split(',');
    // The staged bundles' files and the platform's own contract files, each
    // with the files it imports.
    const staged = fixtureIndex().registry;
    const platform = createCatalogIndex([
      file_doric_platform_generation_v1_generation,
      file_doric_platform_log_v1_log,
      file_doric_platform_diagnostics_v1_diagnostics,
      file_doric_platform_bundle_v1_bundle,
    ]).registry;
    const expected = new Set([
      ...sortedProtoNames(staged.files),
      ...sortedProtoNames(platform.files),
    ]);

    assert.equal(new Set(names).size, names.length, `repeated: ${names}`);

    for (const name of expected) {
      assert.ok(names.includes(name), `the set lacks ${name}`);
    }

    assert.ok(
      names.includes('doric/platform/catalog/v1/catalog.proto'),
      'the set lacks doric.catalog/v1',
    );

    for (const [position, name] of names.entries()) {
      const file = staged.getFile(name) ?? platform.getFile(name);

      for (const dependency of file?.dependencies ?? []) {
        const at = names.indexOf(dependency.proto.name);

        assert.ok(
          at !== -1 && at < position,
          `${name} imports ${dependency.proto.name}, which is ${at === -1 ? 'missing' : 'after it'}`,
        );
      }
    }
  });

  test('a failing Identity makes startPlatform reject with its error, leaving nothing running', async (t) => {
    const env = bootPlatform(
      t,
      {
        storage: { ...storageProvider, mode: 'identity-fails' },
        app: { mode: 'alive' },
      },
      { index: storageIndex() },
    );
    const outcome = await within(
      env.booting.then(
        () => undefined,
        (error: unknown) => error,
      ),
      'startPlatform to settle',
    );

    assert.ok(
      outcome instanceof ContractError,
      `expected a ContractError: ${String(outcome)}`,
    );
    assert.equal(outcome.code, 'limit_exceeded');
    assert.match(outcome.message, /fixture identity failed/);
    assert.equal(env.log.countOf('storage', 'identity:doric'), 1);
    await until(
      () => env.log.pids().every((pid) => !isAlive(pid)),
      'every fixture process to end',
    );
  });
});
