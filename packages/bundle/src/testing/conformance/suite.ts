// The cases of the protocol conformance suite (spec
// `docs/designs/grpc-processes.md`, section 10, "Protocol conformance across
// SDKs"), registered by `runConformance`, which imports this module only when
// it runs: `node:test`, the HTTP/2 server and the router's constants stay out
// of every bundle that imports `bundle/testing`.
//
// Each case plays the router: it serves `BundleHostService/Connect` on a
// loopback port of its own, spawns one fixture process with the spawn
// environment of section 7, drives the control frames and checks the answers.

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { describe, type TestContext, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  create,
  type DescMessage,
  fromBinary,
  type JsonObject,
  type MessageInitShape,
  type MessageShape,
  toBinary,
} from '@bufbuild/protobuf';
import {
  Code,
  type ConnectRouter,
  type HandlerContext,
} from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';

import {
  ConformanceService,
  CountRequestSchema,
  CountResponseSchema,
  EchoRequestSchema,
  EchoResponseSchema,
  FailRequestSchema,
  FailResponseSchema,
  FreezeRequestSchema,
  ObservedRequestSchema,
  type ObservedResponse,
  ObservedResponseSchema,
  SumRequestSchema,
  SumResponseSchema,
  WaitRequestSchema,
  WaitResponseSchema,
} from '../../contracts/gen/doric/conformance/v1/conformance_pb.js';
import {
  BundleHostService,
  type ConnectRequest,
  type ConnectResponse,
  ConnectResponseSchema,
  type Hello,
} from '../../contracts/gen/doric/platform/v1/control_pb.js';
import {
  type Status,
  StatusSchema,
} from '../../contracts/gen/google/rpc/status_pb.js';
import { fromStatus } from '../../contracts/status.js';
import {
  initialCallCredit,
  maxMessageBytes,
  protocolVersion,
} from '../../platform/router/control.js';
import {
  instanceEnvironment,
  type SpawnCommand,
} from '../../platform/supervisor/spawn.js';
import { timings } from '../../platform/supervisor/timings.js';
import type { ConformanceOptions } from './index.js';

// ---------------------------------------------------------------------------
// Values every case uses

/** The instance every fixture process is spawned as. */
const fixtureInstance = {
  bundleId: 'conformance.fixture',
  version: '1.0.0',
  generation: 3,
  incarnation: 2,
} as const;
const helloInstance = {
  bundleId: fixtureInstance.bundleId,
  generation: fixtureInstance.generation,
  incarnation: fixtureInstance.incarnation,
};

/** The caller the suite stamps on every `CallStart`. */
const caller = {
  bundleId: 'conformance.caller',
  version: '2.1.0',
  generation: 7,
  incarnation: 4,
} as const;
const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

/** The messages of each streamed case, and the number of `Echo` calls. */
const messageCount = 1_000;
/** Response credit the streamed case grants at a time, once it is spent. */
const creditStep = 7;
/** How long the streamed case waits, with the credit spent, before granting. */
const creditDelayMs = 2;
/** The first `call_id`, above `Number.MAX_SAFE_INTEGER`: ids are 64-bit. */
const firstCallId = 2n ** 53n + 1n;
/** How long a case waits for a frame it expects. */
const frameTimeoutMs = 10_000;
/** How long a case waits for an exit that has no deadline of its own. */
const exitTimeoutMs = 5_000;
/** Each case's `node:test` timeout. */
const caseTimeoutMs = 60_000;
/** Processes alive at once: one per running case. */
const concurrency = 4;

const methodOf = (name: string): string =>
  `/${ConformanceService.typeName}/${name}`;

const encode = <D extends DescMessage>(
  schema: D,
  value: MessageInitShape<D>,
): Uint8Array => toBinary(schema, create(schema, value));

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ---------------------------------------------------------------------------
// One case's router and fixture process

type BundleFrame = ConnectRequest['frame'];
type FrameCase = NonNullable<BundleFrame['case']>;
type FrameOf<C extends FrameCase> = Extract<BundleFrame, { case: C }>;
/** The value of each frame case, by case. */
type FrameValues = { [C in FrameCase]: FrameOf<C>['value'] };

const isCase = <C extends FrameCase>(
  frame: BundleFrame,
  kind: C,
): frame is FrameOf<C> => frame.case === kind;

