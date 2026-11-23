// Streams, flow control, deadlines and sizes of calls between bundles (spec
// `docs/designs/grpc-processes.md`, section 3 step 7 and "Size", section 5
// "Flow control"; T2.4, T2.5, T2.12): bundles run in this process with
// `startBundle` against a real router listener whose routes come from a real
// host resolution (`tests/support/call-routes.ts`), and call each other with
// the generated clients of `settings/v1` (server streaming) and
// `models.provider/v1` (`Complete`, client streaming; `Stream`,
// bidirectional). Where a test must see or break the control protocol, the
// provider is a fake bundle: a Connect gRPC client of the control stream
// that sends and reads raw frames.
//
// T2.12's snapshot case (a `runtime.threads/v1.WatchThread` snapshot over
// 3 MiB arriving as a snapshot and `event` items) runs on a fixture contract
// of the same shape built at run time (`tests/support/watch-thread-contract.ts`),
// since the real contract is not generated in this package.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { describe, type TestContext } from 'node:test';

import {
  create,
  type DescService,
  fromBinary,
  type MessageInitShape,
  toBinary,
} from '@bufbuild/protobuf';
import { anyPack, EmptySchema } from '@bufbuild/protobuf/wkt';
import {
  type Client,
  Code,
  ConnectError,
  createClient,
  type Interceptor,
  type ServiceImpl,
} from '@connectrpc/connect';
import {
  createGrpcTransport,
  Http2SessionManager,
} from '@connectrpc/connect-node';

import {
  CompleteRequestSchema,
  CompleteResponseSchema,
  file_doric_models_provider_v1_provider,
  type ProviderMessage,
  ProviderService,
  type StreamRequestSchema,
  type StreamResponse,
  type StreamResponseSchema,
} from '../../src/contracts/gen/doric/models/provider/v1/provider_pb.js';
import {
  BundleHostService,
  type ConnectRequest,
  ConnectRequestSchema,
  type ConnectResponse,
} from '../../src/contracts/gen/doric/platform/v1/control_pb.js';
import {
  file_doric_settings_v1_settings,
  SettingsService,
  WatchResponseSchema,
} from '../../src/contracts/gen/doric/settings/v1/settings_pb.js';
import { fromConnectError } from '../../src/contracts/status.js';
import { createCatalogIndex } from '../../src/platform/catalog-index.js';
import {
  type InvalidReason,
  initialCallCredit,
  maxMessageBytes,
} from '../../src/platform/router/control.js';
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
import {
  type HostContext,
  type ServiceEntry,
  startBundle,
} from '../../src/sdk/host/index.js';
import {
  resolveCallHost,
  resolveSnapshotHost,
} from '../support/call-routes.js';
import {
  messageOf,
  serviceOf,
  type ThreadsClient,
  type WatchEvent,
  type WatchThreadItem,
  watchThreadFile,
} from '../support/watch-thread-contract.js';

// ---------------------------------------------------------------------------
// Helpers

/** Timings short enough for tests; each test overrides what it exercises. */
const testTimings: Timings = {
  ...timings,
  helloTimeoutMs: 5_000,
  activationTimeoutMs: 5_000,
  healthIntervalMs: 60_000,
  healthTimeoutMs: 60_000,
  stallThresholdMs: 60_000,
  stopTimeoutMs: 2_000,
  activeWaitMs: 5_000,
};

const mebibyte = 1024 * 1024;

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

