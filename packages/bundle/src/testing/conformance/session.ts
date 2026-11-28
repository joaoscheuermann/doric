// One case's router and fixture process of the protocol conformance suite
// (spec `docs/designs/grpc-processes.md`, section 10, "Protocol conformance
// across SDKs"), also the router of `startTestProcess` ("Phase 4's slices",
// QD). Internal to `bundle/testing`: `suite.ts` and `../process.ts` load it
// only when they run, so the HTTP/2 server stays out of every bundle that
// imports `bundle/testing`.

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  create,
  type DescMessage,
  fromBinary,
  type MessageInitShape,
  type MessageShape,
  toBinary,
} from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  type ConnectRouter,
  type HandlerContext,
} from '@connectrpc/connect';
import {
  connectNodeAdapter,
  universalResponseToNodeResponse,
} from '@connectrpc/connect-node';

import { ContractError } from '../../contracts/error.js';
import {
  ConformanceService,
  ObservedRequestSchema,
  type ObservedResponse,
  ObservedResponseSchema,
} from '../../contracts/gen/doric/conformance/v1/conformance_pb.js';
import {
  BundleHostService,
  type CallerSchema,
  type ConnectRequest,
  type ConnectResponse,
  ConnectResponseSchema,
  type Hello,
} from '../../contracts/gen/doric/platform/v1/control_pb.js';
import {
  type Status,
  StatusSchema,
} from '../../contracts/gen/google/rpc/status_pb.js';
import { toStatus } from '../../contracts/status.js';
import {
  initialCallCredit,
  maxMessageBytes,
  protocolVersion,
} from '../../platform/router/control.js';
import type { InstanceRecord } from '../../platform/router/instances.js';
import { trailersOnly } from '../../platform/router/wire.js';
import {
  instanceEnvironment,
  type SpawnCommand,
} from '../../platform/supervisor/spawn.js';
import type { ConformanceOptions } from './index.js';

/** The caller the suite stamps on every `CallStart`. */
export const caller = {
  bundleId: 'conformance.caller',
  version: '2.1.0',
  generation: 7,
  incarnation: 4,
} as const;
export const traceparent =
  '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

/** The first `call_id`, above `Number.MAX_SAFE_INTEGER`: ids are 64-bit. */
const firstCallId = 2n ** 53n + 1n;
/** How long a case waits for a frame it expects. */
const frameTimeoutMs = 10_000;

export const methodOf = (name: string): string =>
  `/${ConformanceService.typeName}/${name}`;

export const encode = <D extends DescMessage>(
  schema: D,
  value: MessageInitShape<D>,
): Uint8Array => toBinary(schema, create(schema, value));

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The answer to every call the process makes to the session. */
const undeclared = new ContractError(
  'undeclared_requirement',
  'The test router serves no contract to the bundle.',
);

type BundleFrame = ConnectRequest['frame'];
type FrameCase = NonNullable<BundleFrame['case']>;
type FrameOf<C extends FrameCase> = Extract<BundleFrame, { case: C }>;
type FrameValues = { [C in FrameCase]: FrameOf<C>['value'] };

export const isCase = <C extends FrameCase>(
  frame: BundleFrame,
  kind: C,
): frame is FrameOf<C> => frame.case === kind;

/** The `google.rpc.Status` code of success, which `Code` does not name. */
export const codeOk = 0;

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
export class Session {
  /** The bundle's frames, in the order they arrived. */
  readonly frames: BundleFrame[] = [];
  private readonly calls = new Map<bigint, CallRecord>();
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
  /** Whether the process opened its control stream. */
  private connected = false;
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
        fallback: (_request, response) => {
          void universalResponseToNodeResponse(
            trailersOnly(toStatus(undeclared)),
            response,
          ).catch(() => {});
        },
      }),
    );
    this.server.on('session', (session) => {
      this.sessions.add(session);
      session.on('close', () => this.sessions.delete(session));
    });
  }

  /**
   * Listens on a loopback port and spawns the fixture against it as
   * `instance`. A call the process makes to the session is refused with
   * `undeclared_requirement`.
   */
  static async open(
    options: ConformanceOptions,
    extraEnv: NodeJS.ProcessEnv,
    instance: Omit<InstanceRecord, 'state'>,
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
      session.spawn(
        options.command,
        { ...(options.env ?? process.env), ...extraEnv },
        instance,
      );
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

      // An infinite `timeoutMs` waits until the process has ended.
      if (Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          done();
          reject(new Error(`No ${what} within ${timeoutMs} ms.`));
        }, timeoutMs);
      }
      this.listeners.add(check);
      check();
    });
  }

  /** The first frame of `kind` that `match` accepts, once it arrived. */
  frame<C extends FrameCase>(
    kind: C,
    what: string,
    match: (value: FrameValues[C]) => boolean = () => true,
    timeoutMs = frameTimeoutMs,
  ): Promise<FrameValues[C]> {
    return this.waitFor(
      () => {
        // `case` and `value` vary together, which TypeScript does not see
        // through a type parameter.
        const values = this.frames
          .filter((frame) => frame.case === kind)
          .map((frame) => frame.value as FrameValues[C]);

        return values.find(match);
      },
      what,
      timeoutMs,
    );
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

  /** The `call_id` the next `startCall` opens. */
  get nextCall(): bigint {
    return this.nextCallId;
  }

  /** Opens a call with `CallStart`; answers its `call_id`. */
  startCall(start: {
    readonly method: string;
    readonly kind: 'unary' | 'server_stream' | 'client_stream' | 'bidi';
    readonly payload?: Uint8Array;
    readonly scope?: Readonly<Record<string, string>>;
    readonly deadlineUnixMs?: number;
    /** The caller stamped on the call; the suite's {@link caller} by default. */
    readonly caller?: MessageInitShape<typeof CallerSchema>;
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
          caller: start.caller ?? caller,
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

  private spawn(
    command: SpawnCommand,
    base: NodeJS.ProcessEnv,
    instance: Omit<InstanceRecord, 'state'>,
  ): void {
    const address = this.server.address() as AddressInfo;
    const env = instanceEnvironment({
      base,
      routerPort: address.port,
      token: this.token,
      instance,
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

      child.once('exit', (code, signal) => {
        // A process that never opened its control stream sends no frame.
        if (!this.connected) {
          this.requestsEnded = true;
        }

        ended({ code, signal, atMs: performance.now() });
      });
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
    this.connected = true;
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
      // A frame over 4 MiB breaks the protocol, as the router sees it.
      if (
        error instanceof ConnectError &&
        error.code === Code.ResourceExhausted
      ) {
        this.violations.push(`a frame over ${maxMessageBytes} bytes`);
      }

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

export const describeExit = (exit: ProcessExit): string =>
  exit.signal === null ? `code ${exit.code}` : `signal ${exit.signal}`;

/** Fails unless `status` has `code`; names the status's message when it fails. */
export const assertStatus = (
  status: Status,
  code: number,
  what: string,
): void => {
  assert.equal(
    status.code,
    code,
    `${what}: code ${status.code} (${status.message}), expected ${code}`,
  );
};
