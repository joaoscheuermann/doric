// The router listener's control side (spec `docs/designs/grpc-processes.md`,
// section 2 "The token" and "The router address", section 5, section 7
// "Instance states" and "Timings"): the instance table, the authentication
// of every RPC, the Hello, the protocol violations, activation, health and a
// stalled host, a lost stream and Stop (T2.1, T2.2, T2.13). The router is
// driven by an in-process fake bundle, a Connect gRPC client over HTTP/2.

import assert from 'node:assert/strict';
import test, { describe, type TestContext } from 'node:test';

import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import {
  createGrpcTransport,
  Http2SessionManager,
} from '@connectrpc/connect-node';

import {
  BundleHostService,
  type ConnectRequest,
  ConnectRequestSchema,
  type ConnectResponse,
} from '../../src/contracts/gen/doric/platform/v1/control_pb.js';
import {
  file_doric_tools_v1_tools,
  ToolsService,
} from '../../src/contracts/gen/doric/tools/v1/tools_pb.js';
import { fromConnectError } from '../../src/contracts/status.js';
import { createCatalogIndex } from '../../src/platform/catalog-index.js';
import { RouterBindingError } from '../../src/platform/router/bind.js';
import type {
  InvalidReason,
  StreamEnd,
} from '../../src/platform/router/control.js';
import {
  type InstanceKey,
  type InstanceRecord,
  type InstanceState,
  InstanceTable,
  instanceKey,
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

/** Blocks the whole event loop of the process for `ms`. */
const blockLoop = (ms: number): void => {
  const end = performance.now() + ms;

  while (performance.now() < end) {
    // busy wait
  }
};

type FrameCase = NonNullable<ConnectResponse['frame']['case']>;
type FrameValue<C extends FrameCase> = Extract<
  ConnectResponse['frame'],
  { case: C }
>['value'];

type ConnectClient = ReturnType<typeof createClient<typeof BundleHostService>>;

/** One control stream of a fake bundle. */
class FakeBundle {
  readonly frames: ConnectResponse[] = [];
  /** Set when the response stream ended; `error` when it failed. */
  outcome: { readonly error?: unknown } | undefined;
  /** Called synchronously for every frame the router sends. */
  onFrame: ((frame: ConnectResponse) => void) | undefined;

  private readonly queue: (ConnectRequest | 'end')[] = [];
  private wake: (() => void) | undefined;

  constructor(client: ConnectClient, token: string | undefined) {
    const headers: Record<string, string> =
      token === undefined ? {} : { authorization: `Bearer ${token}` };

    void this.run(client.connect(this.requests(), { headers }));
  }

  send(frame: MessageInitShape<typeof ConnectRequestSchema>): void {
    this.queue.push(create(ConnectRequestSchema, frame));
    this.wake?.();
  }

  /** Sends a ready message as is, unknown fields included. */
  sendRaw(frame: ConnectRequest): void {
    this.queue.push(frame);
    this.wake?.();
  }

  /** Half-closes the request stream: the bundle closes its control stream. */
  end(): void {
    this.queue.push('end');
    this.wake?.();
  }

  sendHello(
    instance: Omit<InstanceRecord, 'state' | 'version'>,
    protocolVersion = 1,
  ): void {
    this.send({
      frame: {
        case: 'hello',
        value: {
          protocolVersion,
          instance: {
            bundleId: instance.bundleId,
            generation: instance.generation,
            incarnation: instance.incarnation,
          },
          services: [],
          httpPort: 0,
        },
      },
    });
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

interface Env {
  readonly router: Router;
  readonly table: InstanceTable;
  readonly invalid: {
    key: InstanceKey;
    reason: InvalidReason;
    message: string;
  }[];
  readonly lost: { key: InstanceKey; end: StreamEnd }[];
  readonly health: { key: InstanceKey; latencyMs: number }[];
  readonly stalled: { key: InstanceKey; delayMs: number }[];
  readonly client: ConnectClient;
  readonly tools: ReturnType<typeof createClient<typeof ToolsService>>;
  readonly unknown: ReturnType<typeof createClient<typeof ToolsService>>;
  open(token: string | undefined): FakeBundle;
}

const index = createCatalogIndex([file_doric_tools_v1_tools]);

/** A copy of `ToolsService` under a name no index holds. */
const unknownService = (() => {
  const service = {
    ...ToolsService,
    typeName: 'doric.unknown.v1.UnknownService',
  } as typeof ToolsService;
  const list = { ...ToolsService.method.list, parent: service };

  return Object.assign(service, {
    methods: [list],
    method: { ...ToolsService.method, list },
  }) as typeof ToolsService;
})();

const setup = async (
  t: TestContext,
  overrides: Partial<Timings> = {},
): Promise<Env> => {
  const table = new InstanceTable();
  const invalid: Env['invalid'] = [];
  const lost: Env['lost'] = [];
  const health: Env['health'] = [];
  const stalled: Env['stalled'] = [];
  const router = await startRouter({
    index,
    instances: table,
    timings: { ...testTimings, ...overrides },
    diagnostics: {
      health: (key, latencyMs) => health.push({ key, latencyMs }),
      hostStalled: (key, delayMs) => stalled.push({ key, delayMs }),
      registrationReplay: () => {},
    },
    onInvalid: (key, reason, message) => invalid.push({ key, reason, message }),
    onLost: (key, end) => lost.push({ key, end }),
  });
  const baseUrl = `http://127.0.0.1:${router.port}`;
  const sessionManager = new Http2SessionManager(baseUrl);
  const transport = createGrpcTransport({ baseUrl, sessionManager });

  t.after(async () => {
    await router.close();
    sessionManager.abort();
  });

  const client = createClient(BundleHostService, transport);

  return {
    router,
    table,
    invalid,
    lost,
    health,
    stalled,
    client,
    tools: createClient(ToolsService, transport),
    unknown: createClient(unknownService, transport),
    open: (token) => new FakeBundle(client, token),
  };
};

const echo = {
  bundleId: 'acme.echo',
  version: '1.2.3',
  generation: 1,
  incarnation: 1,
} as const;
const echoKey: InstanceKey = 'acme.echo/1/1';

/** Issues `echo`, opens its stream and waits for `Accepted`. */
const connectEcho = async (
  env: Env,
): Promise<{ bundle: FakeBundle; token: string }> => {
  const { token } = env.table.issue(echo);
  const bundle = env.open(token);

  bundle.sendHello(echo);
  await until(() => bundle.framesOf('accepted').length > 0, 'Accepted');

  return { bundle, token };
};

/** Answers every `Activate` with code 0. */
const answerActivate = (bundle: FakeBundle): void => {
  const previous = bundle.onFrame;

  bundle.onFrame = (frame) => {
    previous?.(frame);

    if (frame.frame.case === 'activate') {
      bundle.send({
        frame: { case: 'activateResult', value: { status: { code: 0 } } },
      });
    }
  };
};

/** Connects `echo` and activates it. */
const activeEcho = async (
  env: Env,
): Promise<{ bundle: FakeBundle; token: string }> => {
  const connected = await connectEcho(env);

  answerActivate(connected.bundle);

  const status = await env.router.sendActivate(echoKey);

  assert.equal(status.code, 0);
  assert.equal(env.table.get(echoKey)?.state, 'active');

  return connected;
};

/** Waits for the stream to fail and checks the gRPC code and Doric reason. */
const expectStreamError = async (
  bundle: FakeBundle,
  code: Code,
  reason: string,
): Promise<void> => {
  await until(() => bundle.outcome !== undefined, 'the stream to end');

  const error = bundle.outcome?.error;

  assert.ok(error instanceof ConnectError, `expected a ConnectError: ${error}`);
  assert.equal(error.code, code);
  assert.equal(fromConnectError(error).code, reason);
};

const expectCallError = async (
  call: Promise<unknown>,
  code: Code,
  reason: string,
): Promise<void> => {
  await assert.rejects(call, (error: unknown) => {
    assert.ok(
      error instanceof ConnectError,
      `expected a ConnectError: ${error}`,
    );
    assert.equal(error.code, code);
    assert.equal(fromConnectError(error).code, reason);

    return true;
  });
};

/** Checks the router declared `echo` invalid after a rejected frame. */
const expectRejected = async (
  env: Env,
  bundle: FakeBundle,
  reason: 'hello_mismatch' | 'unsupported_protocol' | 'protocol_violation',
): Promise<void> => {
  await until(() => env.invalid.length > 0, 'onInvalid');
  await until(() => bundle.outcome !== undefined, 'the stream to close');

  const rejected = bundle.framesOf('rejected');

  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.reason, reason);
  assert.equal(env.table.get(echoKey)?.state, 'invalid');
  assert.equal(env.invalid.length, 1);
  assert.equal(env.invalid[0]?.key, echoKey);
  assert.equal(env.invalid[0]?.reason, 'invalid_bundle');
  assert.ok(
    env.invalid[0]?.message.startsWith(reason),
    `message ${env.invalid[0]?.message} starts with ${reason}`,
  );
  assert.deepEqual(env.lost, []);
};

// ---------------------------------------------------------------------------
// The instance table

describe('instanceKey', () => {
  test('is <bundleId>/<generation>/<incarnation>', () => {
    assert.equal(
      instanceKey({ bundleId: 'acme.tools', generation: 3, incarnation: 2 }),
      'acme.tools/3/2',
    );
  });
});

describe('InstanceTable', () => {
  test('issue draws distinct 43-character base64url tokens', () => {
    const table = new InstanceTable();
    const a = table.issue(echo);
    const b = table.issue({ ...echo, incarnation: 2 });

    assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
    assert.match(b.token, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a.token, b.token);
  });

  test('issue adds the instance in the state spawned', () => {
    const table = new InstanceTable();

    table.issue(echo);

    assert.deepEqual(table.get(echoKey), { ...echo, state: 'spawned' });
    assert.equal(table.get('acme.echo/1/2'), undefined);
  });

  test('issue throws a TypeError for a key already in the table', () => {
    const table = new InstanceTable();

    table.issue(echo);

    assert.throws(() => table.issue({ ...echo, version: '9.9.9' }), TypeError);
  });

  test('byToken answers a snapshot of the record, undefined for an unknown token', () => {
    const table = new InstanceTable();
    const { token } = table.issue(echo);
    const before = table.byToken(token);

    table.setState(echoKey, 'connected');

    assert.deepEqual(before, { ...echo, state: 'spawned' });
    assert.deepEqual(table.byToken(token), { ...echo, state: 'connected' });
    assert.equal(table.byToken('A'.repeat(43)), undefined);
  });

  for (const revoked of ['stopped', 'lost', 'invalid'] as const) {
    test(`entering ${revoked} revokes: the record stays and no later state applies`, () => {
      const table = new InstanceTable();
      const { token } = table.issue(echo);

      table.setState(echoKey, 'active');
      table.setState(echoKey, revoked);
      table.setState(echoKey, 'active');

      assert.equal(table.byToken(token)?.state, revoked);
      assert.equal(table.get(echoKey)?.state, revoked);
    });
  }

  test('setState ignores a key not in the table', () => {
    const table = new InstanceTable();

    table.setState('acme.none/1/1', 'active');

    assert.equal(table.get('acme.none/1/1'), undefined);
  });
});

// ---------------------------------------------------------------------------
// Authentication (section 2, T2.13)

describe('router authentication', () => {
  test('Connect without a token: UNAUTHENTICATED invalid_instance_token', async (t) => {
    const env = await setup(t);
    const bundle = env.open(undefined);

    await expectStreamError(
      bundle,
      Code.Unauthenticated,
      'invalid_instance_token',
    );
  });

  test('Connect with an unknown token: UNAUTHENTICATED invalid_instance_token', async (t) => {
    const env = await setup(t);
    const bundle = env.open('A'.repeat(43));

    await expectStreamError(
      bundle,
      Code.Unauthenticated,
      'invalid_instance_token',
    );
  });

  for (const revoked of ['stopped', 'lost', 'invalid'] as InstanceState[]) {
    test(`Connect for a ${revoked} instance: UNAUTHENTICATED instance_revoked`, async (t) => {
      const env = await setup(t);
      const { token } = env.table.issue(echo);

      env.table.setState(echoKey, revoked);

      const bundle = env.open(token);

      await expectStreamError(bundle, Code.Unauthenticated, 'instance_revoked');
    });
  }

  test('a spawned instance calling a method of the index: FAILED_PRECONDITION not_connected', async (t) => {
    const env = await setup(t);
    const { token } = env.table.issue(echo);

    await expectCallError(
      env.tools.list({}, { headers: { authorization: `Bearer ${token}` } }),
      Code.FailedPrecondition,
      'not_connected',
    );
  });

  test('a second Connect with the same token: FAILED_PRECONDITION control_stream_open', async (t) => {
    const env = await setup(t);
    const { bundle, token } = await connectEcho(env);
    const second = env.open(token);

    await expectStreamError(
      second,
      Code.FailedPrecondition,
      'control_stream_open',
    );
    assert.equal(bundle.outcome, undefined);
    assert.equal(env.table.get(echoKey)?.state, 'connected');
  });

  test('a path neither Connect nor in the index: UNIMPLEMENTED unknown_contract', async (t) => {
    const env = await setup(t);
    const { token } = await connectEcho(env);

    await expectCallError(
      env.unknown.list({}, { headers: { authorization: `Bearer ${token}` } }),
      Code.Unimplemented,
      'unknown_contract',
    );
  });
});

// ---------------------------------------------------------------------------
// Hello (section 5, T2.1)

describe('router Hello', () => {
  test('a valid Hello is answered Accepted{protocolVersion: 1}; the instance is connected', async (t) => {
    const env = await setup(t);
    const { bundle } = await connectEcho(env);

    assert.equal(bundle.framesOf('accepted')[0]?.protocolVersion, 1);
    assert.equal(env.table.get(echoKey)?.state, 'connected');
    assert.deepEqual(env.invalid, []);
  });

  test('a Hello whose instance differs from the token: Rejected hello_mismatch, invalid', async (t) => {
    const env = await setup(t);
    const { token } = env.table.issue(echo);
    const bundle = env.open(token);

    bundle.sendHello({ ...echo, generation: 2 });

    await expectRejected(env, bundle, 'hello_mismatch');
  });

  test('a Hello with protocolVersion 2: Rejected unsupported_protocol, invalid', async (t) => {
    const env = await setup(t);
    const { token } = env.table.issue(echo);
    const bundle = env.open(token);

    bundle.sendHello(echo, 2);

    await expectRejected(env, bundle, 'unsupported_protocol');
  });
});

// ---------------------------------------------------------------------------
// Protocol violations (section 5)

describe('router protocol violations', () => {
  test('a frame before Hello: Rejected protocol_violation', async (t) => {
    const env = await setup(t);
    const { token } = env.table.issue(echo);
    const bundle = env.open(token);

    bundle.send({ frame: { case: 'healthReply', value: { nonce: 1n } } });

    await expectRejected(env, bundle, 'protocol_violation');
  });

  test('a second Hello: Rejected protocol_violation', async (t) => {
    const env = await setup(t);
    const { bundle } = await connectEcho(env);

    bundle.sendHello(echo);

    await expectRejected(env, bundle, 'protocol_violation');
  });

  test('a CallEnd for an unknown call id: Rejected protocol_violation', async (t) => {
    const env = await setup(t);
    const { bundle } = await connectEcho(env);

    bundle.send({
      frame: { case: 'callEnd', value: { callId: 42n, status: { code: 0 } } },
    });

    await expectRejected(env, bundle, 'protocol_violation');
  });

  test('an unknown oneof case: Rejected protocol_violation', async (t) => {
    const env = await setup(t);
    const { bundle } = await connectEcho(env);
    const frame = create(ConnectRequestSchema);

    // Field 1000, length-delimited, empty: a case this protocol does not know.
    frame.$unknown = [{ no: 1000, wireType: 2, data: new Uint8Array([0]) }];
    bundle.sendRaw(frame);

    await expectRejected(env, bundle, 'protocol_violation');
  });
});

// ---------------------------------------------------------------------------
// Activation (section 5, section 7)

describe('router activation', () => {
  test('sendActivate sends Activate; ActivateResult code 0 makes the instance active', async (t) => {
    const env = await setup(t);
    const { bundle } = await connectEcho(env);

    answerActivate(bundle);

    const status = await env.router.sendActivate(echoKey);

    assert.equal(bundle.framesOf('activate').length, 1);
    assert.equal(status.code, 0);
    assert.equal(env.table.get(echoKey)?.state, 'active');
  });

  test('sendActivate with no answer within the activation timeout resolves DEADLINE_EXCEEDED', async (t) => {
    const env = await setup(t, { activationTimeoutMs: 100 });

    await connectEcho(env);

    const status = await env.router.sendActivate(echoKey);

    assert.equal(status.code, Code.DeadlineExceeded);
    assert.notEqual(env.table.get(echoKey)?.state, 'active');
  });
});

// ---------------------------------------------------------------------------
// Health and a stalled host (section 7, T2.2)

describe('router health', () => {
  test('HealthChecks start once active, one per interval; replies are recorded', async (t) => {
    const env = await setup(t, {
      healthIntervalMs: 40,
      healthTimeoutMs: 2_000,
      stallThresholdMs: 2_000,
    });
    const { bundle } = await connectEcho(env);

    bundle.onFrame = (frame) => {
      if (frame.frame.case === 'healthCheck') {
        bundle.send({
          frame: {
            case: 'healthReply',
            value: { nonce: frame.frame.value.nonce },
          },
        });
      }
    };

    await sleep(200);
    assert.equal(
      bundle.framesOf('healthCheck').length,
      0,
      'no check while connected',
    );

    answerActivate(bundle);
    await env.router.sendActivate(echoKey);
    await until(
      () => bundle.framesOf('healthCheck').length >= 3,
      'three HealthChecks',
    );
    await until(() => env.health.length >= 1, 'a recorded health answer');

    const nonces = bundle.framesOf('healthCheck').map((c) => c.nonce);

    assert.equal(new Set(nonces).size, nonces.length, 'nonces differ');
    assert.equal(env.health[0]?.key, echoKey);
    assert.ok((env.health[0]?.latencyMs ?? -1) >= 0);
    assert.deepEqual(env.invalid, []);
    assert.deepEqual(env.stalled, []);
  });

  test('a missed HealthReply declares the instance invalid with health_timeout', async (t) => {
    const env = await setup(t, {
      healthIntervalMs: 40,
      healthTimeoutMs: 100,
      stallThresholdMs: 2_000,
    });

    await activeEcho(env);
    await until(() => env.invalid.length > 0, 'onInvalid');

    assert.equal(env.invalid.length, 1);
    assert.equal(env.invalid[0]?.key, echoKey);
    assert.equal(env.invalid[0]?.reason, 'health_timeout');
    assert.equal(env.table.get(echoKey)?.state, 'invalid');
    assert.deepEqual(env.lost, []);
  });

  test('a host loop blocked past the stall threshold reports hostStalled and invalidates no one', async (t) => {
    const env = await setup(t, {
      healthIntervalMs: 40,
      healthTimeoutMs: 100,
      stallThresholdMs: 50,
    });
    const { bundle } = await activeEcho(env);
    let blocked = false;

    bundle.onFrame = (frame) => {
      if (frame.frame.case !== 'healthCheck') {
        return;
      }

      if (!blocked) {
        // The first check goes unanswered while the whole loop is blocked.
        blocked = true;
        blockLoop(400);

        return;
      }

      bundle.send({
        frame: {
          case: 'healthReply',
          value: { nonce: frame.frame.value.nonce },
        },
      });
    };

    await until(() => env.stalled.length > 0, 'hostStalled');
    await sleep(400);

    assert.equal(env.stalled[0]?.key, echoKey);
    assert.ok(
      (env.stalled[0]?.delayMs ?? 0) > 50,
      `delay ${env.stalled[0]?.delayMs} exceeds the stall threshold`,
    );
    assert.deepEqual(env.invalid, []);
    assert.equal(env.table.get(echoKey)?.state, 'active');
  });

  test('a HealthReply that arrived while the host loop was blocked past the health timeout counts', async (t) => {
    const env = await setup(t, {
      healthIntervalMs: 40,
      healthTimeoutMs: 100,
      stallThresholdMs: 2_000,
    });
    const { bundle } = await activeEcho(env);
    let blocked = false;

    bundle.onFrame = (frame) => {
      if (frame.frame.case !== 'healthCheck') {
        return;
      }

      bundle.send({
        frame: {
          case: 'healthReply',
          value: { nonce: frame.frame.value.nonce },
        },
      });

      if (!blocked) {
        // The reply is written, then the whole loop blocks past the health
        // timeout, but less than the stall threshold, before reading it.
        blocked = true;
        setImmediate(() => blockLoop(400));
      }
    };

    await until(() => blocked, 'the blocked check');
    await sleep(600);

    assert.deepEqual(env.invalid, []);
    assert.deepEqual(env.stalled, []);
    assert.equal(env.table.get(echoKey)?.state, 'active');
  });
});

// ---------------------------------------------------------------------------
// The end of a control stream (section 7)

describe('router stream end', () => {
  test('the bundle closing its stream while active: onLost, state lost', async (t) => {
    const env = await setup(t);
    const { bundle } = await activeEcho(env);

    bundle.end();
    await until(() => env.lost.length > 0, 'onLost');

    assert.equal(env.lost.length, 1);
    assert.equal(env.lost[0]?.key, echoKey);
    assert.equal(env.lost[0]?.end.cause, 'closed');
    assert.equal(env.table.get(echoKey)?.state, 'lost');
    assert.deepEqual(env.invalid, []);
  });

  test('sendStop sets stopping, sends Stop and resolves when the stream ends', async (t) => {
    const env = await setup(t);
    const { bundle } = await activeEcho(env);
    let stateAtStop: InstanceState | undefined;

    bundle.onFrame = (frame) => {
      if (frame.frame.case === 'stop') {
        stateAtStop = env.table.get(echoKey)?.state;
        bundle.end();
      }
    };

    await env.router.sendStop(echoKey);

    assert.equal(bundle.framesOf('stop').length, 1);
    assert.equal(stateAtStop, 'stopping');
    assert.equal(env.table.get(echoKey)?.state, 'stopping');
    assert.deepEqual(env.lost, []);
    assert.deepEqual(env.invalid, []);
  });
});

// ---------------------------------------------------------------------------
// Binding and closing (section 2)

describe('router binding', () => {
  const options = {
    index,
    instances: new InstanceTable(),
    timings: testTimings,
    diagnostics: {
      health: () => undefined,
      hostStalled: () => undefined,
      registrationReplay: () => undefined,
    },
    onInvalid: () => undefined,
    onLost: () => undefined,
  };

  test('a non-loopback address fails at router_binding', async () => {
    await assert.rejects(
      startRouter({ ...options, address: '0.0.0.0:0' }),
      (error: unknown) => {
        assert.ok(error instanceof RouterBindingError);
        assert.equal(error.stage, 'router_binding');
        assert.equal(error.message, 'The router listens on loopback only.');

        return true;
      },
    );
  });

  test('a malformed address fails at router_binding', async () => {
    await assert.rejects(
      startRouter({ ...options, address: 'not-an-address' }),
      (error: unknown) => {
        assert.ok(error instanceof RouterBindingError);
        assert.equal(error.stage, 'router_binding');

        return true;
      },
    );
  });

  test('the default address binds a free port; close() resolves, twice', async () => {
    const router = await startRouter(options);

    try {
      assert.ok(router.port > 0);
    } finally {
      await router.close();
    }

    await router.close();
  });
});
