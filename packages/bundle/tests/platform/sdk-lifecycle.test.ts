// The host SDK's side of the control stream (spec
// `docs/designs/grpc-processes.md`, section 5, section 7 "Spawn" and "A bundle
// without its host", section 10 and A61; T2.1, SDK side): `startBundle` reads
// the spawn environment, says Hello, answers Activate, HealthCheck and Stop,
// and exits with code 70 when its host is gone. Most tests run `startBundle`
// in this process against a real router listener, or against a fake host (a
// Connect server of `BundleHostService`) where the router does not show what
// the bundle sent. The last tests spawn the fixture `tests/fixtures/alive`,
// whose `main.ts` calls `runBundle`, to check the codes the process exits with.

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import http from 'node:http';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import test, { describe, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  create,
  type DescService,
  type MessageInitShape,
} from '@bufbuild/protobuf';
import type { ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';

import { ContractError } from '../../src/contracts/error.js';
import {
  BundleHostService,
  type ConnectRequest,
  type ConnectResponse,
  ConnectResponseSchema,
} from '../../src/contracts/gen/doric/platform/v1/control_pb.js';
import { RegionsService } from '../../src/contracts/gen/doric/regions/v1/regions_pb.js';
import {
  file_doric_tools_v1_tools,
  ToolsService,
} from '../../src/contracts/gen/doric/tools/v1/tools_pb.js';
import { fromStatus, toStatus } from '../../src/contracts/status.js';
import {
  type BundleDefinition,
  EXIT_HOST_GONE,
  EXIT_STOPPED,
  type HostContext,
  HostGoneError,
  type HostGoneReason,
  startBundle,
} from '../../src/index.js';
import { createCatalogIndex } from '../../src/platform/catalog-index.js';
import {
  type InstanceKey,
  InstanceTable,
} from '../../src/platform/router/instances.js';
import {
  type Router,
  startRouter,
} from '../../src/platform/router/listener.js';
import {
  type Timings,
  timings,
} from '../../src/platform/supervisor/timings.js';

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
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `predicate` until it holds; fails the test after `timeoutMs`. */
const until = async (
  predicate: () => boolean,
  what: string,
  timeoutMs = 3_000,
): Promise<void> => {
  const deadline = performance.now() + timeoutMs;

  while (!predicate()) {
    if (performance.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }

    await sleep(5);
  }
};

/** Resolves with `promise`'s value; fails the test after `timeoutMs`. */
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

const echo = {
  bundleId: 'acme.echo',
  version: '1.2.3',
  generation: 3,
  incarnation: 2,
} as const;
const echoKey: InstanceKey = 'acme.echo/3/2';
const echoInstance = {
  bundleId: echo.bundleId,
  generation: echo.generation,
  incarnation: echo.incarnation,
};

/** The spawn environment of section 7, "Spawn". */
const spawnEnv = (
  port: number,
  token: string,
  instance: {
    readonly bundleId: string;
    readonly generation: number;
    readonly incarnation: number;
  } = echoInstance,
): Record<string, string | undefined> => ({
  DORIC_ROUTER_URL: `http://127.0.0.1:${port}`,
  DORIC_INSTANCE_TOKEN: token,
  DORIC_BUNDLE_ID: instance.bundleId,
  DORIC_GENERATION: String(instance.generation),
  DORIC_INCARNATION: String(instance.incarnation),
});

/** An `exit` that records its codes instead of ending the process. */
const recordExits = (): {
  readonly codes: number[];
  readonly exit: (code: number) => void;
} => {
  const codes: number[] = [];

  return { codes, exit: (code) => codes.push(code) };
};

/** Asserts `startBundle` rejected with a `HostGoneError` of `reason`. */
const isHostGone =
  (reason: HostGoneReason) =>
  (error: unknown): true => {
    assert.ok(
      error instanceof HostGoneError,
      `expected a HostGoneError: ${error}`,
    );
    assert.equal(error.reason, reason);

    return true;
  };

interface RouterEnv {
  readonly router: Router;
  readonly table: InstanceTable;
  readonly invalid: string[];
  readonly lost: string[];
  readonly health: InstanceKey[];
}

/** Starts a real router listener, closed in `after`. */
const setupRouter = async (
  t: TestContext,
  overrides: Partial<Timings> = {},
): Promise<RouterEnv> => {
  const table = new InstanceTable();
  const invalid: string[] = [];
  const lost: string[] = [];
  const health: InstanceKey[] = [];
  const router = await startRouter({
    index: createCatalogIndex([file_doric_tools_v1_tools]),
    instances: table,
    timings: { ...testTimings, ...overrides },
    diagnostics: {
      health: (key) => health.push(key),
      hostStalled: () => {},
      registrationReplay: () => {},
    },
    onInvalid: (key, reason, message) =>
      invalid.push(`${key} ${reason} ${message}`),
    onLost: (key, end) => lost.push(`${key} ${end.cause}`),
  });

  t.after(() => router.close());

  return { router, table, invalid, lost, health };
};

/** Issues `echo` and starts a bundle of `definition` against the router. */
const startEcho = <const T extends readonly DescService[] = []>(
  env: RouterEnv,
  definition: BundleDefinition<T>,
  exit: (code: number) => void,
): ReturnType<typeof startBundle> => {
  const { token } = env.table.issue(echo);

  return startBundle(definition, {
    env: spawnEnv(env.router.port, token),
    exit,
  });
};

/** A host the test drives frame by frame: one control stream at a time. */
interface FakeHost {
  readonly port: number;
  /** The `authorization` header of the last control stream. */
  readonly authorization: () => string | undefined;
  /** The frames the bundle sent. */
  readonly received: ConnectRequest[];
  send(frame: MessageInitShape<typeof ConnectResponseSchema>): void;
  framesOf<C extends NonNullable<ConnectRequest['frame']['case']>>(
    kind: C,
  ): Extract<ConnectRequest['frame'], { case: C }>['value'][];
}

/**
 * Starts a fake host, closed in `after`. It answers nothing on its own;
 * `onFrame` sees each frame the bundle sent as it arrives.
 */
const setupFakeHost = async (
  t: TestContext,
  onFrame?: (request: ConnectRequest) => void,
): Promise<FakeHost> => {
  const received: ConnectRequest[] = [];
  const queue: ConnectResponse[] = [];
  let authorization: string | undefined;
  let closing = false;
  let wake: (() => void) | undefined;

  const routes = (router: ConnectRouter): void => {
    router.service(BundleHostService, {
      connect: async function* (requests, context) {
        authorization = context.requestHeader.get('authorization') ?? undefined;

        void (async () => {
          try {
            for await (const request of requests) {
              received.push(request);
              onFrame?.(request);
            }
          } catch {
            // the stream failed: the frames read so far stay
          }
        })();

        for (;;) {
          const next = queue.shift();

          if (next !== undefined) {
            yield next;
            continue;
          }

          if (closing || context.signal.aborted) {
            return;
          }

          await new Promise<void>((resolve) => {
            wake = resolve;
            context.signal.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
          wake = undefined;
        }
      },
    });
  };
  const server = http2.createServer(connectNodeAdapter({ routes }));
  const sessions = new Set<http2.ServerHttp2Session>();

  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  t.after(
    () =>
      new Promise<void>((resolve) => {
        closing = true;
        wake?.();
        server.close(() => resolve());

        for (const session of sessions) {
          session.destroy();
        }
      }),
  );

  return {
    port: (server.address() as AddressInfo).port,
    authorization: () => authorization,
    received,
    send: (frame) => {
      queue.push(create(ConnectResponseSchema, frame));
      wake?.();
    },
    framesOf: (kind) =>
      received.flatMap((r) =>
        r.frame.case === kind ? [r.frame.value as never] : [],
      ),
  };
};

const notCalled = (): never => {
  throw new Error('not called');
};
const tools = [
  ToolsService,
  {
    register: notCalled,
    unregister: notCalled,
    list: notCalled,
    catalog: notCalled,
    execute: notCalled,
  },
] as const;
const regions = [
  RegionsService,
  { add: notCalled, remove: notCalled, items: notCalled, watch: notCalled },
] as const;

// ---------------------------------------------------------------------------
// The spawn environment and the Hello

describe('startBundle: the Hello', () => {
  test('reads DORIC_INSTANCE_TOKEN, sends it as the bearer token and deletes it from the env', async (t) => {
    const host = await setupFakeHost(t);
    const env = spawnEnv(host.port, 'the-token');
    const { codes, exit } = recordExits();

    void startBundle({ activate: () => {} }, { env, exit }).catch(() => {});

    await until(() => host.framesOf('hello').length > 0, 'the Hello');
    assert.equal(host.authorization(), 'Bearer the-token');
    assert.equal('DORIC_INSTANCE_TOKEN' in env, false);
    assert.equal(env.DORIC_BUNDLE_ID, echo.bundleId);
    assert.deepEqual(codes, []);
  });

  test('lists the services full names in order and the instance of the env', async (t) => {
    const host = await setupFakeHost(t);
    const { exit } = recordExits();

    void startBundle(
      { services: [regions, tools], activate: () => {} },
      { env: spawnEnv(host.port, 'the-token'), exit },
    ).catch(() => {});

    await until(() => host.framesOf('hello').length > 0, 'the Hello');

    const [hello] = host.framesOf('hello');

    assert.equal(hello?.protocolVersion, 1);
    assert.deepEqual(hello?.services, [
      'doric.regions.v1.RegionsService',
      'doric.tools.v1.ToolsService',
    ]);
    assert.equal(hello?.httpPort, 0);
    assert.equal(hello?.instance?.bundleId, echo.bundleId);
    assert.equal(hello?.instance?.generation, echo.generation);
    assert.equal(hello?.instance?.incarnation, echo.incarnation);
  });

  test('a Hello with no services lists none', async (t) => {
    const host = await setupFakeHost(t);
    const { exit } = recordExits();

    void startBundle(
      { activate: () => {} },
      { env: spawnEnv(host.port, 'the-token'), exit },
    ).catch(() => {});

    await until(() => host.framesOf('hello').length > 0, 'the Hello');
    assert.deepEqual(host.framesOf('hello')[0]?.services, []);
  });

  test('resolves on Accepted from a real router with the instance of the env', async (t) => {
    const env = await setupRouter(t);
    const { codes, exit } = recordExits();
    const running = await startEcho(
      env,
      { services: [tools], activate: () => {} },
      exit,
    );

    assert.deepEqual(running.instance, echoInstance);
    assert.equal(env.table.get(echoKey)?.state, 'connected');
    assert.deepEqual(env.invalid, []);
    assert.deepEqual(codes, []);
  });

  test('a service listed twice rejects with a TypeError without exit or stream', async (t) => {
    const host = await setupFakeHost(t);
    const { codes, exit } = recordExits();

    await assert.rejects(
      () =>
        startBundle(
          { services: [tools, regions, tools], activate: () => {} },
          { env: spawnEnv(host.port, 'the-token'), exit },
        ),
      TypeError,
    );
    await sleep(100);
    assert.deepEqual(codes, []);
    assert.deepEqual(host.received, []);
  });
});

// ---------------------------------------------------------------------------
// Health

describe('startBundle: health', () => {
  test('answers each HealthCheck with a HealthReply of the same nonce', async (t) => {
    const host = await setupFakeHost(t);
    const { codes, exit } = recordExits();
    const started = startBundle(
      { activate: () => {} },
      { env: spawnEnv(host.port, 'the-token'), exit },
    );

    host.send({ frame: { case: 'accepted', value: { protocolVersion: 1 } } });
    await within(started, 'startBundle to resolve');
    host.send({ frame: { case: 'healthCheck', value: { nonce: 42n } } });
    host.send({ frame: { case: 'healthCheck', value: { nonce: 7n } } });
    await until(() => host.framesOf('healthReply').length >= 2, 'two replies');
    assert.deepEqual(
      host.framesOf('healthReply').map((reply) => reply.nonce),
      [42n, 7n],
    );
    assert.deepEqual(codes, []);
  });

  test('the router sees every health check answered', async (t) => {
    const env = await setupRouter(t, {
      healthIntervalMs: 30,
      healthTimeoutMs: 1_000,
    });
    const { exit } = recordExits();

    await startEcho(env, { activate: () => {} }, exit);
    assert.equal((await env.router.sendActivate(echoKey)).code, 0);
    await until(() => env.health.length >= 3, 'three health replies');
    assert.ok(env.health.every((key) => key === echoKey));
    assert.deepEqual(env.invalid, []);
  });
});

// ---------------------------------------------------------------------------
// Activate

describe('startBundle: Activate', () => {
  test('activate resolving answers code 0 and receives the context', async (t) => {
    const env = await setupRouter(t);
    const { exit } = recordExits();
    const seen: { instance: unknown; aborted: boolean }[] = [];

    await startEcho(
      env,
      {
        activate: async (context) => {
          await sleep(10);
          seen.push({
            instance: { ...context.instance },
            aborted: context.signal.aborted,
          });
        },
      },
      exit,
    );

    const status = await env.router.sendActivate(echoKey);

    assert.equal(status.code, 0);
    assert.deepEqual(seen, [{ instance: echoInstance, aborted: false }]);
    assert.equal(env.table.get(echoKey)?.state, 'active');
  });

  test('activate throwing a ContractError answers its status', async (t) => {
    const env = await setupRouter(t);
    const { codes, exit } = recordExits();
    const error = new ContractError('not_found', 'No store named main.', {
      store: 'main',
    });

    await startEcho(
      env,
      {
        activate: () => {
          throw error;
        },
      },
      exit,
    );

    const status = await env.router.sendActivate(echoKey);

    assert.deepEqual(status, toStatus(error));
    assert.equal(fromStatus(status).code, 'not_found');
    assert.deepEqual(codes, []);
  });

  test('activate rejecting with a plain Error answers internal with its message', async (t) => {
    const env = await setupRouter(t);
    const { codes, exit } = recordExits();

    await startEcho(
      env,
      {
        activate: () => Promise.reject(new Error('the disk is full')),
      },
      exit,
    );

    const status = await env.router.sendActivate(echoKey);
    const decoded = fromStatus(status);

    assert.notEqual(status.code, 0);
    assert.equal(decoded.code, 'internal');
    assert.equal(decoded.message, 'the disk is full');
    assert.deepEqual(codes, []);
  });
});

// ---------------------------------------------------------------------------
// Stop

describe('startBundle: Stop', () => {
  test('aborts the signal, runs deactivate with the same context, then exits 0', async (t) => {
    const env = await setupRouter(t);
    const { codes, exit } = recordExits();
    const events: string[] = [];
    let activated: HostContext | undefined;
    const running = await startEcho(
      env,
      {
        activate: (context) => {
          activated = context;
          context.signal.addEventListener('abort', () => events.push('abort'));
          events.push('activate');
        },
        deactivate: (context) => {
          events.push(
            `deactivate aborted=${context.signal.aborted} same=${context === activated}`,
          );
        },
      },
      exit,
    );

    assert.equal((await env.router.sendActivate(echoKey)).code, 0);

    const started = performance.now();

    await env.router.sendStop(echoKey);

    assert.ok(
      performance.now() - started < testTimings.stopTimeoutMs,
      'the stream ended before the stop timeout',
    );
    assert.equal(await within(running.exited, 'exited'), EXIT_STOPPED);
    assert.deepEqual(events, [
      'activate',
      'abort',
      'deactivate aborted=true same=true',
    ]);
    assert.deepEqual(codes, [EXIT_STOPPED]);
    assert.deepEqual(env.invalid, []);
    assert.deepEqual(env.lost, []);
  });

  test('answers Stop with StopResult before it exits 0', async (t) => {
    const host = await setupFakeHost(t);
    const { codes, exit } = recordExits();
    const started = startBundle(
      { activate: () => {} },
      { env: spawnEnv(host.port, 'the-token'), exit },
    );

    host.send({ frame: { case: 'accepted', value: { protocolVersion: 1 } } });

    const running = await within(started, 'startBundle to resolve');

    host.send({ frame: { case: 'activate', value: {} } });
    await until(
      () => host.framesOf('activateResult').length > 0,
      'ActivateResult',
    );
    host.send({ frame: { case: 'stop', value: {} } });
    await until(() => host.framesOf('stopResult').length > 0, 'StopResult');
    assert.equal(await within(running.exited, 'exited'), EXIT_STOPPED);
    assert.deepEqual(codes, [EXIT_STOPPED]);
  });

  test('deactivate does not run when activate failed; Stop still exits 0', async (t) => {
    const env = await setupRouter(t);
    const { codes, exit } = recordExits();
    let deactivated = 0;
    const running = await startEcho(
      env,
      {
        activate: () => {
          throw new Error('no config');
        },
        deactivate: () => {
          deactivated += 1;
        },
      },
      exit,
    );

    assert.notEqual((await env.router.sendActivate(echoKey)).code, 0);
    await env.router.sendStop(echoKey);
    assert.equal(await within(running.exited, 'exited'), EXIT_STOPPED);
    assert.equal(deactivated, 0);
    assert.deepEqual(codes, [EXIT_STOPPED]);
  });

  test('a failing deactivate still exits 0', async (t) => {
    const env = await setupRouter(t);
    const { codes, exit } = recordExits();
    const running = await startEcho(
      env,
      {
        activate: () => {},
        deactivate: () => Promise.reject(new Error('flush failed')),
      },
      exit,
    );

    assert.equal((await env.router.sendActivate(echoKey)).code, 0);
    await env.router.sendStop(echoKey);
    assert.equal(await within(running.exited, 'exited'), EXIT_STOPPED);
    assert.deepEqual(codes, [EXIT_STOPPED]);
  });
});

// ---------------------------------------------------------------------------
// The HTTP prefix's listener (section 11, "The HTTP prefix")

/** A plain HTTP server, not listening; closed in `after` if it still is. */
const httpServerOf = (t: TestContext): http.Server => {
  const server = http.createServer((_request, response) => {
    response.end('prefix');
  });

  t.after(() => {
    if (server.listening) {
      server.closeAllConnections();
      server.close();
    }
  });

  return server;
};

describe('startBundle: httpServer', () => {
  test('binds httpServer to 127.0.0.1:0 before the Hello and sends its port as httpPort', async (t) => {
    const server = httpServerOf(t);
    const atHello: boolean[] = [];
    const host = await setupFakeHost(t, (request) => {
      if (request.frame.case === 'hello') {
        atHello.push(server.listening);
      }
    });
    const { codes, exit } = recordExits();

    void startBundle(
      { httpServer: server, activate: () => {} },
      { env: spawnEnv(host.port, 'the-token'), exit },
    ).catch(() => {});

    await until(() => host.framesOf('hello').length > 0, 'the Hello');

    const address = server.address() as AddressInfo | null;

    assert.deepEqual(atHello, [true], 'listening when the Hello arrived');
    assert.ok(address !== null, 'the server listens');
    assert.equal(address.address, '127.0.0.1');
    assert.notEqual(address.port, 0);
    assert.equal(host.framesOf('hello')[0]?.httpPort, address.port);
    assert.deepEqual(codes, []);
  });

  test('closes httpServer after deactivate settled and before StopResult', async (t) => {
    const server = httpServerOf(t);
    const events: string[] = [];
    const host = await setupFakeHost(t, (request) => {
      if (request.frame.case === 'stopResult') {
        events.push(`stopResult listening=${server.listening}`);
      }
    });
    const { codes, exit } = recordExits();
    const started = startBundle(
      {
        httpServer: server,
        activate: () => {},
        deactivate: async () => {
          events.push(`deactivate listening=${server.listening}`);
          await sleep(50);
          events.push(`deactivated listening=${server.listening}`);
        },
      },
      { env: spawnEnv(host.port, 'the-token'), exit },
    );

    host.send({ frame: { case: 'accepted', value: { protocolVersion: 1 } } });

    const running = await within(started, 'startBundle to resolve');

    host.send({ frame: { case: 'activate', value: {} } });
    await until(
      () => host.framesOf('activateResult').length > 0,
      'ActivateResult',
    );
    host.send({ frame: { case: 'stop', value: {} } });
    await until(() => host.framesOf('stopResult').length > 0, 'StopResult');
    assert.equal(await within(running.exited, 'exited'), EXIT_STOPPED);
    assert.deepEqual(events, [
      'deactivate listening=true',
      'deactivated listening=true',
      'stopResult listening=false',
    ]);
    assert.deepEqual(codes, [EXIT_STOPPED]);
  });

  test('an httpServer already listening rejects with a TypeError without exit or stream', async (t) => {
    const server = httpServerOf(t);
    const host = await setupFakeHost(t);
    const { codes, exit } = recordExits();

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    await assert.rejects(
      () =>
        startBundle(
          { httpServer: server, activate: () => {} },
          { env: spawnEnv(host.port, 'the-token'), exit, helloTimeoutMs: 500 },
        ),
      TypeError,
    );
    await sleep(100);
    assert.deepEqual(codes, []);
    assert.deepEqual(host.received, []);
  });

  test('an httpServer that cannot bind rejects with the listen error without exit or stream', async (t) => {
    const server = httpServerOf(t);
    const host = await setupFakeHost(t);
    const { codes, exit } = recordExits();
    const failure = Object.assign(new Error('listen EADDRNOTAVAIL'), {
      code: 'EADDRNOTAVAIL',
    });

    // The operating system refusing the address, emitted as `listen` does.
    server.listen = (() => {
      process.nextTick(() => server.emit('error', failure));

      return server;
    }) as typeof server.listen;

    await assert.rejects(
      () =>
        startBundle(
          { httpServer: server, activate: () => {} },
          { env: spawnEnv(host.port, 'the-token'), exit, helloTimeoutMs: 500 },
        ),
      (error: unknown) => error === failure,
    );
    await sleep(100);
    assert.deepEqual(codes, []);
    assert.deepEqual(host.received, []);
  });
});

// ---------------------------------------------------------------------------
// A bundle without its host: exit 70

describe('startBundle: the host is gone', () => {
  test('a rejected Hello rejects with reason rejected and exits 70', async (t) => {
    const env = await setupRouter(t);
    const { codes, exit } = recordExits();
    const { token } = env.table.issue(echo);

    await assert.rejects(
      () =>
        startBundle(
          { activate: () => {} },
          {
            env: spawnEnv(env.router.port, token, {
              ...echoInstance,
              incarnation: echo.incarnation + 1,
            }),
            exit,
          },
        ),
      isHostGone('rejected'),
    );
    assert.deepEqual(codes, [EXIT_HOST_GONE]);
    assert.equal(env.table.get(echoKey)?.state, 'invalid');
  });

  test('the stream ending after Accepted exits 70 and aborts the signal', async (t) => {
    const env = await setupRouter(t);
    const { codes, exit } = recordExits();
    let signal: AbortSignal | undefined;
    const running = await startEcho(
      env,
      {
        activate: (context) => {
          signal = context.signal;
        },
      },
      exit,
    );

    assert.equal((await env.router.sendActivate(echoKey)).code, 0);
    await env.router.close();
    assert.equal(await within(running.exited, 'exited'), EXIT_HOST_GONE);
    assert.deepEqual(codes, [EXIT_HOST_GONE]);
    assert.equal(signal?.aborted, true);
  });

  test('no Accepted within helloTimeoutMs rejects with hello_timeout and exits 70', async (t) => {
    const host = await setupFakeHost(t);
    const { codes, exit } = recordExits();
    const started = performance.now();

    await assert.rejects(
      () =>
        startBundle(
          { activate: () => {} },
          {
            env: spawnEnv(host.port, 'the-token'),
            exit,
            helloTimeoutMs: 200,
          },
        ),
      isHostGone('hello_timeout'),
    );

    const elapsed = performance.now() - started;

    assert.ok(elapsed >= 200, `rejected after ${elapsed} ms, not before 200`);
    assert.ok(elapsed < 1_200, `rejected after ${elapsed} ms, within 1 s`);
    assert.equal(host.framesOf('hello').length, 1);
    assert.deepEqual(codes, [EXIT_HOST_GONE]);
  });

  for (const variable of [
    'DORIC_ROUTER_URL',
    'DORIC_INSTANCE_TOKEN',
    'DORIC_BUNDLE_ID',
    'DORIC_GENERATION',
    'DORIC_INCARNATION',
  ]) {
    test(`a missing ${variable} rejects with reason environment and exits 70`, async (t) => {
      const host = await setupFakeHost(t);
      const { codes, exit } = recordExits();
      const env = spawnEnv(host.port, 'the-token');

      delete env[variable];

      await assert.rejects(
        () => startBundle({ activate: () => {} }, { env, exit }),
        (error: unknown) => {
          isHostGone('environment')(error);
          assert.match((error as Error).message, new RegExp(variable));

          return true;
        },
      );
      assert.deepEqual(codes, [EXIT_HOST_GONE]);
      assert.deepEqual(host.received, []);
    });
  }

  test('a malformed DORIC_GENERATION rejects with reason environment and exits 70', async (t) => {
    const host = await setupFakeHost(t);
    const { codes, exit } = recordExits();

    await assert.rejects(
      () =>
        startBundle(
          { activate: () => {} },
          {
            env: { ...spawnEnv(host.port, 'the-token'), DORIC_GENERATION: 'x' },
            exit,
          },
        ),
      isHostGone('environment'),
    );
    assert.deepEqual(codes, [EXIT_HOST_GONE]);
    assert.deepEqual(host.received, []);
  });
});

// ---------------------------------------------------------------------------
// runBundle in its own process (at most one fixture process alive at once)

const alive = fileURLToPath(
  new URL('../fixtures/alive/main.js', import.meta.url),
);

/** Spawns the fixture with the spawn environment; killed in `after`. */
const spawnAlive = (
  t: TestContext,
  env: RouterEnv,
): { readonly child: ChildProcess; readonly code: Promise<number | null> } => {
  const { token } = env.table.issue(echo);
  const child = spawn(process.execPath, [alive], {
    env: { PATH: process.env.PATH, ...spawnEnv(env.router.port, token) },
    stdio: 'ignore',
  });
  const code = new Promise<number | null>((resolve) =>
    child.once('exit', (exitCode) => resolve(exitCode)),
  );

  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  });

  return { child, code };
};

/** Waits until the process's Hello is accepted; fails if it exits first. */
const connected = async (
  env: RouterEnv,
  child: ChildProcess,
): Promise<void> => {
  await until(
    () =>
      env.table.get(echoKey)?.state === 'connected' || child.exitCode !== null,
    'the process to connect',
    5_000,
  );
  assert.equal(
    child.exitCode,
    null,
    `the process exited with ${child.exitCode} before it connected`,
  );
};

describe('runBundle', () => {
  test('exits with code 0 after Stop', async (t) => {
    const env = await setupRouter(t);
    const { child, code } = spawnAlive(t, env);

    await connected(env, child);
    assert.equal((await env.router.sendActivate(echoKey)).code, 0);
    await env.router.sendStop(echoKey);
    assert.equal(await within(code, 'the process to exit', 5_000), 0);
  });

  test('exits with code 70 when the router closes', async (t) => {
    const env = await setupRouter(t);
    const { child, code } = spawnAlive(t, env);

    await connected(env, child);
    await env.router.close();
    assert.equal(await within(code, 'the process to exit', 5_000), 70);
  });
});
