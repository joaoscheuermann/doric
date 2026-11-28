// The test process of `bundle/testing` (spec `docs/designs/grpc-processes.md`,
// "Phase 4's slices", QD; S73, T4.21): a test router for one built bundle
// process. It listens on a loopback port of its own, spawns the process as the
// supervisor does, accepts its Hello, activates it, and hands the test Connect
// transports whose calls reach the process as host-to-bundle calls on its
// control stream, stamped with a caller of the test's choosing.

import {
  type DescMessage,
  type DescMethod,
  type DescMethodBiDiStreaming,
  type DescMethodClientStreaming,
  type DescMethodServerStreaming,
  type DescMethodUnary,
  fromBinary,
  type MessageShape,
  toBinary,
} from '@bufbuild/protobuf';
import {
  createRouterTransport,
  type HandlerContext,
  type Transport,
} from '@connectrpc/connect';

import { ContractError } from '../contracts/error.js';
import { fromStatus, toConnectError } from '../contracts/status.js';
import { protocolVersion } from '../platform/router/control.js';
import { timings } from '../platform/supervisor/timings.js';
import type { Session } from './conformance/session.js';

/** What `startTestProcess` spawns. */
export interface TestProcessOptions {
  /**
   * The bundle id the process must send in its Hello; it is also the bundle
   * id the variables of the supervisor's spawn name.
   */
  readonly bundleId: string;
  /**
   * The program and its arguments: `command[0]` is spawned with
   * `command.slice(1)`. An empty command makes `startTestProcess` reject.
   */
  readonly command: readonly string[];
  /**
   * Variables added on top of the test's `process.env`; the variables the
   * supervisor sets at spawn (section 7, "Spawn") are set last.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * A started, active bundle process. Its instance has version `0.0.0`,
 * generation 1 and incarnation 1. The router sends it no health check, and a
 * call the process makes to the router is refused with
 * `undeclared_requirement`.
 */
export interface TestProcess {
  /**
   * A Connect transport whose calls reach the process as host-to-bundle calls
   * on its control stream, each stamped with the caller
   * `{ bundleId: caller, version: '0.0.0', generation, incarnation: 1 }`
   * as the router stamps a call; `generation` is 1 when absent, and any
   * whole number from 1 is stamped as given, so a test can call as two
   * generations of one bundle. The process's own instance stays generation
   * 1 whatever the caller's generation. A call the process ends with a non-zero
   * `CallEnd` fails with `toConnectError(fromStatus(status))`. A call made
   * after the process exited, or still open when it exits, fails with
   * `ContractError` code `unavailable`, as a ConnectError of code
   * `Unavailable`. The call's abort signal cancels it.
   */
  transport(caller: string, generation?: number): Transport;
  /**
   * Sends `Stop`, waits for `StopResult` and the exit, and kills the process
   * with `SIGKILL` when it has not exited 5 seconds after `Stop`. Never
   * rejects; a second call waits for the same exit.
   */
  stop(): Promise<void>;
  /**
   * Settles when the process exits, with its exit code, or `null` when a
   * signal ended it. Never rejects.
   */
  readonly exited: Promise<number | null>;
}

/**
 * Spawns `options.command` and answers once the process is active: it accepts
 * the Hello of `options.bundleId`, generation 1, and activates the process as
 * the protocol conformance suite's activation-success case does.
 *
 * Rejects, after killing the process, when the process exits before it is
 * active, sends no Hello within 10 seconds, sends a Hello of another bundle or
 * generation, answers `Activate` with a failure (rejecting with that
 * failure's `ContractError`) or does not answer `Activate` within 60 seconds.
 * Also rejects when `command` is empty or the spawn fails.
 */
export const startTestProcess = async (
  options: TestProcessOptions,
): Promise<TestProcess> => {
  const [command, ...args] = options.command;

  if (command === undefined) {
    throw new ContractError(
      'invalid_input',
      'startTestProcess needs a command; it got none.',
    );
  }

  // Loaded here, not at the top: many bundles import `bundle/testing`.
  const { Session, messageOf } = await import('./conformance/session.js');
  const instance = { ...identity, bundleId: options.bundleId };
  const session = await Session.open(
    { command: { command, args }, env: { ...process.env, ...options.env } },
    {},
    instance,
  );

  try {
    await activate(session, options.bundleId);
  } catch (error) {
    await session.close();

    const tail = `\nThe process's last output:\n${session.outputTail}`;

    throw error instanceof ContractError
      ? new ContractError(error.code, error.message + tail, error.details)
      : new Error(messageOf(error) + tail, { cause: error });
  }

  let stopping: Promise<void> | undefined;

  return {
    transport: (caller, generation = 1) =>
      transportOf(session, { ...identity, generation, bundleId: caller }),
    stop: () => {
      stopping ??= stop(session);

      return stopping;
    },
    exited: session.exit.then((exit) => exit.code),
  };
};

/** The instance of the process, and of every caller it sees, but the id. */
const identity = { version: '0.0.0', generation: 1, incarnation: 1 } as const;
/** How long `stop` waits for the exit before `SIGKILL`. */
const stopTimeoutMs = 5_000;

type Caller = Omit<typeof identity, 'generation'> & {
  readonly generation: number;
  readonly bundleId: string;
};

/**
 * Checks the token and the Hello, answers `Accepted`, and activates the
 * process; rejects with the cause otherwise.
 */
const activate = async (session: Session, bundleId: string): Promise<void> => {
  const first = await session.waitFor(
    () => session.frames[0],
    'Hello',
    timings.helloTimeoutMs,
  );

  if (first.case !== 'hello') {
    throw new Error(`The process's first frame is ${first.case}, not Hello.`);
  }

  if (session.authorization !== `Bearer ${session.token}`) {
    throw new Error('The control stream does not carry the instance token.');
  }

  const hello = first.value;
  const sent = hello.instance;

  if (
    hello.protocolVersion !== protocolVersion ||
    sent?.bundleId !== bundleId ||
    sent.generation !== identity.generation ||
    sent.incarnation !== identity.incarnation
  ) {
    throw new Error(
      `The Hello names protocol ${hello.protocolVersion}, ${sent?.bundleId} generation ${sent?.generation} incarnation ${sent?.incarnation}, not protocol ${protocolVersion}, ${bundleId} generation 1 incarnation 1.`,
    );
  }

  session.send({ frame: { case: 'accepted', value: { protocolVersion } } });
  session.send({ frame: { case: 'activate', value: {} } });

  const result = await session.frame(
    'activateResult',
    'ActivateResult',
    undefined,
    timings.activationTimeoutMs,
  );

  if (result.status !== undefined && result.status.code !== 0) {
    const failure = fromStatus(result.status);

    throw new ContractError(
      failure.code,
      `The activation failed: ${failure.message}`,
      failure.details,
    );
  }
};

/** Sends `Stop`, waits for its answer and the exit, then closes the session. */
const stop = async (session: Session): Promise<void> => {
  if (session.exited === undefined) {
    session.send({ frame: { case: 'stop', value: {} } });

    await Promise.all([
      session.frame('stopResult', 'StopResult', undefined, stopTimeoutMs),
      session.exitWithin(stopTimeoutMs, `within ${stopTimeoutMs} ms of Stop`),
    ]).catch(() => {
      // `close` kills a process that is still running.
    });
  }

  await session.close().catch(() => {});
};

const unavailable = (): Error =>
  toConnectError(
    new ContractError('unavailable', 'The bundle process has exited.'),
  );

/**
 * The transport of `caller`: each call is served by a router transport of
 * its one method, whose handler relays it on the control stream.
 */
const transportOf = (session: Session, caller: Caller): Transport => {
  const routed = (method: DescMethod): Transport =>
    createRouterTransport((router) => {
      const start = (kind: CallKind, context: HandlerContext) => ({
        session,
        method: `/${method.parent.typeName}/${method.name}`,
        kind,
        caller,
        context,
      });

      if (isKind(method, 'unary')) {
        router.rpc(method, async (request, context) =>
          onlyResponse(
            method.output,
            relay(start('unary', context), toBinary(method.input, request)),
          ),
        );
      } else if (isKind(method, 'server_streaming')) {
        router.rpc(method, (request, context) =>
          decodeEach(
            method.output,
            relay(
              start('server_stream', context),
              toBinary(method.input, request),
            ),
          ),
        );
      } else if (isKind(method, 'client_streaming')) {
        router.rpc(method, async (requests, context) =>
          onlyResponse(
            method.output,
            relay(
              start('client_stream', context),
              encodeEach(method.input, requests),
            ),
          ),
        );
      } else if (isKind(method, 'bidi_streaming')) {
        router.rpc(method, (requests, context) =>
          decodeEach(
            method.output,
            relay(start('bidi', context), encodeEach(method.input, requests)),
          ),
        );
      }
    });

  return {
    unary: (method, ...rest) => routed(method).unary(method, ...rest),
    stream: (method, ...rest) => routed(method).stream(method, ...rest),
  };
};

/** Each `methodKind`'s descriptor type. */
interface MethodOfKind {
  readonly unary: DescMethodUnary;
  readonly server_streaming: DescMethodServerStreaming;
  readonly client_streaming: DescMethodClientStreaming;
  readonly bidi_streaming: DescMethodBiDiStreaming;
}

const isKind = <K extends keyof MethodOfKind>(
  method: DescMethod,
  kind: K,
): method is MethodOfKind[K] => method.methodKind === kind;

type CallKind = 'unary' | 'server_stream' | 'client_stream' | 'bidi';

/** One host-to-bundle call, as its handler sees it. */
interface Relayed {
  readonly session: Session;
  readonly method: string;
  readonly kind: CallKind;
  readonly caller: Caller;
  readonly context: HandlerContext;
}

/**
 * Relays one call on the control stream: `CallStart` with the payload, or
 * the request messages within the bundle's credit and a half-close; yields
 * the response payloads, granting credit for each one a streamed response
 * consumed. A non-zero `CallEnd` throws its ConnectError, the abort of the
 * call's signal sends `CallCancel`, and the process's exit makes the call
 * `unavailable`.
 */
async function* relay(
  call: Relayed,
  request: Uint8Array | AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const { session, context } = call;

  if (session.exited !== undefined) {
    throw unavailable();
  }

  const timeoutMs = context.timeoutMs();
  const callId = session.startCall({
    method: call.method,
    kind: call.kind,
    caller: call.caller,
    deadlineUnixMs: timeoutMs === undefined ? 0 : Date.now() + timeoutMs,
    ...(request instanceof Uint8Array ? { payload: request } : {}),
  });
  const record = session.call(callId);
  const until = <T>(find: () => T | undefined): Promise<T> =>
    session
      .waitFor(find, `the end of the call ${callId}`, Infinity)
      .catch(() => {
        throw unavailable();
      });
  const cancel = (): void => {
    if (record.end === undefined) {
      session.send({ frame: { case: 'callCancel', value: { callId } } });
    }
  };
  const streamsResponse = call.kind === 'server_stream' || call.kind === 'bidi';

  context.signal.addEventListener('abort', cancel, { once: true });

  if (!(request instanceof Uint8Array)) {
    void sendRequests(session, callId, request, until).catch(cancel);
  }

  try {
    for (let next = 0; ; next += 1) {
      const message = await until(() =>
        next < record.messages.length
          ? record.messages[next]
          : record.end === undefined
            ? undefined
            : null,
      );

      if (message === null) {
        break;
      }

      yield message;

      if (streamsResponse && record.end === undefined) {
        session.grant(callId, 1);
      }
    }
  } finally {
    context.signal.removeEventListener('abort', cancel);
  }

  if (record.end !== undefined && record.end.code !== 0) {
    throw toConnectError(fromStatus(record.end));
  }
}

/** Sends the request messages within the bundle's credit, then half-closes. */
const sendRequests = async (
  session: Session,
  callId: bigint,
  requests: AsyncIterable<Uint8Array>,
  until: <T>(find: () => T | undefined) => Promise<T>,
): Promise<void> => {
  const record = session.call(callId);
  let sent = 0;

  for await (const payload of requests) {
    const open = await until(() =>
      record.end !== undefined
        ? false
        : sent < record.requestCredit
          ? true
          : undefined,
    );

    if (!open) {
      return;
    }

    session.send({
      frame: { case: 'callMessage', value: { callId, payload } },
    });
    sent += 1;
  }

  if (record.end === undefined) {
    session.send({ frame: { case: 'callHalfClose', value: { callId } } });
  }
};

async function* encodeEach<I extends DescMessage>(
  schema: I,
  messages: AsyncIterable<MessageShape<I>>,
): AsyncGenerator<Uint8Array> {
  for await (const message of messages) {
    yield toBinary(schema, message);
  }
}

async function* decodeEach<O extends DescMessage>(
  schema: O,
  payloads: AsyncIterable<Uint8Array>,
): AsyncGenerator<MessageShape<O>> {
  for await (const payload of payloads) {
    yield fromBinary(schema, payload);
  }
}

/** The one response of a unary or client-streaming call. */
const onlyResponse = async <O extends DescMessage>(
  schema: O,
  payloads: AsyncIterable<Uint8Array>,
): Promise<MessageShape<O>> => {
  const responses: MessageShape<O>[] = [];

  for await (const response of decodeEach(schema, payloads)) {
    responses.push(response);
  }

  const [response] = responses;

  if (response === undefined || responses.length > 1) {
    throw toConnectError(
      new ContractError(
        'internal',
        `The bundle answered ${responses.length} response messages, not 1.`,
      ),
    );
  }

  return response;
};
