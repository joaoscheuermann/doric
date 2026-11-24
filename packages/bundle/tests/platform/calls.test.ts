// Calls between bundles, end to end (spec `docs/designs/grpc-processes.md`,
// section 3, steps 1 to 8, section 5, "Host-to-bundle calls", D2, A65; T2.3,
// T2.10, T2.13, T2.15): bundles run in this process with `startBundle`
// against a real router listener whose routes come from a real host
// resolution (`tests/support/call-routes.ts`), and call each other with the
// generated clients of real contracts: `settings/v1` (`one`, unary and
// server-streaming), `models.provider/v1` (`many`), `tools/v1`'s handler
// service, and the platform's `doric.generation/v1` and `doric.log/v1`. Some
// calls use a raw gRPC client with an instance's token, to send headers the
// SDK never sends. No fixture process is spawned (A67).

import assert from 'node:assert/strict';
import test, { describe, type TestContext } from 'node:test';

import { create, type DescService } from '@bufbuild/protobuf';
import { anyPack, EmptySchema } from '@bufbuild/protobuf/wkt';
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
  createGrpcTransport,
  Http2SessionManager,
} from '@connectrpc/connect-node';

import { type Call, deadlineOf } from '../../src/contracts/call.js';
import { ContractError } from '../../src/contracts/error.js';
import {
  EventsService,
  file_doric_events_v1_events,
} from '../../src/contracts/gen/doric/events/v1/events_pb.js';
import {
  file_doric_models_provider_v1_provider,
  ProviderService,
} from '../../src/contracts/gen/doric/models/provider/v1/provider_pb.js';
import {
  file_doric_platform_generation_v1_generation,
  GenerationService,
} from '../../src/contracts/gen/doric/platform/generation/v1/generation_pb.js';
import {
  file_doric_platform_log_v1_log,
  LogService,
  type WriteRequest,
} from '../../src/contracts/gen/doric/platform/log/v1/log_pb.js';
import {
  file_doric_settings_v1_settings,
  SettingsService,
} from '../../src/contracts/gen/doric/settings/v1/settings_pb.js';
import {
  file_doric_tools_v1_tools,
  ToolHandlerService,
} from '../../src/contracts/gen/doric/tools/v1/tools_pb.js';
import { callOf, scopeHeaderValue } from '../../src/contracts/metadata.js';
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
import {
  createGenerationService,
  createLogService,
  type PlatformServiceImpl,
} from '../../src/platform/router/platform-services.js';
import { callRoutesOf } from '../../src/platform/router/route.js';
import {
  type Timings,
  timings,
} from '../../src/platform/supervisor/timings.js';
import {
  type HostContext,
  type InvalidInputAnswer,
  type ServiceEntry,
  startBundle,
} from '../../src/sdk/host/index.js';
import { resolveCallHost } from '../support/call-routes.js';

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
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves with `promise`'s value; fails the test after `timeoutMs`. */
const within = async <T>(
  promise: Promise<T>,
  what: string,
  timeoutMs = 5_000,
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

/** The `ConnectError` `promise` rejects with; fails the test when it resolves. */
const failureOf = async (
  promise: Promise<unknown>,
  what = 'the call',
): Promise<ConnectError> => {
  try {
    await within(promise, what);
  } catch (error) {
    assert.ok(
      error instanceof ConnectError,
      `expected a ConnectError: ${error}`,
    );

    return error;
  }

  return assert.fail(`${what} succeeded`);
};

/** Asserts a call failed with `grpc` and the Doric code `code`. */
const assertFailure = (error: ConnectError, grpc: Code, code: string): void => {
  assert.equal(fromConnectError(error).code, code, error.message);
  assert.equal(error.code, grpc, error.message);
};

/** An implementation that only defines the methods a test calls. */
const partial = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

const index = createCatalogIndex([
  file_doric_settings_v1_settings,
  file_doric_models_provider_v1_provider,
  file_doric_tools_v1_tools,
  file_doric_events_v1_events,
  file_doric_platform_generation_v1_generation,
  file_doric_platform_log_v1_log,
]);

/** What a handler saw of one call. */
interface Seen {
  readonly caller: Call['caller'];
  readonly scope: Call['scope'];
  readonly deadline: number;
  readonly traceparent: string;
  readonly at: number;
}

const seen = (context: HandlerContext): Seen => {
  const call = callOf(context);

  return {
    caller: { ...call.caller },
    scope: call.scope === undefined ? undefined : { ...call.scope },
    deadline: deadlineOf(call),
    traceparent: call.trace.traceparent,
    at: performance.now(),
  };
};

const traceIdOf = (traceparent: string): string | undefined =>
  traceparent.split('-')[1];

/** One bundle started in this process. */
interface Started {
  readonly key: InstanceKey;
  readonly token: string;
  /** The context `activate` received; fails before the activation. */
  context(): HostContext;
}

interface StartOptions {
  readonly services?: readonly ServiceEntry[];
  readonly generation?: number;
  /** Default true: the router activates the instance before `start` resolves. */
  readonly activate?: boolean;
  readonly deactivate?: (context: HostContext) => Promise<void> | void;
  /** The definition's `invalidInput` (S60a). */
  readonly invalidInput?: InvalidInputAnswer;
}

interface Env {
  readonly router: Router;
  readonly table: InstanceTable;
  /** Starts `bundleId` in this process, as instance `<generation>/1`. */
  start(bundleId: string, options?: StartOptions): Promise<Started>;
  /**
   * A raw gRPC client of `service` that sends `token` and `headers` on every
   * call, whatever the SDK would send.
   */
  raw<S extends DescService>(
    service: S,
    token: string,
    headers?: Record<string, string>,
  ): Client<S>;
}

interface SetupOptions {
  readonly timings?: Partial<Timings>;
  readonly platformServices?: (
    table: InstanceTable,
  ) => readonly PlatformServiceImpl[];
}

/** A router with the routes of `resolveCallHost()`; everything closes in `after`. */
const setup = async (
  t: TestContext,
  options: SetupOptions = {},
): Promise<Env> => {
  const table = new InstanceTable();
  const router = await startRouter({
    index,
    routes: callRoutesOf(resolveCallHost()),
    ...(options.platformServices === undefined
      ? {}
      : { platformServices: options.platformServices(table) }),
    instances: table,
    timings: { ...testTimings, ...options.timings },
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
    router,
    table,
    start: async (bundleId, startOptions = {}) => {
      const generation = startOptions.generation ?? 1;
      const instance = { bundleId, generation, incarnation: 1 };
      const { token } = table.issue({ ...instance, version: '1.0.0' });
      const key = instanceKey(instance);
      let context: HostContext | undefined;

      await startBundle<readonly DescService[]>(
        {
          services: startOptions.services ?? [],
          activate: (received) => {
            context = received;
          },
          ...(startOptions.deactivate === undefined
            ? {}
            : { deactivate: startOptions.deactivate }),
          ...(startOptions.invalidInput === undefined
            ? {}
            : { invalidInput: startOptions.invalidInput }),
        },
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

      if (startOptions.activate !== false) {
        const status = await router.sendActivate(key);

        assert.equal(status.code, 0, `activating ${key}: ${status.message}`);
      }

      return {
        key,
        token,
        context: () => {
          assert.ok(context !== undefined, `${key} is not activated`);

          return context;
        },
      };
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

/** `settings/v1` as the bundle `settings` serves it; records each call. */
const settingsProvider = (
  calls: Seen[],
  overrides: Partial<ServiceImpl<typeof SettingsService>> = {},
): ServiceEntry =>
  partial(SettingsService, {
    register: (request, context) => {
      calls.push(seen(context));

      return { registrationId: `registered ${request.id}` };
    },
    watch: async function* (_request, context) {
      calls.push(seen(context));

      for (const revision of [1, 2, 3]) {
        yield {
          settingsEntry: {
            value: anyPack(EmptySchema, create(EmptySchema)),
            revision,
            version: '1.0.0',
            updatedAt: `2026-11-22T00:00:0${revision}.000Z`,
            generation: revision,
          },
        };
      }
    },
    ...overrides,
  });

/** `models.provider/v1` as `alpha` or `beta` serves it. */
const modelProvider = (advertised: boolean, calls: Seen[]): ServiceEntry =>
  partial(ProviderService, {
    advertised: (_request, context) => {
      calls.push(seen(context));

      return { advertised };
    },
  });

const register = { id: 'acme.thing/v1', messageType: 'acme.Thing' };

// ---------------------------------------------------------------------------
// The caller (T2.3)

describe('the caller a handler sees', () => {
  test('is the one the router stamped from the token', async (t) => {
    const env = await setup(t);
    const calls: Seen[] = [];

    await env.start('settings', { services: [settingsProvider(calls)] });
    const app = await env.start('app', { generation: 3 });

    const response = await within(
      app.context().services.use(SettingsService).register(register),
      'register',
    );

    assert.equal(response.registrationId, 'registered acme.thing/v1');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.caller, {
      bundleId: 'app',
      version: '1.0.0',
      generation: 3,
    });
  });

  test('a forged doric-caller header is ignored', async (t) => {
    const env = await setup(t);
    const calls: Seen[] = [];

    await env.start('settings', { services: [settingsProvider(calls)] });
    const app = await env.start('app', { generation: 2 });
    const client = env.raw(SettingsService, app.token, {
      'doric-caller': 'core',
      'doric-caller-bundle-id': 'core',
      'doric-caller-version': '9.9.9',
      'doric-client-part': 'web',
    });

    await within(client.register(register), 'register');

    assert.deepEqual(calls[0]?.caller, {
      bundleId: 'app',
      version: '1.0.0',
      generation: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// Declarations (T2.3, T2.15)

describe('the declaration check', () => {
  test('a contract the caller does not declare answers undeclared_requirement', async (t) => {
    const env = await setup(t);
    const calls: Seen[] = [];

    await env.start('settings', { services: [settingsProvider(calls)] });
    const stranger = await env.start('stranger');

    const error = await failureOf(
      stranger.context().services.use(SettingsService).register(register),
    );

    assertFailure(error, Code.PermissionDenied, 'undeclared_requirement');
    assert.equal(calls.length, 0);
  });

  test('a host part calling a contract only its client.requires lists answers undeclared_requirement', async (t) => {
    const env = await setup(t);
    const calls: Seen[] = [];

    await env.start('settings', { services: [settingsProvider(calls)] });
    const web = await env.start('web');

    const error = await failureOf(
      web.context().services.use(SettingsService).register(register),
    );

    assertFailure(error, Code.PermissionDenied, 'undeclared_requirement');
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Handler services (T2.3; section 5, "Host-to-bundle calls")

describe('handler services', () => {
  const toolHandler = (calls: Seen[]): ServiceEntry =>
    partial(ToolHandlerService, {
      check: (request, context) => {
        calls.push(seen(context));

        return {
          success: true,
          data: { kind: { case: 'stringValue', value: request.name } },
        };
      },
    });

  test('the provider of the contract calls the doric-target instance, whose handler sees it as the caller', async (t) => {
    const env = await setup(t);
    const calls: Seen[] = [];
    const app = await env.start('app', { services: [toolHandler(calls)] });
    const core = await env.start('core');

    const response = await within(
      core
        .context()
        .services.use(ToolHandlerService, { target: app.key })
        .check({ name: 'search' }),
      'check',
    );

    assert.equal(response.success, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.caller, {
      bundleId: 'core',
      version: '1.0.0',
      generation: 1,
    });
  });

  test('a caller that does not provide the contract answers not_owner', async (t) => {
    const env = await setup(t);
    const calls: Seen[] = [];
    const app = await env.start('app', { services: [toolHandler(calls)] });
    const stranger = await env.start('stranger');

    const error = await failureOf(
      stranger
        .context()
        .services.use(ToolHandlerService, { target: app.key })
        .check({ name: 'search' }),
    );

    assertFailure(error, Code.PermissionDenied, 'not_owner');
    assert.equal(calls.length, 0);
  });

  test('the provider without doric-target answers not_owner', async (t) => {
    const env = await setup(t);
    const calls: Seen[] = [];

    await env.start('app', { services: [toolHandler(calls)] });
    const core = await env.start('core');

    const error = await failureOf(
      core.context().services.use(ToolHandlerService).check({ name: 'x' }),
    );

    assertFailure(error, Code.PermissionDenied, 'not_owner');
    assert.equal(calls.length, 0);
  });

  test('a doric-target that is not live answers generation_lost', async (t) => {
    const env = await setup(t);
    const core = await env.start('core');

    const error = await failureOf(
      core
        .context()
        .services.use(ToolHandlerService, { target: 'app/9/1' })
        .check({ name: 'x' }),
    );

    assertFailure(error, Code.Unavailable, 'generation_lost');
  });
});

// ---------------------------------------------------------------------------
// The platform's contracts (T2.3, A65)

describe('doric.* contracts served by the host', () => {
  test('doric.generation/v1 Describe answers the stamped caller, a forged doric-caller aside', async (t) => {
    const env = await setup(t, {
      platformServices: (table) => [
        createGenerationService({ instances: table, signal: () => {} }),
      ],
    });
    const app = await env.start('app', { generation: 3 });
    const client = env.raw(GenerationService, app.token, {
      'doric-caller': 'core',
    });

    const response = await within(client.describe({}), 'describe');

    assert.equal(response.generation, 3);
    assert.equal(response.incarnation, 1);
    assert.equal(response.state, 'active');
  });

  test('doric.log/v1 Write passes the record and the stamped call, for a caller that declares nothing', async (t) => {
    const written: { record: WriteRequest; caller: Call['caller'] }[] = [];
    const env = await setup(t, {
      platformServices: () => [
        createLogService({
          write: (record, call) =>
            written.push({ record, caller: { ...call.caller } }),
        }),
      ],
    });
    const stranger = await env.start('stranger', { generation: 4 });
    const client = env.raw(LogService, stranger.token, {
      'doric-caller': 'core',
    });

    await within(
      client.write({
        level: 'info',
        message: 'hello',
        bundleId: 'other',
        version: '7.0.0',
        generation: 8,
        environment: 'host',
      }),
      'write',
    );

    assert.equal(written.length, 1);
    assert.equal(written[0]?.record.message, 'hello');
    assert.equal(written[0]?.record.bundleId, 'other');
    assert.deepEqual(written[0]?.caller, {
      bundleId: 'stranger',
      version: '1.0.0',
      generation: 4,
    });
  });

  test('a doric.* contract the host does not serve answers unknown_contract', async (t) => {
    const env = await setup(t);
    const app = await env.start('app');

    const error = await failureOf(
      app.context().services.use(GenerationService).describe({}),
    );

    assertFailure(error, Code.Unimplemented, 'unknown_contract');
  });
});

// ---------------------------------------------------------------------------
// Picking the provider (step 4)

describe('a contract of cardinality many', () => {
  const startProviders = async (env: Env, calls: Seen[]): Promise<void> => {
    await env.start('alpha', { services: [modelProvider(false, calls)] });
    await env.start('beta', { services: [modelProvider(true, calls)] });
  };

  test('goes to the provider doric-provider names', async (t) => {
    const env = await setup(t);
    const calls: Seen[] = [];

    await startProviders(env, calls);
    const app = await env.start('app');

    const beta = await within(
      app
        .context()
        .services.use(ProviderService, { provider: 'beta' })
        .advertised({}),
      'advertised from beta',
    );
    const alpha = await within(
      app
        .context()
        .services.use(ProviderService, { provider: 'alpha' })
        .advertised({}),
      'advertised from alpha',
    );

    assert.equal(beta.advertised, true);
    assert.equal(alpha.advertised, false);
  });

  test('without doric-provider answers invalid_input', async (t) => {
    const env = await setup(t);
    const calls: Seen[] = [];

    await startProviders(env, calls);
    const app = await env.start('app');

    const error = await failureOf(
      app.context().services.use(ProviderService).advertised({}),
    );

    assertFailure(error, Code.InvalidArgument, 'invalid_input');
    assert.equal(calls.length, 0);
  });

  test('a doric-provider that is not a provider answers unknown_provider', async (t) => {
    const env = await setup(t);
    const calls: Seen[] = [];

    await startProviders(env, calls);
    const app = await env.start('app');

    const error = await failureOf(
      app
        .context()
        .services.use(ProviderService, { provider: 'gamma' })
        .advertised({}),
    );

    assertFailure(error, Code.NotFound, 'unknown_provider');
    assert.equal(calls.length, 0);
  });
});

describe('unknown contracts', () => {
  /** A copy of `SettingsService` under a name no index holds. */
  const unknownService = (() => {
    const service = {
      ...SettingsService,
      typeName: 'doric.unknown.v1.UnknownService',
    } as typeof SettingsService;
    const method = { ...SettingsService.method.register, parent: service };

    return Object.assign(service, {
      methods: [method],
      method: { ...SettingsService.method, register: method },
    }) as typeof SettingsService;
  })();

  test('a service no contract declares answers unknown_contract', async (t) => {
    const env = await setup(t);
    const app = await env.start('app');

    const error = await failureOf(
      env.raw(unknownService, app.token).register(register),
    );

    assertFailure(error, Code.Unimplemented, 'unknown_contract');
  });

  test("a service missing from the provider's Hello answers unknown_contract", async (t) => {
    const env = await setup(t);

    await env.start('settings', { services: [] });
    const app = await env.start('app');

    const error = await failureOf(
      app.context().services.use(SettingsService).register(register),
    );

    assertFailure(error, Code.Unimplemented, 'unknown_contract');
  });
});

// ---------------------------------------------------------------------------
// Errors crossing the router (T2.10)

describe("a provider's invalidInput (S60a V1, through startBundle)", () => {
  test("a request breaking the provider's protovalidate rules ends with the hook's ContractError; the handler does not run", async (t) => {
    const env = await setup(t);
    const calls: Seen[] = [];
    const methods: string[] = [];

    await env.start('settings', {
      services: [settingsProvider(calls)],
      invalidInput: (method, violations) => {
        methods.push(
          `${method.name}:${violations.map((v) => v.field.join('.')).join(',')}`,
        );

        return new ContractError('not_found', 'The registration is malformed.');
      },
    });
    const app = await env.start('app');

    // `RegisterRequest.id` breaks its pattern when empty.
    const error = await failureOf(
      app
        .context()
        .services.use(SettingsService)
        .register({ id: '', messageType: 'acme.Thing' }),
    );

    assertFailure(error, Code.NotFound, 'not_found');
    assert.equal(
      fromConnectError(error).message,
      'The registration is malformed.',
    );
    assert.deepEqual(methods, ['Register:id']);
    assert.equal(calls.length, 0);
  });
});

describe("a provider's error", () => {
  /** One code of each family of the table, and a code with no row. */
  const families: readonly (readonly [string, Code])[] = [
    ['invalid_input', Code.InvalidArgument],
    ['instance_revoked', Code.Unauthenticated],
    ['not_owner', Code.PermissionDenied],
    ['not_found', Code.NotFound],
    ['registration_conflict', Code.AlreadyExists],
    ['revision_conflict', Code.Aborted],
    ['contract_mismatch', Code.FailedPrecondition],
    ['limit_exceeded', Code.ResourceExhausted],
    ['unknown_contract', Code.Unimplemented],
    ['unavailable', Code.Unavailable],
    ['internal', Code.Internal],
    ['acme_custom', Code.FailedPrecondition],
  ];

  test('a ContractError crosses with its code, message and details, each family as its gRPC code', async (t) => {
    const env = await setup(t);

    await env.start('settings', {
      services: [
        settingsProvider([], {
          register: (request) => {
            throw new ContractError(
              request.messageType,
              `failed with ${request.messageType}`,
              { code: request.messageType, attempt: 1, nested: { ok: true } },
            );
          },
        }),
      ],
    });
    const app = await env.start('app');
    const client = app.context().services.use(SettingsService);

    for (const [code, grpc] of families) {
      const error = await failureOf(
        client.register({ id: 'acme.thing/v1', messageType: code }),
        code,
      );
      const crossed = fromConnectError(error);

      assert.equal(error.code, grpc, code);
      assert.equal(crossed.code, code);
      assert.equal(crossed.message, `failed with ${code}`);
      assert.deepEqual(crossed.details, {
        code,
        attempt: 1,
        nested: { ok: true },
      });
    }
  });

  test('any other error crosses as internal with its message', async (t) => {
    const env = await setup(t);

    await env.start('settings', {
      services: [
        settingsProvider([], {
          register: () => {
            throw new Error('the disk is full');
          },
        }),
      ],
    });
    const app = await env.start('app');

    const error = await failureOf(
      app.context().services.use(SettingsService).register(register),
    );

    assertFailure(error, Code.Internal, 'internal');
    assert.equal(fromConnectError(error).message, 'the disk is full');
  });
});

// ---------------------------------------------------------------------------
// Instance states (T2.13)

describe('instance states', () => {
  test("a stopping instance's calls succeed", async (t) => {
    const env = await setup(t);
    const calls: Seen[] = [];
    const outcomes: string[] = [];

    await env.start('settings', { services: [settingsProvider(calls)] });
    const app = await env.start('app', {
      deactivate: async (context) => {
        try {
          const response = await context.services
            .use(SettingsService)
            .register(register);

          outcomes.push(response.registrationId);
        } catch (error) {
          outcomes.push(`failed: ${error}`);
        }
      },
    });

    await within(env.router.sendStop(app.key), 'the stop');

    assert.deepEqual(outcomes, ['registered acme.thing/v1']);
    assert.equal(calls[0]?.caller.bundleId, 'app');
  });
});

// ---------------------------------------------------------------------------
// Waiting for an active instance (step 4)

describe('waiting for an active instance', () => {
  test('a call waits for the provider to become active, within its deadline', async (t) => {
    const env = await setup(t);
    const calls: Seen[] = [];
    const settings = await env.start('settings', {
      services: [settingsProvider(calls)],
      activate: false,
    });
    const app = await env.start('app');
    const pending = app
      .context()
      .services.use(SettingsService)
      .register(register, { timeoutMs: 5_000 });

    await sleep(200);
    assert.equal(calls.length, 0, 'no call reaches an instance not active');

    const activatedAt = performance.now();
    const status = await env.router.sendActivate(settings.key);

    assert.equal(status.code, 0);

    const response = await within(pending, 'register');

    assert.equal(response.registrationId, 'registered acme.thing/v1');
    assert.equal(calls.length, 1);
    assert.ok((calls[0]?.at ?? 0) >= activatedAt);
  });

  test('without a deadline it waits activeWaitMs, then answers unavailable', async (t) => {
    const env = await setup(t, { timings: { activeWaitMs: 300 } });
    const calls: Seen[] = [];

    await env.start('settings', {
      services: [settingsProvider(calls)],
      activate: false,
    });
    const app = await env.start('app');
    const startedAt = performance.now();

    const error = await failureOf(
      env.raw(SettingsService, app.token).register(register),
    );
    const elapsed = performance.now() - startedAt;

    assertFailure(error, Code.Unavailable, 'unavailable');
    assert.ok(elapsed >= 250, `answered after ${elapsed} ms`);
    assert.ok(elapsed < 3_000, `answered after ${elapsed} ms`);
    assert.equal(calls.length, 0);
  });

  test('with a deadline shorter than activeWaitMs it waits until the deadline', async (t) => {
    const env = await setup(t, { timings: { activeWaitMs: 10_000 } });
    const calls: Seen[] = [];

    await env.start('settings', {
      services: [settingsProvider(calls)],
      activate: false,
    });
    const app = await env.start('app');
    const startedAt = performance.now();

    const error = await failureOf(
      env
        .raw(SettingsService, app.token)
        .register(register, { timeoutMs: 400 }),
    );
    const elapsed = performance.now() - startedAt;

    assert.equal(error.code, Code.DeadlineExceeded, error.message);
    assert.ok(elapsed >= 350, `answered after ${elapsed} ms`);
    assert.ok(elapsed < 3_000, `answered after ${elapsed} ms`);
    assert.equal(calls.length, 0);
  });

  test('a one contract nobody provides answers unavailable at once', async (t) => {
    const env = await setup(t, { timings: { activeWaitMs: 10_000 } });
    const app = await env.start('app');
    const startedAt = performance.now();

    const error = await failureOf(
      env.raw(EventsService, app.token).append({ type: 'acme.event/v1' }),
    );
    const elapsed = performance.now() - startedAt;

    assertFailure(error, Code.Unavailable, 'unavailable');
    assert.ok(elapsed < 2_000, `answered after ${elapsed} ms`);
  });
});

// ---------------------------------------------------------------------------
// Streaming and nested calls

describe('relaying', () => {
  test('a server-streaming call relays every message, in order', async (t) => {
    const env = await setup(t);
    const calls: Seen[] = [];

    await env.start('settings', { services: [settingsProvider(calls)] });
    const app = await env.start('app');
    const revisions: number[] = [];

    await within(
      (async () => {
        for await (const item of app
          .context()
          .services.use(SettingsService)
          .watch({ id: 'acme.thing/v1' })) {
          revisions.push(item.settingsEntry?.revision ?? -1);
        }
      })(),
      'the watch',
    );

    assert.deepEqual(revisions, [1, 2, 3]);
    assert.equal(calls[0]?.caller.bundleId, 'app');
  });

  test('services.use inside a handler inherits the deadline, the scope and the trace', async (t) => {
    const env = await setup(t);
    const settingsCalls: Seen[] = [];
    const alphaCalls: Seen[] = [];
    let settingsContext: HostContext | undefined;

    await env.start('alpha', { services: [modelProvider(true, alphaCalls)] });
    const settings = await env.start('settings', {
      services: [
        settingsProvider(settingsCalls, {
          register: async (_request, context) => {
            settingsCalls.push(seen(context));
            assert.ok(settingsContext !== undefined);

            const answer = await settingsContext.services
              .use(ProviderService, { provider: 'alpha' })
              .advertised({});

            return { registrationId: String(answer.advertised) };
          },
        }),
      ],
    });

    settingsContext = settings.context();

    const app = await env.start('app');
    const sentAt = Date.now();
    const response = await within(
      env
        .raw(SettingsService, app.token, {
          'doric-scope-bin': scopeHeaderValue({ tenant: 't1' }),
        })
        .register(register, { timeoutMs: 5_000 }),
      'register',
    );

    assert.equal(response.registrationId, 'true');

    const outer = settingsCalls[0];
    const inner = alphaCalls[0];

    assert.ok(outer !== undefined && inner !== undefined);
    assert.deepEqual(outer.scope, { tenant: 't1' });
    assert.deepEqual(inner.scope, { tenant: 't1' });
    assert.deepEqual(inner.caller, {
      bundleId: 'settings',
      version: '1.0.0',
      generation: 1,
    });
    assert.ok(
      inner.deadline >= sentAt + 4_000 && inner.deadline <= sentAt + 5_500,
      `inner deadline ${inner.deadline - sentAt} ms after the send`,
    );
    assert.ok(inner.deadline <= outer.deadline + 50);
    assert.equal(traceIdOf(inner.traceparent), traceIdOf(outer.traceparent));
  });
});
