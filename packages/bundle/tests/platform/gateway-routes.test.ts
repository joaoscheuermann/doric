// What the gateway serves and for whom (spec `docs/designs/grpc-processes.md`,
// section 11, "The routes", "The caller", "The client part" and "The HTTP
// prefix"; D34; T2.9, T2.17, AC2.5): the methods of a resolution
// (`servedMethods`), its prefixes (`httpPrefixesOf`), and a gateway in front
// of a real router whose bundles run in this process: the caller `doric`, the
// check of the lists of the client part `doric-client-part` names, and the
// header's drop at the router listener.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import test, { describe, type TestContext } from 'node:test';

import type { DescService } from '@bufbuild/protobuf';
import {
  type Client,
  Code,
  ConnectError,
  createClient,
  type HandlerContext,
  type Interceptor,
  type ServiceImpl,
} from '@connectrpc/connect';
import {
  createConnectTransport,
  createGrpcTransport,
  Http2SessionManager,
} from '@connectrpc/connect-node';

import type { Call } from '../../src/contracts/call.js';
import {
  file_doric_models_v1_models,
  ModelsService,
} from '../../src/contracts/gen/doric/models/v1/models_pb.js';
import {
  CatalogService,
  file_doric_platform_catalog_v1_catalog,
} from '../../src/contracts/gen/doric/platform/catalog/v1/catalog_pb.js';
import {
  DiagnosticsService,
  file_doric_platform_diagnostics_v1_diagnostics,
} from '../../src/contracts/gen/doric/platform/diagnostics/v1/diagnostics_pb.js';
import {
  file_doric_platform_generation_v1_generation,
  GenerationService,
} from '../../src/contracts/gen/doric/platform/generation/v1/generation_pb.js';
import { Environment } from '../../src/contracts/gen/doric/platform/v1/options_pb.js';
import { file_doric_settings_v1_settings } from '../../src/contracts/gen/doric/settings/v1/settings_pb.js';
import {
  file_doric_tools_v1_tools,
  ToolsService,
} from '../../src/contracts/gen/doric/tools/v1/tools_pb.js';
import { callOf } from '../../src/contracts/metadata.js';
import { fromConnectError } from '../../src/contracts/status.js';
import { createCatalogIndex } from '../../src/platform/catalog-index.js';
import {
  type Gateway,
  httpPrefixesOf,
  servedMethods,
  startGateway,
} from '../../src/platform/gateway/index.js';
import {
  InstanceTable,
  instanceKey,
} from '../../src/platform/router/instances.js';
import {
  type Router,
  startRouter,
} from '../../src/platform/router/listener.js';
import { callRoutesOf } from '../../src/platform/router/route.js';
import {
  type Timings,
  timings,
} from '../../src/platform/supervisor/timings.js';
import { PLATFORM_VERSION } from '../../src/runtime/version.js';
import { type ServiceEntry, startBundle } from '../../src/sdk/host/index.js';
import { resolveCallHost } from '../support/call-routes.js';
import { demoFile } from '../support/demo-contract.js';
import { resolveHost } from '../support/scripted-host.js';