/** The frame's value when its case is `kind`. */
const frameValue = <C extends FrameCase>(
  frame: BundleFrame,
  kind: C,
): FrameValues[C] | undefined =>
  // `case` and `value` vary together, which TypeScript does not see through
  // a type parameter: the check above the value stands for the narrowing.
  frame.case === kind ? (frame.value as FrameValues[C]) : undefined;

/** The `google.rpc.Status` code of success, which `Code` does not name. */
const codeOk = 0;

/** What the suite knows of one host-to-bundle call it started. */
interface CallRecord {
  /** The payloads of its `CallMessage`s, in order. */
  readonly messages: Uint8Array[];
  /** The status of its `CallEnd`, once it arrived. */
  end: Status | undefined;
  /** The response messages the suite allowed: `initialCredit` and grants. */
  allowance: number;
  /** The request messages the bundle allowed: 16 and its `CallCredit`s. */
  requestCredit: number;
}

/** How the fixture process ended, at `performance.now()` time `atMs`. */
interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly atMs: number;
}

/** The suite's last bytes of the fixture's stdout and stderr. */
const outputLimit = 16 * 1024;

/**
 * One case: a Connect HTTP/2 server of `BundleHostService` on a loopback
 * port, and one fixture process spawned against it. `close` kills the
 * process with `SIGKILL` and closes the server.
 */
class Session {
  /** The bundle's frames, in the order they arrived. */
  readonly frames: BundleFrame[] = [];
  /** The calls the suite started, by `call_id`. */
  readonly calls = new Map<bigint, CallRecord>();
  /** Frames that break protocol version 1, described. */
  readonly violations: string[] = [];
  /** The `authorization` header of the control stream. */
  authorization: string | undefined;
  /** `performance.now()` when the process was spawned. */
  spawnedAt = 0;
  /** How the process ended, once it did. */
  exited: ProcessExit | undefined;
  /** Resolves when the process has ended. */
  exit: Promise<ProcessExit> = Promise.resolve({
    code: null,
    signal: null,
    atMs: 0,
  });

  readonly token = randomBytes(24).toString('base64url');

  private readonly server: http2.Http2Server;
  private readonly sessions = new Set<http2.ServerHttp2Session>();
  private readonly outgoing: ConnectResponse[] = [];
  private readonly listeners = new Set<() => void>();
  private responding = true;
  private requestsEnded = false;
  private wakeResponses: (() => void) | undefined;
  private nextCallId = firstCallId;
  private child: ChildProcess | undefined;
  private output = '';

  private constructor() {
    const routes = (router: ConnectRouter): void => {
      router.service(BundleHostService, {
        connect: (requests, context) => this.serve(requests, context),
      });
    };

    this.server = http2.createServer(
      connectNodeAdapter({
        grpc: true,
        connect: false,
        grpcWeb: false,
        readMaxBytes: maxMessageBytes,
        writeMaxBytes: maxMessageBytes,
        routes,
      }),
    );
    this.server.on('session', (session) => {
      this.sessions.add(session);
      session.on('close', () => this.sessions.delete(session));
    });
  }

  /** Listens on a loopback port and spawns the fixture against it. */
  static async open(
    options: ConformanceOptions,
    extraEnv: NodeJS.ProcessEnv,
  ): Promise<Session> {
    const session = new Session();

    await new Promise<void>((resolve, reject) => {
      session.server.once('error', reject);
      session.server.listen(0, '127.0.0.1', () => {
        session.server.off('error', reject);
        resolve();
      });
    });

    try {
      session.spawn(options.command, {
        ...(options.env ?? process.env),
        ...extraEnv,
      });
    } catch (error) {
      await session.close();
      throw error;
    }

    return session;
  }

  /** The last bytes the process wrote to stdout and stderr. */
  get outputTail(): string {
    return this.output;
  }

  /** Queues a frame on the control stream. */
  send(frame: MessageInitShape<typeof ConnectResponseSchema>): void {
    this.outgoing.push(create(ConnectResponseSchema, frame));
    this.wakeResponses?.();
  }

  /** Ends the control stream once the queued frames are sent. */
  endStream(): void {
    this.responding = false;
    this.wakeResponses?.();
  }