/** Polls `predicate` until it holds; fails the test after `timeoutMs`. */
const until = async (
  predicate: () => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<void> => {
  const deadline = performance.now() + timeoutMs;

  while (!predicate()) {
    if (performance.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }

    await sleep(10);
  }
};

/** The `ConnectError` `promise` rejects with; fails the test when it resolves. */
const failureOf = async (
  promise: Promise<unknown>,
  what = 'the call',
  timeoutMs = 5_000,
): Promise<ConnectError> => {
  try {
    await within(promise, what, timeoutMs);
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

/** Resolves when `signal` aborts. */
const aborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    signal.addEventListener('abort', () => resolve(), { once: true });
  });

/** An async iterable whose items the test pushes, then ends. */
class Pushable<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private ended = false;
  private wake: (() => void) | undefined;

  push(item: T): void {
    this.items.push(item);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      const item = this.items.shift();

      if (item !== undefined) {
        yield item;
        continue;
      }

      if (this.ended) {
        return;
      }

      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

/** An implementation that only defines the methods a test calls. */
const partial = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

const watchThread = watchThreadFile();
const ThreadsService = serviceOf(watchThread, 'ThreadsService');
const WatchThreadResponseSchema = messageOf(watchThread, 'WatchThreadResponse');

const index = createCatalogIndex([
  file_doric_settings_v1_settings,
  file_doric_models_provider_v1_provider,
  watchThread,
]);

type CompleteItem = MessageInitShape<typeof CompleteRequestSchema>;
type StreamItem = MessageInitShape<typeof StreamRequestSchema>;

/** A request item of `Complete` or `Stream` carrying one user message. */
const messageItem = (text: string): CompleteItem & StreamItem => ({
  item: {
    case: 'message',
    value: { role: 'user', content: { case: 'text', value: text } },
  },
});

/** The text a request item of `Complete` or `Stream` carries; '' for none. */
const textOf = (request: {
  readonly item: {
    readonly case: string | undefined;
    readonly value?: unknown;
  };
}): string => {
  if (request.item.case !== 'message') {
    return '';
  }

  const { content } = request.item.value as ProviderMessage;

  return content.case === 'text' ? content.value : '';
};

/** The delta of a `Stream` response; undefined for another event. */
const deltaOf = (response: StreamResponse): string | undefined => {
  const type = response.providerStreamEvent?.type;

  return type?.case === 'textDelta' ? type.value.delta : undefined;
};

/** A `Stream` response carrying `delta`. */
const deltaResponse = (
  delta: string,
): MessageInitShape<typeof StreamResponseSchema> => ({
  providerStreamEvent: { type: { case: 'textDelta', value: { delta } } },
});

/** A `settings/v1` entry of revision `revision`. */
const entry = (revision: number) => ({
  settingsEntry: {
    value: anyPack(EmptySchema, create(EmptySchema)),
    revision,
    version: '1.0.0',
    updatedAt: '2026-11-22T00:00:00.000Z',
    generation: 1,
  },
});

const register = { id: 'acme.thing/v1', messageType: 'acme.Thing' };

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

// ---------------------------------------------------------------------------
// A fake bundle: the control stream driven frame by frame

type FrameCase = NonNullable<ConnectResponse['frame']['case']>;
type FrameValue<C extends FrameCase> = Extract<
  ConnectResponse['frame'],
  { case: C }
>['value'];

/** One control stream of a fake bundle. */
class FakeBundle {
  readonly frames: ConnectResponse[] = [];
  /** Set when the response stream ended; `error` when it failed. */
  outcome: { readonly error?: unknown } | undefined;
  /** Called synchronously for every frame the router sends. */
  onFrame: ((frame: ConnectResponse) => void) | undefined;

  private readonly queue: (ConnectRequest | 'end')[] = [];
  private wake: (() => void) | undefined;

  constructor(
    client: Client<typeof BundleHostService>,
    token: string,
    readonly key: InstanceKey,
  ) {
    void this.run(
      client.connect(this.requests(), {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  }

  send(frame: MessageInitShape<typeof ConnectRequestSchema>): void {
    this.queue.push(create(ConnectRequestSchema, frame));
    this.wake?.();
  }

  framesOf<C extends FrameCase>(kind: C): FrameValue<C>[] {
    const values: FrameValue<C>[] = [];

    for (const f of this.frames) {
      if (f.frame.case === kind) {
        values.push(f.frame.value as FrameValue<C>);
      }
    }

    return values;
  }

  private async *requests(): AsyncGenerator<ConnectRequest> {
    for (;;) {
      const next = this.queue.shift();

      if (next === 'end') {
        return;
      }

      if (next !== undefined) {
        yield next;
        continue;
      }

      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }

  private async run(responses: AsyncIterable<ConnectResponse>): Promise<void> {
    try {
      for await (const frame of responses) {
        this.frames.push(frame);
        this.onFrame?.(frame);
      }

      this.outcome = {};
    } catch (error) {
      this.outcome = { error };
    }
  }
}

// ---------------------------------------------------------------------------
// The environment

/** One bundle started in this process. */
interface Started {
  readonly key: InstanceKey;
  readonly token: string;
  /** The context `activate` received; fails before the activation. */
  context(): HostContext;
}

interface Env {
  readonly router: Router;
  readonly invalid: {
    key: InstanceKey;
    reason: InvalidReason;
    message: string;
  }[];
  /** Starts `bundleId` in this process with the SDK, active, as `<bundleId>/1/1`. */
  start(bundleId: string, services?: readonly ServiceEntry[]): Promise<Started>;
  /**
   * Connects a fake bundle `bundleId` whose Hello lists `services`, answers
   * its `Activate` and activates it.
   */
  fake(bundleId: string, services: readonly DescService[]): Promise<FakeBundle>;
  /** A raw gRPC client of `service` that sends `token` and `headers`. */
  raw<S extends DescService>(
    service: S,
    token: string,
    headers?: Record<string, string>,
  ): Client<S>;
}

/**
 * A router with the routes of `resolved` (`resolveCallHost()` by default);
 * everything closes in `after`.
 */
const setup = async (
  t: TestContext,
  resolved = resolveCallHost(),
): Promise<Env> => {
  const table = new InstanceTable();
  const invalid: Env['invalid'] = [];
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
    onInvalid: (key, reason, message) => invalid.push({ key, reason, message }),
    onLost: () => {},
  });
  const baseUrl = `http://127.0.0.1:${router.port}`;
  const sessions: Http2SessionManager[] = [];
  const session = (): Http2SessionManager => {
    const manager = new Http2SessionManager(baseUrl);

    sessions.push(manager);

    return manager;
  };

  t.after(async () => {
    await router.close();

    for (const manager of sessions) {
      manager.abort();
    }
  });

  return {
    router,
    invalid,
    start: async (bundleId, services = []) => {
      const instance = { bundleId, generation: 1, incarnation: 1 };
      const { token } = table.issue({ ...instance, version: '1.0.0' });
      const key = instanceKey(instance);
      let context: HostContext | undefined;

      await startBundle<readonly DescService[]>(
        {
          services,
          activate: (received) => {
            context = received;
          },
        },
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
    },
    fake: async (bundleId, services) => {
      const instance = { bundleId, generation: 1, incarnation: 1 };
      const { token } = table.issue({ ...instance, version: '1.0.0' });
      const key = instanceKey(instance);
      const client = createClient(
        BundleHostService,
        createGrpcTransport({ baseUrl, sessionManager: session() }),
      );
      const bundle = new FakeBundle(client, token, key);

      bundle.onFrame = (frame) => {
        if (frame.frame.case === 'activate') {
          bundle.send({
            frame: { case: 'activateResult', value: { status: { code: 0 } } },
          });
        }
      };
      bundle.send({
        frame: {
          case: 'hello',
          value: {
            protocolVersion: 1,
            instance,
            services: services.map(({ typeName }) => typeName),
            httpPort: 0,
          },
        },
      });
      await until(() => bundle.framesOf('accepted').length > 0, 'Accepted');

      const status = await router.sendActivate(key);

      assert.equal(status.code, 0, `activating ${key}: ${status.message}`);

      return bundle;
    },
    raw: (service, token, headers = {}) => {
      const stamp: Interceptor = (next) => (request) => {
        request.header.set('authorization', `Bearer ${token}`);

        for (const [name, value] of Object.entries(headers)) {
          request.header.set(name, value);
        }

        return next(request);
      };

      return createClient(
        service,
        createGrpcTransport({
          baseUrl,
          sessionManager: session(),
          interceptors: [stamp],
        }),
      );
    },
  };
};

// ---------------------------------------------------------------------------
// Deadline and cancellation (T2.4; section 3, step 7)

describe('the deadline and cancellation', () => {
  test("at the deadline the provider's signal aborts and the caller gets DEADLINE_EXCEEDED", async (t) => {
    const env = await setup(t);
    let handlerSignal: AbortSignal | undefined;

    await env.start('settings', [
      partial(SettingsService, {
        register: async (_request, context) => {
          handlerSignal = context.signal;
          await aborted(context.signal);

          return { registrationId: 'late' };
        },
      }),
    ]);
    const app = await env.start('app');
    const startedAt = performance.now();

    // The deadline travels as `grpc-timeout` only: the client does not end
    // the call itself, so the code is the router's answer.
    const error = await failureOf(
      env
        .raw(SettingsService, app.token, { 'grpc-timeout': '300m' })
        .register(register),
    );
    const elapsed = performance.now() - startedAt;

    assert.equal(error.code, Code.DeadlineExceeded, error.message);
    assert.ok(elapsed >= 250, `answered after ${elapsed} ms`);
    assert.ok(elapsed < 3_000, `answered after ${elapsed} ms`);
    assert.ok(handlerSignal !== undefined, 'the handler ran');
    await within(aborted(handlerSignal), "the provider's signal to abort");
  });

  test('at the deadline the router sends CallCancel { reason: "deadline" }', async (t) => {
    const env = await setup(t);
    const settings = await env.fake('settings', [SettingsService]);
    const app = await env.start('app');

    const error = await failureOf(
      env
        .raw(SettingsService, app.token, { 'grpc-timeout': '300m' })
        .register(register),
    );

    assert.equal(error.code, Code.DeadlineExceeded, error.message);

    const [start] = settings.framesOf('callStart');

    assert.ok(start !== undefined, 'the provider got the call');
    await until(() => settings.framesOf('callCancel').length > 0, 'CallCancel');
    assert.deepEqual(
      settings
        .framesOf('callCancel')
        .map(({ callId, reason }) => ({ callId, reason })),
      [{ callId: start.callId, reason: 'deadline' }],
    );
  });

  test("a caller's cancel aborts the provider's signal", async (t) => {
    const env = await setup(t);
    let handlerSignal: AbortSignal | undefined;

    await env.start('settings', [
      partial(SettingsService, {
        register: async (_request, context) => {
          handlerSignal = context.signal;
          await aborted(context.signal);

          return { registrationId: 'late' };
        },
      }),
    ]);
    const app = await env.start('app');
    const controller = new AbortController();
    const call = app
      .context()
      .services.use(SettingsService)
      .register(register, { signal: controller.signal });

    await until(() => handlerSignal !== undefined, 'the handler to run');
    controller.abort();

    const error = await failureOf(call);

    assert.equal(error.code, Code.Canceled, error.message);
    assert.ok(handlerSignal !== undefined);
    await within(aborted(handlerSignal), "the provider's signal to abort");
  });

  test('a caller\'s cancel makes the router send CallCancel { reason: "cancelled" }', async (t) => {
    const env = await setup(t);
    const settings = await env.fake('settings', [SettingsService]);
    const app = await env.start('app');
    const controller = new AbortController();
    const call = env
      .raw(SettingsService, app.token)
      .register(register, { signal: controller.signal });

    await until(
      () => settings.framesOf('callStart').length > 0,
      'the call to reach the provider',
    );
    controller.abort();
    await failureOf(call);

    const [start] = settings.framesOf('callStart');

    assert.ok(start !== undefined);
    await until(() => settings.framesOf('callCancel').length > 0, 'CallCancel');
    assert.deepEqual(
      settings
        .framesOf('callCancel')
        .map(({ callId, reason }) => ({ callId, reason })),
      [{ callId: start.callId, reason: 'cancelled' }],
    );
  });
});

// ---------------------------------------------------------------------------
// Streams with credit (T2.5; section 5, "Flow control")

describe('streams with credit', () => {
  const count = 40;

  test(`a server stream of ${count} messages arrives whole, in order`, async (t) => {
    const env = await setup(t);

    await env.start('settings', [
      partial(SettingsService, {
        watch: async function* () {
          for (let revision = 1; revision <= count; revision += 1) {
            yield entry(revision);
          }
        },
      }),
    ]);
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

    assert.deepEqual(
      revisions,
      Array.from({ length: count }, (_, i) => i + 1),
    );
  });

  test(`a client stream of ${count} messages arrives whole, in order`, async (t) => {
    const env = await setup(t);
    const received: string[] = [];

    await env.start('alpha', [
      partial(ProviderService, {
        complete: async (requests) => {
          for await (const request of requests) {
            received.push(textOf(request));
          }

          return {
            providerFinished: {
              text: String(received.length),
              finishReason: 'stop',
            },
          };
        },
      }),
    ]);
    const app = await env.start('app');
    const sent = Array.from({ length: count }, (_, i) => `m${i}`);

    const response = await within(
      app
        .context()
        .services.use(ProviderService, { provider: 'alpha' })
        .complete(
          (async function* () {
            for (const text of sent) {
              yield messageItem(text);
            }
          })(),
        ),
      'complete',
    );

    assert.equal(response.providerFinished?.text, String(count));
    assert.deepEqual(received, sent);
  });

  test(`a bidirectional stream answers each of ${count} messages before the next is sent`, async (t) => {
    const env = await setup(t);

    await env.start('alpha', [
      partial(ProviderService, {
        stream: async function* (requests) {
          for await (const request of requests) {
            yield deltaResponse(`echo ${textOf(request)}`);
          }
        },
      }),
    ]);
    const app = await env.start('app');
    const requests = new Pushable<StreamItem>();
    const responses = app
      .context()
      .services.use(ProviderService, { provider: 'alpha' })
      .stream(requests)
      [Symbol.asyncIterator]();

    for (let i = 0; i < count; i += 1) {
      requests.push(messageItem(`m${i}`));

      const next = await within(responses.next(), `the echo of m${i}`);

      assert.equal(next.done, false, `the stream ended before m${i}`);
      assert.equal(deltaOf(next.value as StreamResponse), `echo m${i}`);
    }

    requests.end();

    const last = await within(responses.next(), 'the end of the stream');

    assert.equal(last.done, true);
  });

  test(`the router sends at most ${initialCallCredit} request messages before the provider's CallCredit`, async (t) => {
    const env = await setup(t);
    const alpha = await env.fake('alpha', [ProviderService]);
    const app = await env.start('app');
    const sent = Array.from({ length: count }, (_, i) => `m${i}`);
    const call = app
      .context()
      .services.use(ProviderService, { provider: 'alpha' })
      .complete(
        (async function* () {
          for (const text of sent) {
            yield messageItem(text);
          }
        })(),
      );

    await until(
      () => alpha.framesOf('callStart').length > 0,
      'the call to reach the provider',
    );

    const [start] = alpha.framesOf('callStart');

    assert.ok(start !== undefined);
    assert.equal(start.kind, 'client_stream');
    assert.equal(start.initialCredit, initialCallCredit);

    await until(
      () => alpha.framesOf('callMessage').length >= initialCallCredit,
      `${initialCallCredit} request messages`,
    );
    // Give the router time to send more than its credit, if it would.
    await sleep(300);

    assert.equal(alpha.framesOf('callMessage').length, initialCallCredit);
    assert.equal(alpha.framesOf('callHalfClose').length, 0);

    alpha.send({
      frame: {
        case: 'callCredit',
        value: { callId: start.callId, messages: count - initialCallCredit },
      },
    });
    await until(
      () => alpha.framesOf('callHalfClose').length > 0,
      'CallHalfClose',
    );

    assert.deepEqual(
      alpha
        .framesOf('callMessage')
        .map(({ payload }) =>
          textOf(fromBinary(CompleteRequestSchema, payload)),
        ),
      sent,
    );

    alpha.send({
      frame: {
        case: 'callMessage',
        value: {
          callId: start.callId,
          payload: toBinary(
            CompleteResponseSchema,
            create(CompleteResponseSchema, {
              providerFinished: { text: 'done', finishReason: 'stop' },
            }),
          ),
        },
      },
    });
    alpha.send({
      frame: {
        case: 'callEnd',
        value: { callId: start.callId, status: { code: 0 } },
      },
    });

    const response = await within(call, 'complete');

    assert.equal(response.providerFinished?.text, 'done');
  });

  test('a bundle sending a CallMessage beyond its credit is rejected with protocol_violation', async (t) => {
    const env = await setup(t);
    const settings = await env.fake('settings', [SettingsService]);
    const app = await env.start('app');
    const responses = env
      .raw(SettingsService, app.token)
      .watch({ id: 'acme.thing/v1' })
      [Symbol.asyncIterator]();

    // Starts the call and reads nothing after its first message.
    void responses.next().catch(() => {});
    await until(
      () => settings.framesOf('callStart').length > 0,
      'the call to reach the provider',
    );

    const [start] = settings.framesOf('callStart');

    assert.ok(start !== undefined);

    // Messages of 1 MiB, so the caller's HTTP/2 window fills and the router
    // cannot pass them on (nor grant credit) as fast as they come.
    const payload = toBinary(
      WatchResponseSchema,
      create(WatchResponseSchema, {
        settingsEntry: {
          ...entry(1).settingsEntry,
          value: {
            typeUrl: 'type.googleapis.com/google.protobuf.Empty',
            value: new Uint8Array(mebibyte),
          },
        },
      }),
    );

    // Far more than the credit, in one burst, before any CallCredit.
    for (let i = 0; i < initialCallCredit * 3; i += 1) {
      settings.send({
        frame: {
          case: 'callMessage',
          value: { callId: start.callId, payload },
        },
      });
    }

    await until(() => env.invalid.length > 0, 'onInvalid');
    await until(() => settings.outcome !== undefined, 'the stream to close');

    assert.deepEqual(
      settings.framesOf('rejected').map(({ reason }) => reason),
      ['protocol_violation'],
    );
    assert.equal(env.invalid[0]?.key, settings.key);
    assert.equal(env.invalid[0]?.reason, 'invalid_bundle');
  });
});

// ---------------------------------------------------------------------------
// Size (T2.12; section 3, "Size")

describe('sizes', () => {
  test('a client stream of 10,000 messages crosses the router', async (t) => {
    const env = await setup(t);
    const total = 10_000;
    let received = 0;
    let inOrder = true;

    await env.start('alpha', [
      partial(ProviderService, {
        complete: async (requests) => {
          for await (const request of requests) {
            inOrder &&= textOf(request) === String(received);
            received += 1;
          }

          return {
            providerFinished: { text: String(received), finishReason: 'stop' },
          };
        },
      }),
    ]);
    const app = await env.start('app');

    const response = await within(
      app
        .context()
        .services.use(ProviderService, { provider: 'alpha' })
        .complete(
          (async function* () {
            for (let i = 0; i < total; i += 1) {
              yield messageItem(String(i));
            }
          })(),
        ),
      'complete',
      60_000,
    );

    assert.equal(response.providerFinished?.text, String(total));
    assert.equal(received, total);
    assert.ok(inOrder, 'the messages arrived in order');
  });

  /** Sixteen chunks of 1 MiB, each of one letter: 16 MiB in all. */
  const chunks = Array.from({ length: 16 }, (_, i) =>
    String.fromCharCode(97 + i).repeat(mebibyte),
  );
  const value = chunks.join('');

  test('a 16 MiB value crosses from caller to provider in 1 MiB chunks', async (t) => {
    const env = await setup(t);
    const received: string[] = [];

    await env.start('alpha', [
      partial(ProviderService, {
        complete: async (requests) => {
          for await (const request of requests) {
            received.push(textOf(request));
          }

          const whole = received.join('');

          return {
            providerFinished: {
              text: `${whole.length}:${sha256(whole)}`,
              finishReason: 'stop',
            },
          };
        },
      }),
    ]);
    const app = await env.start('app');

    const response = await within(
      app
        .context()
        .services.use(ProviderService, { provider: 'alpha' })
        .complete(
          (async function* () {
            for (const chunk of chunks) {
              yield messageItem(chunk);
            }
          })(),
        ),
      'complete',
      30_000,
    );

    assert.equal(
      response.providerFinished?.text,
      `${16 * mebibyte}:${sha256(value)}`,
    );
    assert.deepEqual(
      received.map((chunk) => chunk.length),
      chunks.map(() => mebibyte),
    );
  });

  test('a 16 MiB value crosses from provider to caller in 1 MiB chunks', async (t) => {
    const env = await setup(t);

    await env.start('alpha', [
      partial(ProviderService, {
        stream: async function* (requests) {
          for await (const _request of requests) {
            for (const chunk of chunks) {
              yield deltaResponse(chunk);
            }
          }
        },
      }),
    ]);
    const app = await env.start('app');
    const received: string[] = [];

    await within(
      (async () => {
        for await (const response of app
          .context()
          .services.use(ProviderService, { provider: 'alpha' })
          .stream(
            (async function* () {
              yield messageItem('send the value');
            })(),
          )) {
          received.push(deltaOf(response) ?? '');
        }
      })(),
      'the stream',
      30_000,
    );

    assert.deepEqual(
      received.map((chunk) => chunk.length),
      chunks.map(() => mebibyte),
    );
    assert.equal(sha256(received.join('')), sha256(value));
  });

  test("a request message over 4 MiB is refused by the caller's SDK with limit_exceeded", async (t) => {
    const env = await setup(t);
    let received = 0;

    await env.start('alpha', [
      partial(ProviderService, {
        complete: async (requests) => {
          for await (const _request of requests) {
            received += 1;
          }

          return { providerFinished: { text: 'done', finishReason: 'stop' } };
        },
      }),
    ]);
    const app = await env.start('app');

    const error = await failureOf(
      app
        .context()
        .services.use(ProviderService, { provider: 'alpha' })
        .complete(
          (async function* () {
            yield messageItem('x'.repeat(maxMessageBytes + 1));
          })(),
        ),
    );

    assertFailure(error, Code.ResourceExhausted, 'limit_exceeded');
    assert.equal(received, 0);
  });

  test("a response message over 4 MiB is refused by the provider's SDK with limit_exceeded", async (t) => {
    const env = await setup(t);

    await env.start('alpha', [
      partial(ProviderService, {
        complete: async (requests) => {
          for await (const _request of requests) {
            // Reads the request to its end.
          }

          return {
            providerFinished: {
              text: 'x'.repeat(maxMessageBytes + 1),
              finishReason: 'stop',
            },
          };
        },
      }),
    ]);
    const app = await env.start('app');

    const error = await failureOf(
      app
        .context()
        .services.use(ProviderService, { provider: 'alpha' })
        .complete(
          (async function* () {
            yield messageItem('hello');
          })(),
        ),
    );

    assertFailure(error, Code.ResourceExhausted, 'limit_exceeded');
  });

  // Section 3, "Size", item 2: `runtime.threads/v1.WatchThread`'s snapshot
  // stops adding events before it would pass 3 MiB; the remaining events
  // follow as `event` items. 64 events of 100 KiB are 6.25 MiB, more than one
  // snapshot may hold and more than one message may hold (4 MiB).
  const snapshotLimit = 3 * mebibyte;
  const eventCount = 64;
  const events: readonly WatchEvent[] = Array.from(
    { length: eventCount },
    (_, i) => ({
      sequence: i + 1,
      payload: Uint8Array.from(
        { length: 100 * 1024 },
        (_, j) => (i * 31 + j) & 0xff,
      ),
    }),
  );
  /** The binary size of a `WatchThreadResponse`. */
  const encodedSize = (item: object): number =>
    toBinary(
      WatchThreadResponseSchema,
      create(
        WatchThreadResponseSchema,
        item as MessageInitShape<typeof WatchThreadResponseSchema>,
      ),
    ).length;

  test('a WatchThread snapshot over 3 MiB arrives as a snapshot of at most 3 MiB and event items', async (t) => {
    const env = await setup(t, resolveSnapshotHost());

    await env.start('threads', [
      partial(ThreadsService, {
        watchThread: async function* () {
          const snapshot: WatchEvent[] = [];

          for (const event of events) {
            const size = encodedSize({
              item: {
                case: 'snapshot',
                value: { events: [...snapshot, event] },
              },
            });

            if (size > snapshotLimit) {
              break;
            }

            snapshot.push(event);
          }

          yield { item: { case: 'snapshot', value: { events: snapshot } } };

          for (const event of events.slice(snapshot.length)) {
            yield { item: { case: 'event', value: event } };
          }
        },
      } as unknown as Partial<ServiceImpl<typeof ThreadsService>>),
    ]);
    const app = await env.start('app');
    const client = app
      .context()
      .services.use(ThreadsService) as unknown as ThreadsClient;
    const items: WatchThreadItem[] = [];

    await within(
      (async () => {
        for await (const item of client.watchThread({ threadId: 't1' })) {
          items.push(item);
        }
      })(),
      'the watch',
      30_000,
    );

    const [first, ...rest] = items;

    assert.ok(first !== undefined, 'the watch answered an item');
    assert.equal(first.item.case, 'snapshot', 'the first item is a snapshot');

    const snapshotBytes = encodedSize(first);

    assert.ok(
      snapshotBytes <= snapshotLimit,
      `the snapshot is ${snapshotBytes} bytes`,
    );
    assert.ok(
      snapshotBytes < maxMessageBytes,
      `the snapshot is ${snapshotBytes} bytes`,
    );
    assert.deepEqual(
      rest.map(({ item }) => item.case),
      rest.map(() => 'event'),
      'every item after the snapshot is an event',
    );

    const received = [
      ...(first.item.case === 'snapshot' ? first.item.value.events : []),
      ...rest.flatMap(({ item }) =>
        item.case === 'event' ? [item.value] : [],
      ),
    ];

    assert.deepEqual(
      received.map(({ sequence }) => sequence),
      events.map(({ sequence }) => sequence),
      'the snapshot and the event items hold every event, in order',
    );

    for (const [i, event] of received.entries()) {
      assert.ok(
        Buffer.from(event.payload).equals(
          Buffer.from(events[i]?.payload ?? []),
        ),
        `event ${event.sequence} arrived byte-identical`,
      );
    }
  });
});