// ---------------------------------------------------------------------------
// Helpers

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const within = async <T>(
  promise: Promise<T>,
  what: string,
  timeoutMs = 3_000,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${what}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const failureOf = async (promise: Promise<unknown>): Promise<ConnectError> => {
  try {
    await within(promise, 'the call');
  } catch (error) {
    assert.ok(
      error instanceof ConnectError,
      `expected a ConnectError: ${error}`,
    );

    return error;
  }

  return assert.fail('the call succeeded');
};

const assertFailure = (error: ConnectError, grpc: Code, code: string): void => {
  assert.equal(fromConnectError(error).code, code, error.message);
  assert.equal(error.code, grpc, error.message);
};

const path = (service: string, method: string): string =>
  `/${service}/${method}`;

const toolsCatalog = path('doric.tools.v1.ToolsService', 'Catalog');
const modelsDesktop = ['Kinds', 'Kind', 'Catalog', 'Icons'].map((method) =>
  path('doric.models.v1.ModelsService', method),
);

// ---------------------------------------------------------------------------
// servedMethods

describe('servedMethods', () => {
  const demoHost = demoFile({ id: 'demo/v1', package: 'demo.v1' });
  const demoClient = demoFile({
    id: 'panel/v1',
    package: 'panel.v1',
    environment: Environment.CLIENT,
  });
  const index = createCatalogIndex([
    file_doric_tools_v1_tools,
    file_doric_models_v1_models,
    file_doric_platform_catalog_v1_catalog,
    demoHost,
    demoClient,
  ]);
  const pathsOf = (resolved: Parameters<typeof servedMethods>[1]): string[] =>
    servedMethods(index, resolved).map((info) => info.path);

  test('answers the DESKTOP methods of the contract services of every provided HOST contract, in index order', () => {
    const resolved = resolveHost({
      models: { mode: 'alive', provides: ['models/v1@1.0.0'] },
      demo: { mode: 'alive', provides: ['demo/v1@1.0.0'] },
      panel: { mode: 'alive', provides: ['panel/v1@1.0.0'] },
    });

    assert.deepEqual(pathsOf(resolved), [
      toolsCatalog,
      ...modelsDesktop,
      '/demo.v1.DemoService/Echo',
      '/demo.v1.DemoService/Watch',
    ]);
  });

  test('a contract no scheduled bundle provides has no method served', () => {
    assert.deepEqual(pathsOf(resolveHost({})), [toolsCatalog]);
    assert.deepEqual(
      pathsOf(
        resolveHost(
          { models: { mode: 'alive', provides: ['models/v1@1.0.0'] } },
          { disabled: ['models'] },
        ),
      ),
      [toolsCatalog],
    );
  });

  test('never serves an unexposed method, a handler service, a CLIENT contract or a doric.* contract', () => {
    const paths = pathsOf(
      resolveHost({
        demo: { mode: 'alive', provides: ['demo/v1@1.0.0'] },
        panel: { mode: 'alive', provides: ['panel/v1@1.0.0'] },
      }),
    );

    assert.ok(!paths.includes('/demo.v1.DemoService/Hidden'));
    assert.ok(!paths.includes('/demo.v1.DemoHandlerService/Notify'));
    assert.ok(!paths.some((entry) => entry.startsWith('/panel.v1.')));
    assert.ok(!paths.some((entry) => entry.startsWith('/doric.platform.')));
    assert.ok(!paths.includes(path('doric.tools.v1.ToolsService', 'List')));
  });

  test("then (c) the DESKTOP methods of the platform's in-process contracts, whatever the resolution provides, after (a) and (b), each path once", () => {
    // `doric.diagnostics/v1` brings `doric.catalog/v1`, which it imports
    // (through `bundle/contracts`, so naming this copy too would add a second
    // file of the same name); methods are looked up by path.
    const platformIndex = createCatalogIndex([
      file_doric_platform_diagnostics_v1_diagnostics,
      file_doric_platform_generation_v1_generation,
    ]);
    const methodsOf = (service: DescService) =>
      service.methods.map((method) => {
        const info = platformIndex.method(path(service.typeName, method.name));

        assert.ok(info !== undefined, `${service.typeName}/${method.name}`);

        return info;
      });
    const platform = [
      ...methodsOf(CatalogService),
      ...methodsOf(DiagnosticsService),
      ...methodsOf(GenerationService),
      // A path given twice is served once.
      ...methodsOf(CatalogService),
    ];
    const catalog = (method: string) =>
      path('doric.platform.catalog.v1.CatalogService', method);
    const resolved = resolveHost({
      models: { mode: 'alive', provides: ['models/v1@1.0.0'] },
      demo: { mode: 'alive', provides: ['demo/v1@1.0.0'] },
    });

    assert.deepEqual(
      servedMethods(index, resolved, platform).map((info) => info.path),
      [
        toolsCatalog,
        ...modelsDesktop,
        '/demo.v1.DemoService/Echo',
        '/demo.v1.DemoService/Watch',
        catalog('Get'),
        catalog('Distribution'),
        catalog('ReadArtifact'),
        catalog('Watch'),
        catalog('Disable'),
        catalog('ResetComposition'),
        path('doric.platform.diagnostics.v1.DiagnosticsService', 'Report'),
      ],
    );
    // A resolution that provides nothing still has (c).
    assert.ok(
      servedMethods(index, resolveHost({}), platform)
        .map((info) => info.path)
        .includes(catalog('Distribution')),
    );
  });
});

// ---------------------------------------------------------------------------
// httpPrefixesOf

describe('httpPrefixesOf', () => {
  test('maps the httpPrefix of every scheduled bundle that sets one to its bundle', () => {
    const prefixes = httpPrefixesOf(
      resolveHost({
        relay: { mode: 'alive', httpPrefix: '/screen/' },
        other: { mode: 'alive', httpPrefix: '/other/' },
        plain: { mode: 'alive' },
      }),
    );

    assert.deepEqual(
      [...prefixes].sort(([left], [right]) => left.localeCompare(right)),
      [
        ['/other/', 'other'],
        ['/screen/', 'relay'],
      ],
    );
  });

  test('a disabled bundle has no prefix', () => {
    const prefixes = httpPrefixesOf(
      resolveHost(
        { relay: { mode: 'alive', httpPrefix: '/screen/' } },
        { disabled: ['relay'] },
      ),
    );

    assert.equal(prefixes.size, 0);
  });

  test('a prefix two bundles set belongs to the one the catalog kept (duplicate_http_prefix)', () => {
    const resolved = resolveHost({
      aaa: { mode: 'alive', httpPrefix: '/screen/' },
      bbb: { mode: 'alive', httpPrefix: '/screen/' },
    });
    const kept = resolved.entries.filter(
      (entry) =>
        (entry.id === 'aaa' || entry.id === 'bbb') &&
        entry.state === 'scheduled',
    );

    assert.equal(kept.length, 1, 'the catalog quarantines one of the two');
    assert.deepEqual(
      [...httpPrefixesOf(resolved)],
      [['/screen/', kept[0]?.id]],
    );
  });
});

// ---------------------------------------------------------------------------
// A gateway in front of a real router (T2.17, AC2.5)

const testTimings: Timings = {
  ...timings,
  helloTimeoutMs: 5_000,
  activationTimeoutMs: 5_000,
  healthIntervalMs: 10_000,
  healthTimeoutMs: 10_000,
  stallThresholdMs: 10_000,
  stopTimeoutMs: 2_000,
  activeWaitMs: 1_000,
};

const index = createCatalogIndex([
  file_doric_tools_v1_tools,
  file_doric_settings_v1_settings,
  file_doric_models_v1_models,
]);

const partial = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

const stamp =
  (headers: Readonly<Record<string, string>>): Interceptor =>
  (next) =>
  (request) => {
    for (const [name, value] of Object.entries(headers)) {
      request.header.set(name, value);
    }

    return next(request);
  };

interface GatewayEnv {
  readonly router: Router;
  readonly table: InstanceTable;
  readonly gateway: Gateway;
  /** The caller each call to `core`'s `ToolsService.Catalog` saw. */
  readonly callers: Call['caller'][];
  /** A gRPC client of `service` on the public port, sending `headers`. */
  grpc<S extends DescService>(
    service: S,
    headers?: Readonly<Record<string, string>>,
  ): Client<S>;
  /** A Connect JSON client over HTTP/1.1 on the public port. */
  json<S extends DescService>(
    service: S,
    headers?: Readonly<Record<string, string>>,
  ): Client<S>;
  /** A gRPC client of the router listener with `bundleId`'s token. */
  direct<S extends DescService>(
    service: S,
    bundleId: string,
    headers?: Readonly<Record<string, string>>,
  ): Client<S>;
}

/**
 * A router with the routes of `resolveCallHost()`, `core` started in this
 * process serving `ToolsService.Catalog`, and a gateway on
 * `127.0.0.1:0` over the same resolution; everything closes in `after`.
 */
const setup = async (t: TestContext): Promise<GatewayEnv> => {
  const table = new InstanceTable();
  const resolved = resolveCallHost();
  const router = await startRouter({
    index,
    routes: callRoutesOf(resolved),
    instances: table,
    timings: testTimings,
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
  const callers: Call['caller'][] = [];
  const tokens = new Map<string, string>();

  t.after(async () => {
    for (const session of sessions) {
      session.abort();
    }

    await router.close();
  });

  const start = async (
    bundleId: string,
    services: readonly ServiceEntry[] = [],
  ): Promise<void> => {
    const instance = { bundleId, generation: 1, incarnation: 1 };
    const { token } = table.issue({ ...instance, version: '1.0.0' });

    tokens.set(bundleId, token);
    await startBundle<readonly DescService[]>(
      { services, activate: () => {} },
      {
        env: {
          DORIC_ROUTER_URL: baseUrl,
          DORIC_INSTANCE_TOKEN: token,
          DORIC_BUNDLE_ID: bundleId,
          DORIC_GENERATION: '1',
          DORIC_INCARNATION: '1',
        },
        exit: () => {},
      },
    );

    const status = await router.sendActivate(instanceKey(instance));

    assert.equal(status.code, 0, `activating ${bundleId}: ${status.message}`);
  };

  await start('core', [
    partial(ToolsService, {
      catalog: (_request, context: HandlerContext) => {
        callers.push({ ...callOf(context).caller });

        return { entries: [] };
      },
    }),
  ]);
  await start('stranger');

  const gateway = await startGateway({
    address: '127.0.0.1:0',
    index,
    resolved,
    router,
  });

  t.after(() => gateway.close());

  const publicUrl = `http://127.0.0.1:${gateway.port}`;
  const session = (url: string): Http2SessionManager => {
    const manager = new Http2SessionManager(url);

    sessions.push(manager);

    return manager;
  };

  return {
    router,
    table,
    gateway,
    callers,
    grpc: (service, headers = {}) =>
      createClient(
        service,
        createGrpcTransport({
          baseUrl: publicUrl,
          sessionManager: session(publicUrl),
          interceptors: [stamp(headers)],
        }),
      ),
    json: (service, headers = {}) =>
      createClient(
        service,
        createConnectTransport({
          baseUrl: publicUrl,
          httpVersion: '1.1',
          useBinaryFormat: false,
          interceptors: [stamp(headers)],
        }),
      ),
    direct: (service, bundleId, headers = {}) =>
      createClient(
        service,
        createGrpcTransport({
          baseUrl,
          sessionManager: session(baseUrl),
          interceptors: [
            stamp({
              authorization: `Bearer ${tokens.get(bundleId) ?? ''}`,
              ...headers,
            }),
          ],
        }),
      ),
  };
};

const gatewayCallerSeen = {
  bundleId: 'doric',
  version: PLATFORM_VERSION,
  generation: 0,
};

describe('a gateway call', () => {
  test('without doric-client-part reaches a served method, and the provider sees the caller doric', async (t) => {
    const env = await setup(t);

    await within(env.grpc(ToolsService).catalog({}), 'catalog over gRPC');
    await within(
      env.json(ToolsService).catalog({}),
      'catalog over Connect JSON, HTTP/1.1',
    );

    assert.deepEqual(env.callers, [gatewayCallerSeen, gatewayCallerSeen]);
  });

  test('with doric-client-part naming a client part whose lists include the contract answers OK, the caller still doric', async (t) => {
    const env = await setup(t);

    await within(
      env.grpc(ToolsService, { 'doric-client-part': 'app' }).catalog({}),
      'catalog',
    );

    assert.deepEqual(env.callers, [gatewayCallerSeen]);
  });

  test('with doric-client-part naming a client part whose lists do not include the contract answers PERMISSION_DENIED undeclared_requirement', async (t) => {
    const env = await setup(t);

    // `web`'s client part requires `settings/v1` only; `stranger` declares
    // nothing.
    for (const clientPart of ['web', 'stranger']) {
      assertFailure(
        await failureOf(
          env
            .grpc(ToolsService, { 'doric-client-part': clientPart })
            .catalog({}),
        ),
        Code.PermissionDenied,
        'undeclared_requirement',
      );
    }

    assert.deepEqual(env.callers, []);
  });

  test('with doric-client-part naming a bundle the resolution does not schedule answers PERMISSION_DENIED undeclared_requirement', async (t) => {
    const env = await setup(t);

    // `ghost` is no candidate; `broken` is quarantined.
    for (const clientPart of ['ghost', 'broken']) {
      assertFailure(
        await failureOf(
          env
            .json(ToolsService, { 'doric-client-part': clientPart })
            .catalog({}),
        ),
        Code.PermissionDenied,
        'undeclared_requirement',
      );
    }

    assert.deepEqual(env.callers, []);
  });

  test('a method the gateway does not serve answers UNIMPLEMENTED unknown_contract, with or without a client part', async (t) => {
    const env = await setup(t);

    const variants: Readonly<Record<string, string>>[] = [
      {},
      { 'doric-client-part': 'app' },
    ];

    for (const headers of variants) {
      assertFailure(
        await failureOf(env.grpc(ToolsService, headers).list({})),
        Code.Unimplemented,
        'unknown_contract',
      );
    }
  });

  test('setResolution changes the served methods from the next request on', async (t) => {
    const env = await setup(t);
    const kinds = () => env.grpc(ModelsService).kinds({});

    assertFailure(
      await failureOf(kinds()),
      Code.Unimplemented,
      'unknown_contract',
    );

    env.gateway.setResolution(
      resolveHost({ models: { mode: 'alive', provides: ['models/v1@1.0.0'] } }),
    );

    // Served now: relayed to the router, whose routes have no provider.
    const relayed = await failureOf(kinds());

    assert.notEqual(fromConnectError(relayed).code, 'unknown_contract');

    env.gateway.setResolution(resolveCallHost());

    assertFailure(
      await failureOf(kinds()),
      Code.Unimplemented,
      'unknown_contract',
    );
  });

  test('an HTTP/1.1 upgrade under no prefix gets HTTP/1.1 404, then the socket closes', async (t) => {
    const env = await setup(t);
    const socket = net.connect(env.gateway.port, '127.0.0.1');
    let received = '';

    t.after(() => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('latin1');
    });
    await within(once(socket, 'connect'), 'the connection');
    socket.write(
      'GET /socket.io/ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    );
    await within(once(socket, 'close'), 'the socket to close');

    assert.match(received, /^HTTP\/1\.1 404/);
  });

  test('close refuses later connections', async (t) => {
    const env = await setup(t);
    const port = env.gateway.port;

    await within(env.gateway.close(), 'the close');
    await sleep(10);

    const refused = net.connect(port, '127.0.0.1');
    const [error] = (await within(once(refused, 'error'), 'the refusal')) as [
      NodeJS.ErrnoException,
    ];

    assert.equal(error.code, 'ECONNREFUSED');
  });
});

describe('the router listener', () => {
  test('drops a doric-client-part header: a bundle is checked against its own host part', async (t) => {
    const env = await setup(t);

    assertFailure(
      await failureOf(
        env
          .direct(ToolsService, 'stranger', { 'doric-client-part': 'app' })
          .catalog({}),
      ),
      Code.PermissionDenied,
      'undeclared_requirement',
    );
    assert.deepEqual(env.callers, []);
  });

  test('serveGateway answers UNAVAILABLE unavailable after close', async (t) => {
    const env = await setup(t);

    await env.router.close();

    assertFailure(
      await failureOf(env.grpc(ToolsService).catalog({})),
      Code.Unavailable,
      'unavailable',
    );
  });
});
