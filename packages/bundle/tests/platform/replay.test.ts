// Registrations across a provider's instances, end to end (spec
// `docs/designs/grpc-processes.md`, section 4, "When an instance ends",
// "When a provider changes" and "Keys across instances" (D4); T2.8, the last
// clause of T2.6): bundles run in this process with `startBundle` against a
// real router listener whose routes come from a real host resolution
// (`resolveReplayHost`). `core` provides `tools/v1` through a test double of
// its registry built on `RegistrationTable`; consumers register tools with
// `context.registrations.track`. A provider restart is simulated by driving
// the instance table: the old incarnation becomes `lost`, and a new
// incarnation of `core` starts and becomes `active`. No fixture process is
// spawned (A67).

import assert from 'node:assert/strict';
import http2 from 'node:http2';
import test, { describe, type TestContext } from 'node:test';

import type { DescService } from '@bufbuild/protobuf';
import {
  type Client,
  ConnectError,
  createClient,
  createRouterTransport as createInMemoryTransport,
  type HandlerContext,
  type Interceptor,
  type ServiceImpl,
  type Transport,
} from '@connectrpc/connect';
import {
  connectNodeAdapter,
  createGrpcTransport,
  Http2SessionManager,
} from '@connectrpc/connect-node';

import {
  file_doric_tools_v1_tools,
  ToolHandlerService,
  ToolsService,
} from '../../src/contracts/gen/doric/tools/v1/tools_pb.js';
import type { CallScope } from '../../src/contracts/call.js';
import {
  scopeFromHeader,
  scopeHeader,
  targetHeader,
} from '../../src/contracts/metadata.js';
import { fromConnectError } from '../../src/contracts/status.js';
import { createCatalogIndex } from '../../src/platform/catalog-index.js';
import {
  type InstanceKey,
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
import { createHopCall } from '../../src/runtime/call.js';
import type { RegistrationReplayReport } from '../../src/runtime/diagnostics.js';
import { createRouterTransport } from '../../src/sdk/host/client.js';
import {
  type BundleInstance,
  type HostContext,
  RegistrationTable,
  type ServiceEntry,
  type StampedCaller,
  stampedCallerOf,
  startBundle,
  type TrackedRegistration,
  type UseOptions,
} from '../../src/sdk/host/index.js';
import { createReplays } from '../../src/sdk/host/replay.js';
import { resolveReplayHost } from '../support/call-routes.js';

// ---------------------------------------------------------------------------
// Helpers

/** Timings short enough for tests; each test overrides what it exercises. */
const testTimings: Timings = {
  ...timings,
  helloTimeoutMs: 5_000,
  activationTimeoutMs: 5_000,
  healthIntervalMs: 10_000,
  healthTimeoutMs: 10_000,
  stallThresholdMs: 10_000,
  stopTimeoutMs: 2_000,
  activeWaitMs: 5_000,
  replayTimeoutMs: 4_000,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves with `promise`'s value; fails the test after `timeoutMs`. */
const within = async <T>(
  promise: Promise<T>,
  what: string,
  timeoutMs = 8_000,
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

/** A promise and the function that resolves it. */
const deferred = <T = void>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
};

const index = createCatalogIndex([file_doric_tools_v1_tools]);

/** One call the `tools/v1` double received. */
interface ToolCall {
  readonly method: 'register' | 'unregister' | 'list' | 'catalog' | 'execute';
  /** The stamped caller, `<bundleId>/<generation>/<incarnation>`. */
  readonly by: string;
  readonly name?: string;
  readonly at: number;
}

/** What the double keeps of a registered tool. */
interface Tool {
  readonly name: string;
  readonly description: string;
}

interface ToolsDouble {
  readonly services: readonly ServiceEntry[];
  readonly activate: (context: HostContext) => void;
  /** The calls this instance received, in the order they arrived. */
  readonly calls: ToolCall[];
  /** The instances `context.instances.onGone` reported, in order. */
  readonly gone: BundleInstance[];
}

const keyOf = (caller: StampedCaller): string =>
  `${caller.bundleId}/${caller.generation}/${caller.incarnation}`;

/**
 * `tools/v1` as one instance of `core` serves it: registrations by tool name
 * in a `RegistrationTable`, dropped on `InstanceGone`; `List` answers the
 * table's entries; `Execute` calls the serving registration's instance
 * through `ToolHandlerService` with `doric-target`. `Register` of a name in
 * `failing` fails with `internal`.
 */
const toolsDouble = (failing: ReadonlySet<string> = new Set()): ToolsDouble => {
  const table = new RegistrationTable<Tool>({ conflictCode: 'duplicate_tool' });
  const calls: ToolCall[] = [];
  const gone: BundleInstance[] = [];
  let host: HostContext | undefined;
  const record = (
    method: ToolCall['method'],
    context: HandlerContext,
    name?: string,
  ): StampedCaller => {
    const caller = stampedCallerOf(context);

    calls.push({
      method,
      by: keyOf(caller),
      ...(name === undefined ? {} : { name }),
      at: performance.now(),
    });

    return caller;
  };
  const implementation: Partial<ServiceImpl<typeof ToolsService>> = {
    register: (request, context) => {
      const name = request.tool?.name ?? '';
      const caller = record('register', context, name);

      if (failing.has(name)) {
        throw new Error(`refusing ${name}`);
      }

      return table.register(caller, name, {
        name,
        description: request.tool?.description ?? '',
      });
    },
    unregister: (request, context) => {
      record('unregister', context);
      table.remove(request.registrationId);

      return {};
    },
    list: (_request, context) => {
      record('list', context);

      return {
        tools: table.entries().map(({ caller, value }) => ({
          bundleId: caller.bundleId,
          tool: { name: value.name, description: value.description },
        })),
      };
    },
    catalog: (_request, context) => {
      record('catalog', context);

      return {
        entries: table.entries().map(({ value }) => ({ name: value.name })),
      };
    },
    execute: async (request, context) => {
      record('execute', context, request.name);
      const serving = table
        .entries()
        .find((entry) => entry.key === request.name);

      assert.ok(host !== undefined && serving !== undefined);
      const response = await host.services
        .use(ToolHandlerService, { target: keyOf(serving.caller) })
        .execute({ name: request.name });

      return response.result === undefined ? {} : { result: response.result };
    },
  };

  return {
    services: [
      [
        ToolsService,
        implementation as ServiceImpl<typeof ToolsService>,
      ] as ServiceEntry,
    ],
    activate: (context) => {
      host = context;
      context.instances.onGone((instance) => {
        gone.push({ ...instance });
        table.dropInstance(instance);
      });
    },
    calls,
    gone,
  };
};

/** `ToolHandlerService.Execute` answering the instance that serves it. */
const toolHandler = (instance: string): ServiceEntry =>
  [
    ToolHandlerService,
    {
      execute: () => ({
        result: { kind: { case: 'stringValue', value: instance } },
      }),
    } as unknown as ServiceImpl<typeof ToolHandlerService>,
  ] as ServiceEntry;

/** One bundle started in this process. */
interface Started {
  readonly key: InstanceKey;
  /** The instance token `start` issued for it. */
  readonly token: string;
  /** The context `activate` received. */
  context(): HostContext;
}

interface StartOptions {
  readonly services?: readonly ServiceEntry[];
  readonly generation?: number;
  readonly incarnation?: number;
  readonly activate?: (context: HostContext) => void;
}

interface Env {
  readonly router: Router;
  readonly table: InstanceTable;
  /** What `diagnostics.registrationReplay` received, in order. */
  readonly reports: {
    readonly kind: RegistrationReplayReport['kind'];
    readonly consumer: InstanceKey;
    readonly provider: InstanceKey;
    readonly message: string;
  }[];
  /** Starts and activates `bundleId` in this process. */
  start(bundleId: string, options?: StartOptions): Promise<Started>;
  /**
   * Restarts `core`: its instance `old` becomes `lost`, and the next
   * incarnation starts with `double` and becomes `active`.
   */
  restartCore(old: Started, double: ToolsDouble): Promise<Started>;
  /**
   * A client of `service` that calls the router directly with `token` and
   * `headers`, outside any SDK and its replay queue.
   */
  raw<S extends DescService>(
    service: S,
    token: string,
    headers?: Readonly<Record<string, string>>,
  ): Client<S>;
}

const setup = async (
  t: TestContext,
  overrides: Partial<Timings> = {},
): Promise<Env> => {
  const table = new InstanceTable();
  const reports: Env['reports'] = [];
  const router = await startRouter({
    index,
    routes: callRoutesOf(resolveReplayHost()),
    instances: table,
    timings: { ...testTimings, ...overrides },
    diagnostics: {
      health: () => {},
      hostStalled: () => {},
      registrationReplay: (kind, consumer, provider, message) =>
        reports.push({ kind, consumer, provider, message }),
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

  const start: Env['start'] = async (bundleId, options = {}) => {
    const generation = options.generation ?? 1;
    const incarnation = options.incarnation ?? 1;
    const instance = { bundleId, generation, incarnation };
    const { token } = table.issue({ ...instance, version: '1.0.0' });
    const key = instanceKey(instance);
    let context: HostContext | undefined;

    await startBundle<readonly DescService[]>(
      {
        services: options.services ?? [],
        activate: (received) => {
          context = received;
          options.activate?.(received);
        },
      },
      {
        env: {
          DORIC_ROUTER_URL: baseUrl,
          DORIC_INSTANCE_TOKEN: token,
          DORIC_BUNDLE_ID: bundleId,
          DORIC_GENERATION: String(generation),
          DORIC_INCARNATION: String(incarnation),
        },
        exit: () => {},
      },
    );

    const status = await router.sendActivate(key);

    assert.equal(status.code, 0, `activating ${key}: ${status.message}`);

    return {
      key,
      token,
      context: () => {
        assert.ok(context !== undefined, `${key} is not activated`);

        return context;
      },
    };
  };

  return {
    router,
    table,
    reports,
    start,
    restartCore: (old, double) => {
      const record = table.get(old.key);

      assert.ok(record !== undefined);
      table.setState(old.key, 'lost');

      return start('core', {
        generation: record.generation,
        incarnation: record.incarnation + 1,
        services: double.services,
        activate: double.activate,
      });
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

/** Starts `core` with `double` as its first instance. */
const startCore = (env: Env, double: ToolsDouble): Promise<Started> =>
  env.start('core', { services: double.services, activate: double.activate });

/** Tracks the tool `name`, described as `bundle`'s key, for `bundle`. */
const trackTool = (
  bundle: Started,
  name: string,
  options: {
    /** Runs before each call after the first, a replay. */
    readonly beforeReplay?: () => Promise<void>;
    readonly onReplayed?: (registrationId: string) => void;
  } = {},
): Promise<TrackedRegistration<string>> => {
  let calls = 0;

  return bundle.context().registrations.track(
    ToolsService,
    async (client: Client<typeof ToolsService>) => {
      calls += 1;

      if (calls > 1) {
        await options.beforeReplay?.();
      }

      const { registrationId } = await client.register({
        tool: {
          name,
          description: bundle.key,
          definition: { name, inputSchema: '{}', outputSchema: '{}' },
        },
        options: {},
      });

      return registrationId;
    },
    options.onReplayed === undefined ? {} : { onReplayed: options.onReplayed },
  );
};

/** The tools `bundle` lists, as `name@description`. */
const listTools = async (bundle: Started): Promise<string[]> => {
  const response = await within(
    bundle.context().services.use(ToolsService).list({}),
    `${bundle.key} listing tools`,
  );

  return response.tools.map(({ tool }) => `${tool?.name}@${tool?.description}`);
};

const registersOf = (calls: readonly ToolCall[]): string[] =>
  calls
    .filter(({ method }) => method === 'register')
    .map(({ by, name }) => `${by} ${name}`);

// ---------------------------------------------------------------------------
// ProviderChanged and the replay (T2.8)

describe('when a provider gets a new instance', () => {
  test('a consumer replays its tracked registrations to it in order, with the stamped caller, then answers ReplayDone', async (t) => {
    const env = await setup(t);
    const first = toolsDouble();
    const core = await startCore(env, first);
    const app = await env.start('app', { incarnation: 3 });
    const idle = await env.start('idle');
    const replayed: string[] = [];
    const tracked: TrackedRegistration<string>[] = [];

    for (const name of ['alpha', 'beta', 'gamma']) {
      tracked.push(
        await within(
          trackTool(app, name, {
            onReplayed: (id) => replayed.push(`${name} ${id}`),
          }),
          `tracking ${name}`,
        ),
      );
    }

    assert.deepEqual(registersOf(first.calls), [
      'app/1/3 alpha',
      'app/1/3 beta',
      'app/1/3 gamma',
    ]);

    const second = toolsDouble();

    await env.restartCore(core, second);

    assert.deepEqual(await listTools(idle), [
      'alpha@app/1/3',
      'beta@app/1/3',
      'gamma@app/1/3',
    ]);
    assert.deepEqual(registersOf(second.calls), [
      'app/1/3 alpha',
      'app/1/3 beta',
      'app/1/3 gamma',
    ]);
    assert.deepEqual(
      replayed.map((entry) => entry.split(' ')[0]),
      ['alpha', 'beta', 'gamma'],
    );
    assert.deepEqual(
      tracked.map(({ current }) => current),
      replayed.map((entry) => entry.split(' ')[1]),
    );
    assert.deepEqual(env.reports, []);
  });

  test('an untracked registration is not replayed', async (t) => {
    const env = await setup(t);
    const core = await startCore(env, toolsDouble());
    const app = await env.start('app');
    const idle = await env.start('idle');

    await within(trackTool(app, 'kept'), 'tracking kept');
    const dropped = await within(trackTool(app, 'dropped'), 'tracking dropped');

    dropped.untrack();
    dropped.untrack();

    const second = toolsDouble();

    await env.restartCore(core, second);

    assert.deepEqual(await listTools(idle), ['kept@app/1/1']);
    assert.deepEqual(registersOf(second.calls), ['app/1/1 kept']);
  });

  test('a call from a bundle that registered nothing waits until every consumer answered ReplayDone, then finds every registration', async (t) => {
    const env = await setup(t);
    const core = await startCore(env, toolsDouble());
    const app = await env.start('app');
    const other = await env.start('other');
    const idle = await env.start('idle');
    const delayMs = 400;

    await within(
      trackTool(app, 'search', { beforeReplay: () => sleep(delayMs) }),
      'tracking search',
    );
    await within(
      trackTool(other, 'fetch', { beforeReplay: () => sleep(delayMs / 2) }),
      'tracking fetch',
    );

    const second = toolsDouble();
    const restarted = performance.now();

    await env.restartCore(core, second);
    const tools = await listTools(idle);
    const elapsed = performance.now() - restarted;

    assert.deepEqual(tools.sort(), ['fetch@other/1/1', 'search@app/1/1']);
    assert.ok(elapsed >= delayMs, `the list answered after ${elapsed} ms`);

    const list = second.calls.find(({ method }) => method === 'list');
    const lastReplay = Math.max(
      ...second.calls
        .filter(({ method }) => method === 'register')
        .map(({ at }) => at),
    );

    assert.ok(list !== undefined && list.at >= lastReplay);
    assert.deepEqual(env.reports, []);
  });

  test('a consumer that never answers delays the held calls only by the replay timeout and is reported registration_replay_late', async (t) => {
    const replayTimeoutMs = 600;
    const env = await setup(t, { replayTimeoutMs });
    const core = await startCore(env, toolsDouble());
    const app = await env.start('app');
    const silent = await env.start('silent');
    const idle = await env.start('idle');

    await within(trackTool(app, 'search'), 'tracking search');
    await within(
      trackTool(silent, 'stuck', {
        beforeReplay: () => new Promise<void>(() => {}),
      }),
      'tracking stuck',
    );

    const second = toolsDouble();
    const restarted = performance.now();
    const restartedCore = await env.restartCore(core, second);
    const tools = await listTools(idle);
    const elapsed = performance.now() - restarted;

    assert.deepEqual(tools, ['search@app/1/1']);
    assert.ok(
      elapsed >= replayTimeoutMs - 20,
      `the list answered after ${elapsed} ms, before the replay timeout`,
    );
    assert.ok(
      elapsed < replayTimeoutMs + 1_500,
      `the list answered after ${elapsed} ms`,
    );
    assert.deepEqual(
      env.reports.map(({ kind, consumer, provider }) => ({
        kind,
        consumer,
        provider,
      })),
      [
        {
          kind: 'registration_replay_late',
          consumer: silent.key,
          provider: restartedCore.key,
        },
      ],
    );
  });

  test('a replay that fails is reported registration_replay_failed; the next replays and ReplayDone still follow', async (t) => {
    const env = await setup(t);
    const core = await startCore(env, toolsDouble());
    const app = await env.start('app');
    const idle = await env.start('idle');

    const broken = await within(trackTool(app, 'broken'), 'tracking broken');
    await within(trackTool(app, 'fine'), 'tracking fine');
    const before = broken.current;

    const second = toolsDouble(new Set(['broken']));
    const restartedCore = await env.restartCore(core, second);

    assert.deepEqual(await listTools(idle), ['fine@app/1/1']);
    assert.deepEqual(registersOf(second.calls), [
      'app/1/1 broken',
      'app/1/1 fine',
    ]);
    assert.equal(broken.current, before);
    assert.equal(env.reports.length, 1, JSON.stringify(env.reports));
    assert.equal(env.reports[0]?.kind, 'registration_replay_failed');
    assert.equal(env.reports[0]?.consumer, app.key);
    assert.equal(env.reports[0]?.provider, restartedCore.key);
    assert.match(env.reports[0]?.message ?? '', /Register/);
  });

  test('use() calls the consumer makes during its replay wait, and start after it in the order they were made', async (t) => {
    const env = await setup(t);
    const core = await startCore(env, toolsDouble());
    const app = await env.start('app');
    const replaying = deferred();

    await within(
      trackTool(app, 'search', {
        beforeReplay: async () => {
          replaying.resolve();
          await sleep(300);
        },
      }),
      'tracking search',
    );

    const second = toolsDouble();

    await env.restartCore(core, second);
    await within(replaying.promise, 'the replay');

    const client = app.context().services.use(ToolsService);
    const listed = client.list({});
    const catalog = client.catalog({});
    const [list] = await within(Promise.all([listed, catalog]), 'the calls');

    assert.deepEqual(
      list.tools.map(({ tool }) => tool?.name),
      ['search'],
    );
    assert.deepEqual(
      second.calls.map(({ method, by }) => `${method} ${by}`),
      ['register app/1/1', 'list app/1/1', 'catalog app/1/1'],
    );
  });
});

// ---------------------------------------------------------------------------
// The replay hold and doric-target (section 4, "When a provider changes";
// the replay-hold gap of slice S24): only a call that names the held
// provider in `doric-target` passes the hold as a replay; any other call to
// it, a pending consumer's included, waits for the release.

/** `promise`, and whether it has settled yet. */
const watched = <T>(
  promise: Promise<T>,
): { readonly promise: Promise<T>; readonly settled: () => boolean } => {
  let settled = false;

  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  return { promise, settled: () => settled };
};

/** The `method` calls `by` made, as the double received them. */
const callsBy = (
  calls: readonly ToolCall[],
  by: string,
  method: ToolCall['method'],
): ToolCall[] =>
  calls.filter((call) => call.by === by && call.method === method);

/** A `Register` of the tool `name`, described as `by`. */
const registerRequest = (name: string, by: string) => ({
  tool: {
    name,
    description: by,
    definition: { name, inputSchema: '{}', outputSchema: '{}' },
  },
  options: {},
});

interface AppHold {
  readonly env: Env;
  readonly core: Started;
  readonly app: Started;
  readonly second: ToolsDouble;
  readonly restartedCore: Started;
  /** Lets `app`'s replay of `search` go on. */
  readonly release: () => void;
}

/**
 * `app` tracks `search`; `core` restarts with `second` (refusing `failing`);
 * resolves once `app`'s replay has begun and waits for `release`, so the
 * replay hold of the new instance is pending with `app` as a pending party.
 */
const holdOnApp = async (
  t: TestContext,
  failing: ReadonlySet<string> = new Set(),
): Promise<AppHold> => {
  const env = await setup(t);
  const core = await startCore(env, toolsDouble());
  const app = await env.start('app');
  const replaying = deferred();
  const gate = deferred();

  await within(
    trackTool(app, 'search', {
      beforeReplay: async () => {
        replaying.resolve();
        await gate.promise;
      },
    }),
    'tracking search',
  );

  const second = toolsDouble(failing);
  const restartedCore = await env.restartCore(core, second);

  await within(replaying.promise, "app's replay");
  t.after(() => gate.resolve());

  return {
    env,
    core,
    app,
    second,
    restartedCore,
    release: () => gate.resolve(),
  };
};

describe('the replay hold and doric-target', () => {
  test("a pending consumer's call on the contract without doric-target waits for the release, then finds the replayed registrations", async (t) => {
    const { env, app, second, release } = await holdOnApp(t);
    const listed = watched(env.raw(ToolsService, app.token).list({}));

    await sleep(300);

    assert.deepEqual(
      callsBy(second.calls, app.key, 'list'),
      [],
      'the List reached the new provider while its replay hold was pending',
    );
    assert.equal(listed.settled(), false, 'the List ended during the hold');

    release();

    const response = await within(listed.promise, 'the List');

    assert.deepEqual(
      response.tools.map(({ tool }) => tool?.name),
      ['search'],
    );

    const [list] = callsBy(second.calls, app.key, 'list');
    const [replay] = callsBy(second.calls, app.key, 'register');

    assert.ok(list !== undefined && replay !== undefined);
    assert.ok(list.at >= replay.at, 'the List started before the replay');
  });

  test("a pending consumer's call with doric-target naming the held provider goes through at once, and its failure is registration_replay_failed", async (t) => {
    const { env, app, second, restartedCore, release } = await holdOnApp(
      t,
      new Set(['bad']),
    );
    const client = env.raw(ToolsService, app.token, {
      [targetHeader]: restartedCore.key,
    });

    const listed = await within(
      client.list({}),
      'the List with doric-target during the hold',
      2_000,
    );

    assert.deepEqual(listed.tools, []);

    let error: unknown;

    try {
      await within(
        client.register(registerRequest('bad', app.key)),
        'the failing Register with doric-target during the hold',
        2_000,
      );
    } catch (caught) {
      error = caught;
    }

    assert.ok(
      error instanceof ConnectError,
      `expected a ConnectError: ${error}`,
    );
    assert.equal(fromConnectError(error).code, 'internal');
    assert.deepEqual(
      callsBy(second.calls, app.key, 'register').map(({ name }) => name),
      ['bad'],
    );

    for (let tries = 0; tries < 50 && env.reports.length === 0; tries += 1) {
      await sleep(20);
    }

    assert.deepEqual(
      env.reports.map(({ kind, consumer, provider }) => ({
        kind,
        consumer,
        provider,
      })),
      [
        {
          kind: 'registration_replay_failed',
          consumer: app.key,
          provider: restartedCore.key,
        },
      ],
    );

    release();
    assert.deepEqual(await listTools(app), ['search@app/1/1']);
  });

  test("a pending consumer's call whose doric-target names another instance waits for the release", async (t) => {
    const { env, core, app, second, release } = await holdOnApp(t);
    const listed = watched(
      env.raw(ToolsService, app.token, { [targetHeader]: core.key }).list({}),
    );

    await sleep(300);

    assert.deepEqual(
      callsBy(second.calls, app.key, 'list'),
      [],
      'the List naming another instance passed the replay hold',
    );
    assert.equal(listed.settled(), false, 'the List ended during the hold');

    release();

    const response = await within(listed.promise, 'the List');

    assert.deepEqual(
      response.tools.map(({ tool }) => tool?.name),
      ['search'],
    );
  });

  test('a consumer that never answers ReplayDone has its own calls to the new provider held until the replay timeout', async (t) => {
    const replayTimeoutMs = 600;
    const env = await setup(t, { replayTimeoutMs });
    const core = await startCore(env, toolsDouble());
    const app = await env.start('app');
    const silent = await env.start('silent');
    const replaying = deferred();

    await within(trackTool(app, 'search'), 'tracking search');
    await within(
      trackTool(silent, 'stuck', {
        beforeReplay: () => {
          replaying.resolve();

          return new Promise<void>(() => {});
        },
      }),
      'tracking stuck',
    );

    const second = toolsDouble();
    const restarted = performance.now();

    await env.restartCore(core, second);
    await within(replaying.promise, "silent's replay");

    const response = await within(
      env.raw(ToolsService, silent.token).list({}),
      "silent's List",
    );
    const elapsed = performance.now() - restarted;

    assert.ok(
      elapsed >= replayTimeoutMs - 20,
      `silent's List answered after ${elapsed} ms, before the replay timeout`,
    );
    assert.deepEqual(
      response.tools.map(({ tool }) => `${tool?.name}@${tool?.description}`),
      ['search@app/1/1'],
    );
  });
});

// ---------------------------------------------------------------------------
// The host SDK's replay calls

/** `inner`, recording the method and the `doric-target` of each call. */
const recording = (
  inner: Transport,
  target: string | undefined,
  seen: { method: string; target: string | undefined }[],
): Transport => ({
  unary: (method, ...rest) => {
    seen.push({ method: method.name, target });

    return inner.unary(method, ...rest);
  },
  stream: (method, ...rest) => {
    seen.push({ method: method.name, target });

    return inner.stream(method, ...rest);
  },
});

const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("the host SDK's replay", () => {
  test('sends every replay call with doric-target naming the instance ProviderChanged named; other calls carry none', async () => {
    const seen: { method: string; target: string | undefined }[] = [];
    const inner = createInMemoryTransport(({ service }) => {
      service(ToolsService, {
        register: (request) => ({
          registrationId: `id ${request.tool?.name}`,
        }),
        list: () => ({ tools: [] }),
      });
    });
    const done = deferred<string>();
    const replays = createReplays({
      transport: (options: UseOptions) =>
        recording(inner, options.target, seen),
      replayDone: (contractId, instance) =>
        done.resolve(`${contractId} ${instanceKey(instance)}`),
      log: silentLog,
    });

    for (const name of ['alpha', 'beta']) {
      await replays.registrations.track(ToolsService, async (client) => {
        const { registrationId } = await client.register(
          registerRequest(name, 'app/1/1'),
        );

        return registrationId;
      });
    }

    replays.providerChanged('tools/v1', {
      bundleId: 'core',
      generation: 1,
      incarnation: 2,
    });

    assert.equal(await within(done.promise, 'ReplayDone'), 'tools/v1 core/1/2');

    await replays.services.use(ToolsService).list({});

    assert.deepEqual(seen, [
      { method: 'Register', target: undefined },
      { method: 'Register', target: undefined },
      { method: 'Register', target: 'core/1/2' },
      { method: 'Register', target: 'core/1/2' },
      { method: 'List', target: undefined },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The router transport's scope (S48a)

/**
 * An HTTP/2 server serving `tools/v1` `List` that records the
 * `doric-scope-bin` of each call, decoded; closed after the test.
 */
const scopeRecorder = async (
  t: TestContext,
): Promise<{
  readonly url: string;
  readonly scopes: (CallScope | undefined)[];
}> => {
  const scopes: (CallScope | undefined)[] = [];
  const server = http2.createServer(
    connectNodeAdapter({
      routes: (router) => {
        router.service(ToolsService, {
          list: (_request, context) => {
            const value = context.requestHeader.get(scopeHeader);

            scopes.push(value === null ? undefined : scopeFromHeader(value));

            return { tools: [] };
          },
        });
      },
    }),
  );
  const sessions = new Set<http2.ServerHttp2Session>();

  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  t.after(
    () =>
      new Promise<void>((resolve) => {
        for (const session of sessions) {
          session.destroy();
        }

        server.close(() => resolve());
      }),
  );

  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');

  return { url: `http://127.0.0.1:${address.port}`, scopes };
};

describe("the router transport's doric-scope-bin", () => {
  test('scope replaces the scope of the parent; without it the parent scope is sent', async (t) => {
    const { url, scopes } = await scopeRecorder(t);
    const sessionManager = new Http2SessionManager(url);
    t.after(() => sessionManager.abort());

    const parent = createHopCall({
      caller: { bundleId: 'app', version: '1.0.0', generation: 1 },
      useScope: { windowKey: 'w1' },
      generationSignal: new AbortController().signal,
    });
    const replaced = { projectId: 'p1', threadId: 't1', promptId: 'r1' };

    await createClient(
      ToolsService,
      createRouterTransport({
        url,
        token: 'token',
        parent,
        scope: replaced,
        sessionManager,
      }),
    ).list({});
    await createClient(
      ToolsService,
      createRouterTransport({ url, token: 'token', parent, sessionManager }),
    ).list({});

    assert.deepEqual(scopes, [replaced, { windowKey: 'w1' }]);
  });
});

// ---------------------------------------------------------------------------
// InstanceGone

describe('when a consumer instance ends', () => {
  test('InstanceGone reaches the provider onGone, whose RegistrationTable drops the registrations', async (t) => {
    const env = await setup(t);
    const double = toolsDouble();

    await startCore(env, double);
    const app = await env.start('app', { generation: 2 });
    const other = await env.start('other');
    const idle = await env.start('idle');

    await within(trackTool(app, 'search'), 'tracking search');
    await within(trackTool(app, 'fetch'), 'tracking fetch');
    await within(trackTool(other, 'read'), 'tracking read');

    env.table.setState(app.key, 'lost');

    for (let tries = 0; tries < 100 && double.gone.length === 0; tries += 1) {
      await sleep(20);
    }

    assert.deepEqual(double.gone, [
      { bundleId: 'app', generation: 2, incarnation: 1 },
    ]);
    assert.deepEqual(await listTools(idle), ['read@other/1/1']);
  });
});

// ---------------------------------------------------------------------------
// Keys across instances (D4; T2.6, last clause)

describe('a key across instances', () => {
  test('registered by generations N and N+1 of a bundle, it is listed once and new calls go to N+1', async (t) => {
    const env = await setup(t);

    await startCore(env, toolsDouble());
    const older = await env.start('app', {
      generation: 2,
      services: [toolHandler('app/2/1')],
    });
    const idle = await env.start('idle');

    await within(trackTool(older, 'search'), 'tracking search on N');

    const newer = await env.start('app', {
      generation: 3,
      services: [toolHandler('app/3/1')],
    });

    await within(trackTool(newer, 'search'), 'tracking search on N+1');

    assert.deepEqual(await listTools(idle), ['search@app/3/1']);

    const response = await within(
      idle.context().services.use(ToolsService).execute({ name: 'search' }),
      'execute',
    );

    assert.deepEqual(response.result?.kind, {
      case: 'stringValue',
      value: 'app/3/1',
    });
  });

  test('when generation N+1 ends, generation N registration serves again', async (t) => {
    const env = await setup(t);

    await startCore(env, toolsDouble());
    const older = await env.start('app', {
      generation: 2,
      services: [toolHandler('app/2/1')],
    });
    const newer = await env.start('app', {
      generation: 3,
      services: [toolHandler('app/3/1')],
    });
    const idle = await env.start('idle');

    await within(trackTool(newer, 'search'), 'tracking search on N+1');
    await within(trackTool(older, 'search'), 'tracking search on N');

    assert.deepEqual(await listTools(idle), ['search@app/3/1']);

    env.table.setState(newer.key, 'stopped');

    let tools: string[] = [];

    for (let tries = 0; tries < 100; tries += 1) {
      tools = await listTools(idle);

      if (tools[0] === 'search@app/2/1') {
        break;
      }

      await sleep(20);
    }

    assert.deepEqual(tools, ['search@app/2/1']);
  });

  test('the same key from another bundle answers its conflict code, and nothing is tracked', async (t) => {
    const env = await setup(t);
    const core = await startCore(env, toolsDouble());
    const app = await env.start('app');
    const other = await env.start('other');
    const idle = await env.start('idle');

    await within(trackTool(app, 'search'), 'tracking search');

    let error: unknown;

    try {
      await within(trackTool(other, 'search'), 'tracking the duplicate');
    } catch (caught) {
      error = caught;
    }

    assert.ok(
      error instanceof ConnectError,
      `expected a ConnectError: ${error}`,
    );
    assert.equal(fromConnectError(error).code, 'duplicate_tool');

    const second = toolsDouble();

    await env.restartCore(core, second);

    assert.deepEqual(await listTools(idle), ['search@app/1/1']);
    assert.deepEqual(registersOf(second.calls), ['app/1/1 search']);
  });
});