  /**
   * Resolves with `find()`'s first defined answer, checked now and after
   * every frame and the process's end. Rejects after `timeoutMs`, or once
   * the process has ended and its stream is read to the end.
   */
  waitFor<T>(
    find: () => T | undefined,
    what: string,
    timeoutMs = frameTimeoutMs,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (): void => {
        clearTimeout(timer);
        this.listeners.delete(check);
      };
      const check = (): void => {
        const found = find();

        if (found !== undefined) {
          done();
          resolve(found);
        } else if (this.exited !== undefined && this.requestsEnded) {
          done();
          reject(
            new Error(
              `The fixture ended (${describeExit(this.exited)}) before ${what}.`,
            ),
          );
        }
      };

      timer = setTimeout(() => {
        done();
        reject(new Error(`No ${what} within ${timeoutMs} ms.`));
      }, timeoutMs);
      this.listeners.add(check);
      check();
    });
  }

  /** The first frame of `kind` that `match` accepts, once it arrived. */
  frame<C extends FrameCase>(
    kind: C,
    what: string,
    match: (value: FrameValues[C]) => boolean = () => true,
  ): Promise<FrameValues[C]> {
    return this.waitFor(() => {
      for (const frame of this.frames) {
        const value = frameValue(frame, kind);

        if (value !== undefined && match(value)) {
          return value;
        }
      }

      return undefined;
    }, what);
  }

  /** Resolves with the process's end; fails the case after `timeoutMs`. */
  async exitWithin(timeoutMs: number, what: string): Promise<ProcessExit> {
    let timer: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        this.exit,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`The fixture did not exit ${what}.`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Waits for the Hello and answers `Accepted`. */
  async accept(): Promise<Hello> {
    const hello = await this.frame('hello', 'Hello');

    this.send({ frame: { case: 'accepted', value: { protocolVersion } } });

    return hello;
  }

  /** Sends `Activate`; resolves with the `ActivateResult`'s status. */
  async activate(): Promise<Status> {
    this.send({ frame: { case: 'activate', value: {} } });

    const result = await this.frame('activateResult', 'ActivateResult');

    return result.status ?? create(StatusSchema);
  }

  /** Accepts the Hello and activates the fixture with success. */
  async ready(): Promise<void> {
    await this.accept();
    assertStatus(await this.activate(), codeOk, 'ActivateResult');
  }

  /** Opens a call with `CallStart`; answers its `call_id`. */
  startCall(start: {
    readonly method: string;
    readonly kind: 'unary' | 'server_stream' | 'client_stream';
    readonly payload?: Uint8Array;
    readonly scope?: Readonly<Record<string, string>>;
    readonly deadlineUnixMs?: number;
  }): bigint {
    const callId = this.nextCallId;

    this.nextCallId += 1n;
    this.calls.set(callId, {
      messages: [],
      end: undefined,
      allowance: initialCallCredit,
      requestCredit: initialCallCredit,
    });
    this.send({
      frame: {
        case: 'callStart',
        value: {
          callId,
          method: start.method,
          kind: start.kind,
          caller,
          scope: { ...start.scope },
          traceparent,
          deadlineUnixMs: start.deadlineUnixMs ?? 0,
          initialCredit: initialCallCredit,
          payload: start.payload ?? new Uint8Array(),
        },
      },
    });

    return callId;
  }

  /** The record of a call the suite started. */
  call(callId: bigint): CallRecord {
    const call = this.calls.get(callId);

    assert.ok(call, `the suite started no call ${callId}`);

    return call;
  }

  /** Grants `messages` more response messages of a call. */
  grant(callId: bigint, messages: number): void {
    this.call(callId).allowance += messages;
    this.send({
      frame: { case: 'callCredit', value: { callId, messages } },
    });
  }

  /** Resolves with the call's record once its `CallEnd` arrived. */
  ended(callId: bigint, what: string): Promise<CallRecord> {
    const call = this.call(callId);

    return this.waitFor(
      () => (call.end === undefined ? undefined : call),
      `the CallEnd of ${what}`,
    );
  }

  /** Runs a unary call of the conformance service to its end. */
  async unary<I extends DescMessage, O extends DescMessage>(
    name: string,
    input: I,
    request: MessageInitShape<I>,
    output: O,
  ): Promise<{ status: Status; responses: MessageShape<O>[] }> {
    const callId = this.startCall({
      method: methodOf(name),
      kind: 'unary',
      payload: encode(input, request),
    });
    const call = await this.ended(callId, name);

    return {
      status: call.end ?? create(StatusSchema),
      responses: call.messages.map((payload) => fromBinary(output, payload)),
    };
  }

  /** What the `Wait` call of `key` saw, read with `Observed`. */
  async observed(key: string): Promise<ObservedResponse> {
    const { status, responses } = await this.unary(
      'Observed',
      ObservedRequestSchema,
      { key },
      ObservedResponseSchema,
    );

    const [response, ...more] = responses;

    assertStatus(status, codeOk, `Observed ${key}`);
    assert.ok(response, `a response of Observed ${key}`);
    assert.equal(more.length, 0, `one response of Observed ${key}`);

    return response;
  }

  /** Polls `Observed` until the `Wait` of `key` has started. */
  async waitStarted(key: string): Promise<void> {
    const deadline = performance.now() + frameTimeoutMs;

    while (!(await this.observed(key)).found) {
      if (performance.now() > deadline) {
        assert.fail(`the Wait of ${key} did not start`);
      }

      await sleep(10);
    }
  }

  /** Kills the process with `SIGKILL`, ends the stream, closes the server. */
  async close(): Promise<void> {
    const child = this.child;

    if (child !== undefined && this.exited === undefined) {
      child.kill('SIGKILL');
      await this.exit;
    }

    this.endStream();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());

      for (const session of this.sessions) {
        session.destroy();
      }
    });
  }

  private spawn(command: SpawnCommand, base: NodeJS.ProcessEnv): void {
    const address = this.server.address() as AddressInfo;
    const env = instanceEnvironment({
      base,
      routerPort: address.port,
      token: this.token,
      instance: fixtureInstance,
    });

    this.spawnedAt = performance.now();

    const child = spawn(command.command, [...command.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    const keep = (chunk: Buffer): void => this.keep(chunk.toString('utf8'));

    this.child = child;
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    this.exit = new Promise<ProcessExit>((resolve) => {
      const ended = (exit: ProcessExit): void => {
        if (this.exited === undefined) {
          this.exited = exit;
          resolve(exit);
          this.notify();
        }
      };

      child.once('exit', (code, signal) =>
        ended({ code, signal, atMs: performance.now() }),
      );
      child.once('error', (error) => {
        this.keep(`[conformance] the spawn failed: ${error.message}\n`);
        this.requestsEnded = true;
        ended({ code: null, signal: null, atMs: performance.now() });
      });
    });
  }

  /** The `BundleHostService/Connect` handler: reads frames, sends queued ones. */
  private async *serve(
    requests: AsyncIterable<ConnectRequest>,
    context: HandlerContext,
  ): AsyncGenerator<ConnectResponse> {
    this.authorization =
      context.requestHeader.get('authorization') ?? undefined;
    void this.read(requests);

    const wake = (): void => this.wakeResponses?.();

    context.signal.addEventListener('abort', wake);

    try {
      for (;;) {
        const next = this.outgoing.shift();

        if (next !== undefined) {
          yield next;
          continue;
        }

        if (!this.responding || context.signal.aborted) {
          return;
        }

        await new Promise<void>((resolve) => {
          this.wakeResponses = resolve;
        });
        this.wakeResponses = undefined;
      }
    } finally {
      context.signal.removeEventListener('abort', wake);
    }
  }

  private async read(requests: AsyncIterable<ConnectRequest>): Promise<void> {
    try {
      for await (const request of requests) {
        this.receive(request.frame);
      }
    } catch (error) {
      // A transport failure, not a frame: the case's waits report it.
      this.keep(
        `[conformance] the control stream failed: ${messageOf(error)}\n`,
      );
    } finally {
      this.requestsEnded = true;
      this.notify();
    }
  }

  private receive(frame: BundleFrame): void {
    const first = this.frames.length === 0;

    this.frames.push(frame);

    if (first !== (frame.case === 'hello')) {
      this.violations.push(
        first ? `the first frame is ${frame.case}` : 'a second Hello',
      );
    }

    if (
      frame.case === 'callMessage' ||
      frame.case === 'callEnd' ||
      frame.case === 'callCredit'
    ) {
      this.receiveCallFrame(frame);
    }

    this.notify();
  }

  private receiveCallFrame(
    frame: FrameOf<'callMessage' | 'callEnd' | 'callCredit'>,
  ): void {
    const call = this.calls.get(frame.value.callId);

    if (call === undefined || call.end !== undefined) {
      this.violations.push(
        `a ${frame.case} for the call ${frame.value.callId}, which is not open`,
      );

      return;
    }

    switch (frame.case) {
      case 'callMessage':
        call.messages.push(frame.value.payload);

        if (call.messages.length > call.allowance) {
          this.violations.push(
            `the CallMessage ${call.messages.length} of the call ${frame.value.callId} is beyond its credit of ${call.allowance}`,
          );
        }

        return;
      case 'callEnd':
        call.end = frame.value.status ?? create(StatusSchema);
        return;
      case 'callCredit':
        call.requestCredit += frame.value.messages;
        return;
    }
  }

  private keep(text: string): void {
    this.output = (this.output + text).slice(-outputLimit);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

const describeExit = (exit: ProcessExit): string =>
  exit.signal === null ? `code ${exit.code}` : `signal ${exit.signal}`;

/** Fails unless `status` has `code`; names the status's message when it fails. */
const assertStatus = (status: Status, code: number, what: string): void => {
  assert.equal(
    status.code,
    code,
    `${what}: code ${status.code} (${status.message}), expected ${code}`,
  );
};

/** Runs one case: opens a session, runs `body`, closes it in all outcomes. */
const runCase = async (
  t: TestContext,
  options: ConformanceOptions,
  body: (session: Session) => Promise<void>,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<void> => {
  const session = await Session.open(options, extraEnv);

  try {
    await body(session);
    assert.deepEqual(session.violations, [], 'protocol violations');
  } catch (error) {
    t.diagnostic(`fixture output:\n${session.outputTail}`);
    throw error;
  } finally {
    await session.close();
  }
};

// ---------------------------------------------------------------------------
// The cases

/** One code of each family of the error table, with its gRPC code. */
const errorFamilies: readonly (readonly [string, Code])[] = [
  ['invalid_input', Code.InvalidArgument],
  ['invalid_instance_token', Code.Unauthenticated],
  ['not_owner', Code.PermissionDenied],
  ['not_found', Code.NotFound],
  ['registration_conflict', Code.AlreadyExists],
  ['revision_conflict', Code.Aborted],
  ['limit_exceeded', Code.ResourceExhausted],
  ['unknown_contract', Code.Unimplemented],
  ['unavailable', Code.Unavailable],
  ['internal', Code.Internal],
  // a bundle's own code: no row, so the default
  ['conformance_refused', Code.FailedPrecondition],
];

/** A case: its name and its body against an open session. */
interface Case {
  readonly name: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly run: (session: Session, t: TestContext) => Promise<void>;
}

const cases: readonly Case[] = [
  // The longest cases first, so they overlap the others.
  {
    name: 'a Hello never answered ends with exit code 70 within the Hello timeout and one second',
    run: async (session) => {
      await session.frame('hello', 'Hello');

      const exit = await session.exitWithin(
        timings.helloTimeoutMs + exitTimeoutMs,
        'after its Hello was never answered',
      );
      const elapsedMs = exit.atMs - session.spawnedAt;

      assert.equal(exit.code, 70, describeExit(exit));
      assert.ok(
        elapsedMs <= timings.helloTimeoutMs + 1_000,
        `exited ${Math.round(elapsedMs)} ms after its spawn`,
      );
    },
  },
  {
    name: 'no HealthReply after Freeze, the case the router quarantines',
    run: async (session) => {
      await session.ready();
      session.send({ frame: { case: 'healthCheck', value: { nonce: 1n } } });
      await session.frame(
        'healthReply',
        'HealthReply 1',
        (reply) => reply.nonce === 1n,
      );
      session.startCall({
        method: methodOf('Freeze'),
        kind: 'unary',
        payload: encode(FreezeRequestSchema, {}),
      });
      session.send({ frame: { case: 'healthCheck', value: { nonce: 2n } } });
      await sleep(timings.healthTimeoutMs);

      assert.equal(
        session.frames.some(
          (frame) => isCase(frame, 'healthReply') && frame.value.nonce === 2n,
        ),
        false,
        'a HealthReply arrived after Freeze',
      );
      assert.equal(session.exited, undefined, 'the frozen process exited');
    },
  },
  {
    name: 'Hello carries the token and the instance',
    run: async (session) => {
      const hello = await session.accept();

      assert.equal(session.frames[0]?.case, 'hello', 'the first frame');
      assert.equal(session.authorization, `Bearer ${session.token}`);
      assert.equal(hello.protocolVersion, protocolVersion);
      assert.deepEqual(
        {
          bundleId: hello.instance?.bundleId,
          generation: hello.instance?.generation,
          incarnation: hello.instance?.incarnation,
        },
        helloInstance,
      );
      assert.ok(
        hello.services.includes(ConformanceService.typeName),
        `services ${hello.services.join(', ')}`,
      );
      assert.equal(hello.httpPort, 0);
    },
  },
  {
    name: 'a refused Hello ends with exit code 70',
    run: async (session) => {
      await session.frame('hello', 'Hello');
      session.send({
        frame: {
          case: 'rejected',
          value: {
            reason: 'hello_mismatch',
            message: 'The conformance suite refuses this Hello.',
          },
        },
      });
      session.endStream();

      const exit = await session.exitWithin(
        exitTimeoutMs,
        'after its Hello was refused',
      );

      assert.equal(exit.code, 70, describeExit(exit));
    },
  },
  {
    name: 'the end of the control stream after Accepted ends with exit code 70',
    run: async (session) => {
      await session.accept();
      session.endStream();

      const exit = await session.exitWithin(
        exitTimeoutMs,
        'after its control stream ended',
      );

      assert.equal(exit.code, 70, describeExit(exit));
    },
  },
  {
    name: 'one HealthReply with the nonce per HealthCheck',
    run: async (session) => {
      const nonces = [1n, 2n, 2n ** 64n - 1n, 42n, 2n ** 53n + 3n];
      const last = 7n;

      await session.ready();

      for (const nonce of [...nonces, last]) {
        session.send({ frame: { case: 'healthCheck', value: { nonce } } });
      }

      // Replies come in order, so once the last one arrived every one has.
      await session.frame(
        'healthReply',
        'the last HealthReply',
        (reply) => reply.nonce === last,
      );

      const replies = session.frames.flatMap((frame) =>
        isCase(frame, 'healthReply') ? [frame.value.nonce] : [],
      );

      assert.deepEqual(replies, [...nonces, last]);
    },
  },
  {
    name: 'activation succeeds',
    run: async (session) => {
      await session.accept();
      assertStatus(await session.activate(), codeOk, 'ActivateResult');
    },
  },
  {
    name: 'activation fails under DORIC_CONFORMANCE_ACTIVATE=fail',
    env: { DORIC_CONFORMANCE_ACTIVATE: 'fail' },
    run: async (session) => {
      await session.accept();

      const status = await session.activate();

      assert.notEqual(status.code, codeOk, 'the ActivateResult code');

      // The process keeps running until Stop.
      session.send({ frame: { case: 'healthCheck', value: { nonce: 1n } } });
      await session.frame('healthReply', 'HealthReply after the failure');
    },
  },
  {
    name: `unary Echo, ${messageCount} calls`,
    run: async (session) => {
      await session.ready();

      const callIds = Array.from({ length: messageCount }, (_, index) =>
        session.startCall({
          method: methodOf('Echo'),
          kind: 'unary',
          payload: encode(EchoRequestSchema, { text: `echo ${index}` }),
        }),
      );
      const calls = await session.waitFor(
        () => {
          const records = callIds.map((callId) => session.call(callId));

          return records.every((call) => call.end !== undefined)
            ? records
            : undefined;
        },
        `the CallEnds of ${messageCount} Echo calls`,
        caseTimeoutMs / 2,
      );

      assert.deepEqual(
        calls.map((call) => call.end?.code),
        callIds.map(() => codeOk),
        'the codes of the Echo calls',
      );
      assert.deepEqual(
        calls.map((call) =>
          call.messages.map(
            (payload) => fromBinary(EchoResponseSchema, payload).text,
          ),
        ),
        callIds.map((_, index) => [`echo ${index}`]),
        'the responses of the Echo calls',
      );
    },
  },
  {
    name: `server-streaming Count, ${messageCount} messages, credit granted slowly`,
    run: async (session) => {
      await session.ready();

      const callId = session.startCall({
        method: methodOf('Count'),
        kind: 'server_stream',
        payload: encode(CountRequestSchema, { n: messageCount }),
      });
      const call = session.call(callId);

      while (call.end === undefined) {
        await session.waitFor(
          () =>
            call.end !== undefined || call.messages.length >= call.allowance
              ? true
              : undefined,
          'Count messages up to the credit',
        );

        if (call.end === undefined) {
          // The credit is spent: nothing more may arrive before the grant.
          await sleep(creditDelayMs);
          session.grant(callId, creditStep);
        }
      }

      assertStatus(call.end, codeOk, 'Count');
      assert.deepEqual(
        call.messages.map(
          (payload) => fromBinary(CountResponseSchema, payload).index,
        ),
        Array.from({ length: messageCount }, (_, index) => index),
      );
    },
  },
  {
    name: `client-streaming Sum, ${messageCount} messages within the bundle's credit`,
    run: async (session) => {
      await session.ready();

      const callId = session.startCall({
        method: methodOf('Sum'),
        kind: 'client_stream',
      });
      const call = session.call(callId);
      let sent = 0;
      let total = 0;

      while (sent < messageCount) {
        await session.waitFor(
          () => (sent < call.requestCredit ? true : undefined),
          `request credit beyond ${sent} Sum messages`,
        );

        while (sent < call.requestCredit && sent < messageCount) {
          session.send({
            frame: {
              case: 'callMessage',
              value: {
                callId,
                payload: encode(SumRequestSchema, { value: sent }),
              },
            },
          });
          total += sent;
          sent += 1;
        }
      }

      session.send({ frame: { case: 'callHalfClose', value: { callId } } });

      const ended = await session.ended(callId, 'Sum');

      assertStatus(ended.end ?? create(StatusSchema), codeOk, 'Sum');
      assert.deepEqual(
        ended.messages.map((payload) => {
          const response = fromBinary(SumResponseSchema, payload);

          return { total: response.total, count: response.count };
        }),
        [{ total, count: messageCount }],
      );
    },
  },
  {
    name: 'Fail with each family of the error table',
    run: async (session, t) => {
      await session.ready();

      for (const [code, grpcCode] of errorFamilies) {
        await t.test(code, async () => {
          const message = `The fixture fails with ${code}.`;
          const details: JsonObject | undefined =
            grpcCode === Code.FailedPrecondition
              ? undefined
              : { family: code, nested: { list: [1, 'two', true, null] } };
          const { status, responses } = await session.unary(
            'Fail',
            FailRequestSchema,
            { code, message, ...(details === undefined ? {} : { details }) },
            FailResponseSchema,
          );
          const error = fromStatus(status);

          assert.equal(responses.length, 0, 'no response message');
          assertStatus(status, grpcCode, `Fail ${code}`);
          assert.equal(status.message, message);
          assert.deepEqual(
            {
              code: error.code,
              message: error.message,
              details: error.details,
            },
            { code, message, details },
          );
        });
      }
    },
  },
  {
    name: 'cancellation seen by the handler, then CallEnd CANCELLED',
    run: async (session) => {
      const scope = { windowKey: 'window-1', thread: 'thread-9' };

      await session.ready();

      const callId = session.startCall({
        method: methodOf('Wait'),
        kind: 'unary',
        payload: encode(WaitRequestSchema, { key: 'cancel', holdMs: 0 }),
        scope,
      });

      await session.waitStarted('cancel');
      session.send({
        frame: { case: 'callCancel', value: { callId, reason: 'cancelled' } },
      });

      const call = await session.ended(callId, 'the cancelled Wait');

      assertStatus(call.end ?? create(StatusSchema), Code.Canceled, 'Wait');
      assert.equal(call.messages.length, 0, 'no response message');

      const seen = await session.observed('cancel');

      assert.deepEqual(
        {
          cancelled: seen.cancelled,
          answered: seen.answered,
          callerBundleId: seen.callerBundleId,
          callerVersion: seen.callerVersion,
          callerGeneration: seen.callerGeneration,
          scope: { ...seen.scope },
          traceparent: seen.traceparent,
          deadlineUnixMs: seen.deadlineUnixMs,
        },
        {
          cancelled: true,
          answered: false,
          callerBundleId: caller.bundleId,
          callerVersion: caller.version,
          callerGeneration: caller.generation,
          scope,
          traceparent,
          deadlineUnixMs: 0,
        },
      );
    },
  },
  {
    name: 'deadline seen by the handler, then CallEnd CANCELLED',
    run: async (session) => {
      await session.ready();

      const deadlineUnixMs = Date.now() + 500;
      const callId = session.startCall({
        method: methodOf('Wait'),
        kind: 'unary',
        payload: encode(WaitRequestSchema, { key: 'deadline', holdMs: 0 }),
        deadlineUnixMs,
      });

      await session.waitStarted('deadline');

      // As the router does, at the deadline.
      const timer = setTimeout(
        () =>
          session.send({
            frame: {
              case: 'callCancel',
              value: { callId, reason: 'deadline' },
            },
          }),
        Math.max(0, deadlineUnixMs - Date.now()),
      );

      try {
        const call = await session.ended(callId, 'the Wait past its deadline');

        assertStatus(call.end ?? create(StatusSchema), Code.Canceled, 'Wait');
        assert.equal(call.messages.length, 0, 'no response message');
      } finally {
        clearTimeout(timer);
      }

      const seen = await session.observed('deadline');

      assert.deepEqual(
        {
          cancelled: seen.cancelled,
          answered: seen.answered,
          deadlineUnixMs: seen.deadlineUnixMs,
        },
        { cancelled: true, answered: false, deadlineUnixMs },
      );
    },
  },
  {
    name: 'GenerationChanged draining acknowledged while a call in flight finishes',
    run: async (session) => {
      await session.ready();

      const callId = session.startCall({
        method: methodOf('Wait'),
        kind: 'unary',
        payload: encode(WaitRequestSchema, { key: 'drain', holdMs: 1_000 }),
      });

      await session.waitStarted('drain');
      session.send({
        frame: {
          case: 'generationChanged',
          value: {
            event: 'draining',
            subject: helloInstance,
            live: [{ instance: helloInstance, state: 'draining' }],
          },
        },
      });

      const ack = await session.frame('generationAck', 'GenerationAck');

      assert.equal(ack.event, 'draining');

      const call = await session.ended(callId, 'the draining Wait');
      const ackAt = session.frames.findIndex((frame) =>
        isCase(frame, 'generationAck'),
      );
      const endAt = session.frames.findIndex(
        (frame) => isCase(frame, 'callEnd') && frame.value.callId === callId,
      );

      assert.ok(ackAt < endAt, 'the GenerationAck came before the CallEnd');
      assertStatus(call.end ?? create(StatusSchema), codeOk, 'Wait');
      assert.deepEqual(
        call.messages.map(
          (payload) => fromBinary(WaitResponseSchema, payload).key,
        ),
        ['drain'],
      );

      const seen = await session.observed('drain');

      assert.deepEqual(
        { cancelled: seen.cancelled, answered: seen.answered },
        { cancelled: false, answered: true },
      );
    },
  },
  {
    name: 'Stop answered, then exit code 0 within the stop deadline',
    run: async (session) => {
      await session.ready();
      session.send({ frame: { case: 'stop', value: {} } });

      const sentAt = performance.now();

      await session.frame('stopResult', 'StopResult');

      const exit = await session.exitWithin(
        timings.stopTimeoutMs + exitTimeoutMs,
        'after Stop',
      );

      assert.equal(exit.code, 0, describeExit(exit));
      assert.ok(
        exit.atMs - sentAt <= timings.stopTimeoutMs,
        `exited ${Math.round(exit.atMs - sentAt)} ms after Stop`,
      );
    },
  },
  {
    name: 'an unregistered method answered UNIMPLEMENTED',
    run: async (session) => {
      await session.ready();

      const callId = session.startCall({
        method: '/doric.conformance.v1.UnregisteredService/Echo',
        kind: 'unary',
        payload: encode(EchoRequestSchema, { text: 'nobody' }),
      });
      const call = await session.ended(callId, 'the unregistered method');

      assertStatus(
        call.end ?? create(StatusSchema),
        Code.Unimplemented,
        'the unregistered method',
      );
      assert.equal(call.messages.length, 0, 'no response message');
    },
  },
  {
    name: 'an Echo response over 4 MiB ended with RESOURCE_EXHAUSTED, limit_exceeded',
    run: async (session) => {
      await session.ready();

      const { status, responses } = await session.unary(
        'Echo',
        EchoRequestSchema,
        { text: 'large', padBytes: maxMessageBytes },
        EchoResponseSchema,
      );

      assert.equal(responses.length, 0, 'no response message');
      assertStatus(status, Code.ResourceExhausted, 'Echo over 4 MiB');
      assert.equal(fromStatus(status).code, 'limit_exceeded');
    },
  },
];

/**
 * Registers the cases under one `describe` named after `options.command`,
 * at most {@link concurrency} at once. Returns once they are registered.
 */
export const registerConformance = (options: ConformanceOptions): void => {
  const { command, args } = options.command;

  void describe(`protocol conformance: ${[command, ...args].join(' ')}`, {
    concurrency,
  }, () => {
    for (const { name, env, run } of cases) {
      void test(name, { timeout: caseTimeoutMs }, (t) =>
        runCase(t, options, (session) => run(session, t), env),
      );
    }
  });
};
