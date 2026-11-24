// The program of a host part's `main.ts` (spec
// `docs/designs/grpc-processes.md`, section 10, A61): `runBundle` reads the
// spawn environment, opens the control stream and answers its frames.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';

import {
  create,
  type DescMethod,
  type DescService,
  type MessageInitShape,
} from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  createClient,
  type ServiceImpl,
} from '@connectrpc/connect';
import {
  createGrpcTransport,
  Http2SessionManager,
} from '@connectrpc/connect-node';

import { ContractError, isContractError } from '../../contracts/error.js';
import {
  BundleHostService,
  type ConnectRequest,
  ConnectRequestSchema,
  type ConnectResponse,
  type Instance,
} from '../../contracts/gen/doric/platform/v1/control_pb.js';
import { StatusSchema } from '../../contracts/gen/google/rpc/status_pb.js';
import { toStatus } from '../../contracts/status.js';
import { timings } from '../../platform/supervisor/timings.js';
import { createHostAssets } from './assets.js';
import { createRouterTransport } from './client.js';
import type { BundleInstance, HostContext } from './context.js';
import {
  EXIT_HOST_GONE,
  EXIT_STOPPED,
  HostGoneError,
  type HostGoneReason,
} from './control.js';
import { createGenerations, type Generations } from './generations.js';
import {
  createLogQueue,
  type LogOutput,
  type LogQueue,
  type LogSink,
  type LogTimings,
  routerLogSink,
} from './log.js';
import { createReplays, type Replays } from './replay.js';
import { type CallServer, createCallServer } from './serve.js';

/**
 * One entry of a host part's static `services` list: a generated service
 * and its implementation. `bundle/build` reads the list from
 * `src/host/main.ts` without running it, so write it as an array literal of
 * `[Service, implementation]` literals (A61, A63).
 */
export type ServiceEntry<S extends DescService = DescService> = readonly [
  service: S,
  implementation: ServiceImpl<S>,
];

/**
 * A `services` list, typed entry by entry, so each implementation is checked
 * against its own service. With the default `T` it is
 * `readonly ServiceEntry[]`.
 */
export type ServiceEntries<
  T extends readonly DescService[] = readonly DescService[],
> = { readonly [K in keyof T]: ServiceEntry<T[K]> };

/** One protovalidate violation of a request, as the SDK hands it to {@link InvalidInputAnswer}. */
export interface InputViolation {
  /**
   * The path of the violating field from the request message, as proto field names (`['project_id']`,
   * `['thread_event_log', 'events']`); empty for a message-level rule (a CEL `option (buf.validate.message)`).
   */
  readonly field: readonly string[];
  /** The rule's id (`string.uuid`, `update_thread_request.change`). */
  readonly ruleId: string;
  /** protovalidate's message for this violation. */
  readonly message: string;
}

/**
 * Answers a request that decoded but broke a protovalidate rule of `method`'s input. `violations` holds every violation
 * (at least one), in protovalidate's order. Returns the error the call ends with, or `undefined` to keep the SDK's
 * `ContractError('invalid_input', <protovalidate message>)`. Called synchronously, before the handler, once per call
 * (for a client or bidi stream, once per violating request message). A throw is treated as `undefined`. A request that
 * does not decode never reaches it (`invalid_input`).
 */
export type InvalidInputAnswer = (
  method: DescMethod,
  violations: readonly InputViolation[],
) => ContractError | undefined;

/** What a host part gives `runBundle`. */
export interface BundleDefinition<
  T extends readonly DescService[] = readonly DescService[],
> {
  /**
   * The services the part serves, contract services and handler services
   * alike; default `[]`. Their full names (`typeName`), in list order, are
   * the Hello's `services`; a `CallStart` for one of their methods runs its
   * implementation. A service listed twice makes `startBundle` reject with a
   * `TypeError` before it opens the stream.
   */
  readonly services?: ServiceEntries<T>;
  /**
   * The plain HTTP listener of a part whose manifest sets `host.httpPrefix`
   * (section 11, "The HTTP prefix"), not yet listening; absent for every
   * other part. `startBundle` binds it to `127.0.0.1:0` before it opens the
   * control stream and sends its port as the Hello's `httpPort`; without it
   * the Hello's `httpPort` is 0. The gateway sends it the HTTP/1.1 requests
   * under the prefix, upgrades included, once the instance is active, so its
   * handlers may rely on state `activate` sets up. A part whose manifest
   * sets no `host.httpPrefix` may pass one: its `httpPort` is ignored, since
   * the gateway routes only manifest prefixes. The SDK closes it after
   * `deactivate` settled, before `StopResult`; connections still open end
   * with the process.
   */
  readonly httpServer?: Server;
  /**
   * The sink of `context.log`'s queue for a part that provides `log/v1`
   * itself, so its records do not go through the router to itself. The SDK
   * calls it once, on `Accepted`, with the context `activate` will get.
   * Absent: `routerLogSink` over the instance's router URL and token. A
   * throw is treated as a sink whose every call rejects: records go to
   * stdout.
   */
  readonly logSink?: (context: HostContext) => LogSink;
  /**
   * Runs once, on `Activate`. Resolving answers `ActivateResult` with code
   * 0; throwing or rejecting answers it with the error's status: a
   * `ContractError` as `toStatus` encodes it, any other value as `internal`
   * with its message. The process keeps running either way, until `Stop`.
   */
  activate(context: HostContext): Promise<void> | void;
  /**
   * Runs once, on `Stop`, after `context.signal` aborted, and only when
   * `activate` resolved. Its failure is logged; the SDK still answers
   * `StopResult` and exits with code 0.
   */
  deactivate?(context: HostContext): Promise<void> | void;
  /**
   * The answer to a request that breaks a protovalidate rule (see {@link InvalidInputAnswer}); absent, every such
   * request ends with `invalid_input`, as before. Applies to every method of `services`.
   */
  readonly invalidInput?: InvalidInputAnswer;
}

/** The process a bundle runs in, as `startBundle` sees it. */
export interface StartBundleOptions {
  /**
   * The spawn environment (section 7, "Spawn"): `DORIC_ROUTER_URL`,
   * `DORIC_INSTANCE_TOKEN`, `DORIC_BUNDLE_ID`, `DORIC_GENERATION`,
   * `DORIC_INCARNATION`. The SDK reads each once, and deletes
   * `DORIC_INSTANCE_TOKEN` from this object before it opens the stream.
   */
  readonly env: Record<string, string | undefined>;
  /**
   * Ends the process. The SDK calls it at most once: with
   * `EXIT_HOST_GONE` (70) when the host is gone, with `EXIT_STOPPED` (0)
   * after it sent `StopResult`. After it, the SDK sends no frame.
   */
  readonly exit: (code: number) => void;
  /**
   * From the start to `Accepted`; default the platform's Hello timeout
   * (`timings.helloTimeoutMs`, 10 s). Tests pass shorter values.
   */
  readonly helloTimeoutMs?: number;
  /**
   * The bundle directory, absolute: the directory with `manifest.json`, the
   * root of the asset paths of `context.assets` and of its `require`'s
   * resolution. Absent: `context.assets` rejects (`require` throws) with an
   * `Error` naming the bundle; the rest of the bundle runs. `runBundle`
   * passes two directories above `process.argv[1]`
   * (`<bundle dir>/dist/host/main.mjs`), or nothing when `process.argv[1]`
   * is undefined.
   */
  readonly bundleDir?: string;
  /** The queue's limits; default `defaultLogTimings`. Tests pass shorter. */
  readonly logTimings?: Partial<LogTimings>;
  /** Where unsent records go; default the process's stdout. */
  readonly logOutput?: LogOutput;
}

/** A bundle whose Hello was accepted. */
export interface RunningBundle {
  /** The instance of the Hello. */
  readonly instance: BundleInstance;
  /**
   * Resolves with the code the SDK passed to `exit`, once it did. Never
   * rejects.
   */
  readonly exited: Promise<number>;
}

/**
 * Starts a bundle in this process: reads `options.env`, opens
 * `BundleHostService/Connect` on `DORIC_ROUTER_URL` with
 * `authorization: Bearer <token>`, and sends `Hello { protocolVersion: 1,
 * instance, services, httpPort }`, `httpPort` the port of
 * `definition.httpServer` once bound to `127.0.0.1:0`, else 0.
 *
 * Resolves with the running bundle once `Accepted` arrives. Rejects with a
 * `HostGoneError` when the host is gone before (a spawn variable missing or
 * malformed, `Rejected`, the stream's end, no `Accepted` within
 * `helloTimeoutMs`), after calling `options.exit(EXIT_HOST_GONE)`. Rejects
 * with a `TypeError`, without calling `exit`, for a definition it cannot
 * run (a service listed twice, an `httpServer` already listening). Rejects
 * with the listen error, without calling `exit` and without opening the
 * stream, when `httpServer` cannot bind `127.0.0.1:0`.
 *
 * Once accepted it answers, until it exits: `Activate` with `ActivateResult`
 * (see {@link BundleDefinition.activate}); each `HealthCheck` with a
 * `HealthReply` of the same nonce, from its stream reader without running
 * bundle code; each `GenerationChanged` with a `GenerationAck` of its
 * event once the `context.generations.onChanged` handlers settled or
 * `generationAckTimeoutMs` (10 s) passed (`createGenerations`), calls in
 * flight running on; each `PeerSignal` by calling the
 * `context.generations.onSignal` handlers; `Stop` with
 * `StopResult` after `deactivate`, then
 * `exit(EXIT_STOPPED)`. The stream's end without `Stop` calls
 * `exit(EXIT_HOST_GONE)`.
 *
 * `context.log` is the queue of `createLogQueue({ instance, timings:
 * options.logTimings, output: options.logOutput })`: records wait until
 * `Accepted`, which starts the queue with `definition.logSink?.(context) ??
 * routerLogSink(…)`. On `Stop` the queue's `stop()` runs after `deactivate`
 * settled and before `httpServer` closes and `StopResult` is sent. Every
 * call of `options.exit` is preceded by the queue's `flushSync()`: for code
 * 0, for code 70 (the host gone, before or after `Accepted`) and for a
 * spawn environment that does not parse.
 */
export const startBundle = async <const T extends readonly DescService[] = []>(
  definition: BundleDefinition<T>,
  options: StartBundleOptions,
): Promise<RunningBundle> => launchBundle(definition, options);

/**
 * `startBundle`, calling `onQueue` with `context.log`'s queue as soon as it
 * exists (`runBundle`'s process handlers use it).
 */
const launchBundle = async <const T extends readonly DescService[] = []>(
  definition: BundleDefinition<T>,
  options: StartBundleOptions,
  onQueue?: (queue: LogQueue) => void,
): Promise<RunningBundle> => {
  const services = serviceNames(definition.services ?? []);

  if (definition.httpServer?.listening === true) {
    throw new TypeError('The httpServer of a bundle must not be listening.');
  }

  const host = new HostLink(options.exit, options.bundleDir);
  let spawn: SpawnEnvironment;

  try {
    spawn = readSpawnEnvironment(options.env);
  } catch (error) {
    host.exit(EXIT_HOST_GONE);
    throw error;
  }

  delete options.env.DORIC_INSTANCE_TOKEN;

  const httpPort =
    definition.httpServer === undefined
      ? 0
      : await listenLocally(definition.httpServer);

  const queue = createLogQueue({
    instance: spawn.instance,
    ...(options.logTimings === undefined
      ? {}
      : { timings: options.logTimings }),
    ...(options.logOutput === undefined ? {} : { output: options.logOutput }),
  });

  onQueue?.(queue);
  await host.connect(
    spawn,
    services,
    httpPort,
    definition,
    queue,
    options.helloTimeoutMs,
  );

  return { instance: spawn.instance, exited: host.exited };
};

/**
 * The program of a host part's `src/host/main.ts`: `startBundle` over
 * `process.env`, `process.exit` and the bundle directory two above
 * `process.argv[1]`. Returns at once; the process lives until
 * the SDK exits it (code 0 after `Stop`, 70 when the host is gone). A
 * definition `startBundle` rejects with a `TypeError` ends the process as an
 * unhandled rejection (code 1).
 *
 * Before `startBundle` it installs these process handlers around
 * `context.log`'s queue:
 * - `exit`: the queue's `flushSync()`, so what waits reaches stdout;
 * - `uncaughtException`: logs `error` `uncaught exception` with `{ error:
 *   <message>, stack }`, then `process.exit(1)`;
 * - `unhandledRejection`: logs `error` `unhandled rejection` with `{ error:
 *   <message> }`, then `process.exit(1)`; a `HostGoneError` rejection of
 *   `startBundle` itself is still swallowed;
 * - `SIGTERM` and `SIGINT`: `flushSync()`, then each removes itself and
 *   raises its signal again (`process.kill(process.pid, signal)`), so the
 *   process ends as the signal's default would.
 */
export const runBundle = <const T extends readonly DescService[] = []>(
  definition: BundleDefinition<T>,
): void => {
  const main = process.argv[1];

  launchBundle(
    definition,
    {
      env: process.env,
      exit: (code) => process.exit(code),
      ...(main === undefined
        ? {}
        : { bundleDir: resolve(dirname(main), '..', '..') }),
    },
    installProcessHandlers,
  ).catch((error: unknown) => {
    if (error instanceof HostGoneError) {
      return;
    }

    throw error;
  });
};

/** `runBundle`'s process handlers around `queue` (see `runBundle`). */
const installProcessHandlers = (queue: LogQueue): void => {
  process.on('exit', () => queue.flushSync());
  process.on('uncaughtException', (error) => {
    queue.log.error('uncaught exception', {
      error: messageOf(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    queue.log.error('unhandled rejection', { error: messageOf(reason) });
    process.exit(1);
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const raise = (): void => {
      queue.flushSync();
      process.off(signal, raise);
      process.kill(process.pid, signal);
    };

    process.on(signal, raise);
  }
};

/** The spawn variables of section 7, "Spawn", parsed. */
interface SpawnEnvironment {
  readonly routerUrl: string;
  readonly token: string;
  readonly instance: BundleInstance;
}

const maxUint32 = 0xffff_ffff;

/** Reads the spawn variables; throws a `HostGoneError` of `environment`. */
const readSpawnEnvironment = (
  env: Readonly<Record<string, string | undefined>>,
): SpawnEnvironment => {
  const required = (name: string): string => {
    const value = env[name];

    if (value === undefined || value === '') {
      throw new HostGoneError('environment', `${name} is not set.`);
    }

    return value;
  };
  const uint32 = (name: string): number => {
    const value = required(name);
    const parsed = Number(value);

    if (!/^\d+$/.test(value) || parsed > maxUint32) {
      throw new HostGoneError(
        'environment',
        `${name} is not an unsigned 32-bit integer: ${value}.`,
      );
    }

    return parsed;
  };
  const routerUrl = required('DORIC_ROUTER_URL');

  if (!URL.canParse(routerUrl)) {
    throw new HostGoneError(
      'environment',
      `DORIC_ROUTER_URL is not a URL: ${routerUrl}.`,
    );
  }

  return {
    routerUrl,
    token: required('DORIC_INSTANCE_TOKEN'),
    instance: {
      bundleId: required('DORIC_BUNDLE_ID'),
      generation: uint32('DORIC_GENERATION'),
      incarnation: uint32('DORIC_INCARNATION'),
    },
  };
};

/**
 * Binds `server` to `127.0.0.1:0`; resolves with its port, rejects with the
 * listen error.
 */
const listenLocally = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    const failed = (error: Error): void => {
      server.off('listening', listening);
      reject(error);
    };
    const listening = (): void => {
      server.off('error', failed);
      resolve((server.address() as AddressInfo).port);
    };

    server.once('error', failed);
    server.once('listening', listening);
    server.listen(0, '127.0.0.1');
  });

/** The full names of `services`; throws a `TypeError` on a duplicate. */
const serviceNames = (services: readonly ServiceEntry[]): string[] => {
  const names: string[] = [];

  for (const [service] of services) {
    if (names.includes(service.typeName)) {
      throw new TypeError(`The service ${service.typeName} is listed twice.`);
    }

    names.push(service.typeName);
  }

  return names;
};

/** The frames the bundle sends: the request stream of the control call. */
class Outbox implements AsyncIterable<ConnectRequest> {
  /** Resolves once the transport has read the end of the stream. */
  readonly drained: Promise<void>;

  private readonly frames: ConnectRequest[] = [];
  private closed = false;
  private wake: (() => void) | undefined;
  private markDrained!: () => void;

  constructor() {
    this.drained = new Promise((resolve) => {
      this.markDrained = resolve;
    });
  }

  push(frame: ConnectRequest): void {
    if (this.closed) {
      return;
    }

    this.frames.push(frame);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ConnectRequest> {
    try {
      for (;;) {
        const next = this.frames.shift();

        if (next !== undefined) {
          yield next;
          continue;
        }

        if (this.closed) {
          return;
        }

        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = undefined;
      }
    } finally {
      this.markDrained();
    }
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The sink of `context.log`'s queue: `definition.logSink`'s, else
 * `defaultSink`'s; a sink whose every call rejects when `logSink` throws.
 */
const logSinkOf = <T extends readonly DescService[]>(
  definition: BundleDefinition<T>,
  context: HostContext,
  defaultSink: () => LogSink,
): LogSink => {
  if (definition.logSink === undefined) {
    return defaultSink();
  }

  try {
    return definition.logSink(context);
  } catch (error) {
    return {
      writeBatch: () => Promise.reject(error),
      watchRedactions: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(error),
        }),
      }),
    };
  }
};

/** A plain `BundleInstance` of a generated `Instance`. */
const instanceOf = (instance: Instance): BundleInstance => ({
  bundleId: instance.bundleId,
  generation: instance.generation,
  incarnation: instance.incarnation,
});

/** One bundle's control stream, from the Hello to the exit. */
class HostLink {
  /** Resolves with the code passed to `exit`. */
  readonly exited: Promise<number>;

  private exitCode: number | undefined;
  private markExited!: (code: number) => void;
  private readonly outbox = new Outbox();
  private readonly call = new AbortController();
  private readonly stopped = new AbortController();
  /** Aborted when the control stream ends without `Stop`. */
  private readonly gone = new AbortController();
  private sessions: Http2SessionManager | undefined;
  private calls: CallServer | undefined;
  private replays: Replays | undefined;
  private generations: Generations | undefined;
  private accepted = false;
  private stopping = false;
  private activation: Promise<boolean> | undefined;
  private queue: LogQueue | undefined;
  private streamDone!: Promise<void>;
  private settleHello:
    | { resolve: () => void; reject: (error: HostGoneError) => void }
    | undefined;
  private helloTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly exitProcess: (code: number) => void,
    private readonly bundleDir: string | undefined,
  ) {
    this.exited = new Promise((resolve) => {
      this.markExited = resolve;
    });
  }

  /** Calls `exit` once, then sends nothing more and closes the session. */
  exit(code: number): void {
    if (this.exitCode !== undefined) {
      return;
    }

    this.exitCode = code;
    clearTimeout(this.helloTimer);
    this.outbox.close();
    this.call.abort();
    this.sessions?.abort();
    this.queue?.flushSync();
    this.exitProcess(code);
    this.markExited(code);
  }

  /** Opens the stream and says Hello; resolves on `Accepted`. */
  connect<T extends readonly DescService[]>(
    spawn: SpawnEnvironment,
    services: readonly string[],
    httpPort: number,
    definition: BundleDefinition<T>,
    queue: LogQueue,
    helloTimeoutMs = timings.helloTimeoutMs,
  ): Promise<void> {
    this.sessions = new Http2SessionManager(spawn.routerUrl);
    this.queue = queue;

    const sessionManager = this.sessions;
    const { log } = queue;
    const replays = createReplays({
      transport: (options) =>
        createRouterTransport({
          url: spawn.routerUrl,
          token: spawn.token,
          sessionManager,
          ...(options.provider === undefined
            ? {}
            : { provider: options.provider }),
          ...(options.target === undefined ? {} : { target: options.target }),
          ...(options.scope === undefined ? {} : { scope: options.scope }),
        }),
      replayDone: (contractId, instance) =>
        this.send({
          frame: { case: 'replayDone', value: { contractId, instance } },
        }),
      log,
    });
    const generations = createGenerations({ instance: spawn.instance, log });
    const context: HostContext = {
      instance: spawn.instance,
      services: replays.services,
      registrations: replays.registrations,
      instances: replays.instances,
      generations: generations.api,
      assets: createHostAssets({
        bundleDir: this.bundleDir,
        bundleId: spawn.instance.bundleId,
      }),
      log,
      signal: this.stopped.signal,
    };

    this.replays = replays;
    this.generations = generations;

    const hello = new Promise<void>((resolve, reject) => {
      this.settleHello = { resolve, reject };
    });

    this.helloTimer = setTimeout(
      () =>
        this.goneBeforeAccepted(
          'hello_timeout',
          `No Accepted within ${helloTimeoutMs} ms.`,
        ),
      helloTimeoutMs,
    );
    this.calls = createCallServer({
      services: definition.services ?? [],
      send: (frame) => this.send(frame),
      signal: this.gone.signal,
      ...(definition.invalidInput === undefined
        ? {}
        : { invalidInput: definition.invalidInput }),
    });

    const client = createClient(
      BundleHostService,
      createGrpcTransport({
        baseUrl: spawn.routerUrl,
        sessionManager: this.sessions,
      }),
    );

    this.send({
      frame: {
        case: 'hello',
        value: {
          protocolVersion: 1,
          instance: spawn.instance,
          services: [...services],
          httpPort,
        },
      },
    });
    this.streamDone = this.read(
      client.connect(this.outbox, {
        headers: { authorization: `Bearer ${spawn.token}` },
        signal: this.call.signal,
      }),
      definition,
      context,
      () =>
        routerLogSink({
          url: spawn.routerUrl,
          token: spawn.token,
          sessionManager,
        }),
    );

    return hello;
  }

  private send(frame: MessageInitShape<typeof ConnectRequestSchema>): void {
    if (this.exitCode !== undefined) {
      return;
    }

    this.outbox.push(create(ConnectRequestSchema, frame));
  }

  /** Reads the router's frames until the stream ends, then handles the end. */
  private async read<T extends readonly DescService[]>(
    responses: AsyncIterable<ConnectResponse>,
    definition: BundleDefinition<T>,
    context: HostContext,
    defaultSink: () => LogSink,
  ): Promise<void> {
    let received = false;

    try {
      for await (const response of responses) {
        received = true;

        if (this.exitCode !== undefined) {
          return;
        }

        this.receive(response, definition, context, defaultSink);
      }

      this.ended('The control stream ended.');
    } catch (error) {
      const unopened =
        !received &&
        error instanceof ConnectError &&
        error.code === Code.Unavailable;

      // A stream that could not be opened waits for the Hello timeout.
      if (!(unopened && !this.accepted)) {
        this.ended(`The control stream failed: ${messageOf(error)}`);
      }
    }
  }

  private receive<T extends readonly DescService[]>(
    response: ConnectResponse,
    definition: BundleDefinition<T>,
    context: HostContext,
    defaultSink: () => LogSink,
  ): void {
    const { frame } = response;

    if (!this.accepted) {
      if (frame.case === 'accepted') {
        this.accepted = true;
        clearTimeout(this.helloTimer);
        this.queue?.start(logSinkOf(definition, context, defaultSink));
        this.settleHello?.resolve();
      } else if (frame.case === 'rejected') {
        this.goneBeforeAccepted(
          'rejected',
          `The router rejected the Hello: ${frame.value.reason}: ${frame.value.message}`,
        );
      }

      return;
    }

    switch (frame.case) {
      case 'healthCheck':
        this.send({
          frame: { case: 'healthReply', value: { nonce: frame.value.nonce } },
        });
        return;
      case 'activate':
        this.activation ??= this.activate(definition, context);
        return;
      case 'generationChanged': {
        const { event } = frame.value;

        void this.generations
          ?.changed(frame.value)
          .then(() =>
            this.send({ frame: { case: 'generationAck', value: { event } } }),
          );
        return;
      }
      case 'peerSignal':
        this.generations?.signal(frame.value);
        return;
      case 'instanceGone':
        if (frame.value.instance !== undefined) {
          this.replays?.instanceGone(instanceOf(frame.value.instance));
        }

        return;
      case 'providerChanged':
        if (frame.value.instance !== undefined) {
          this.replays?.providerChanged(
            frame.value.contractId,
            instanceOf(frame.value.instance),
          );
        }

        return;
      case 'callStart':
      case 'callMessage':
      case 'callHalfClose':
      case 'callCancel':
      case 'callCredit':
        this.calls?.receive(frame);
        return;
      case 'stop':
        if (!this.stopping) {
          this.stopping = true;
          void this.stop(definition, context);
        }

        return;
      default:
        return;
    }
  }

  /** Runs `activate` and answers `ActivateResult`; resolves with success. */
  private async activate<T extends readonly DescService[]>(
    definition: BundleDefinition<T>,
    context: HostContext,
  ): Promise<boolean> {
    try {
      await definition.activate(context);
      this.send({
        frame: {
          case: 'activateResult',
          value: { status: create(StatusSchema) },
        },
      });

      return true;
    } catch (error) {
      const contractError = isContractError(error)
        ? error
        : new ContractError('internal', messageOf(error));

      this.send({
        frame: {
          case: 'activateResult',
          value: { status: toStatus(contractError) },
        },
      });

      return false;
    }
  }

  /** Aborts the signal, runs `deactivate`, answers `StopResult`, exits 0. */
  private async stop<T extends readonly DescService[]>(
    definition: BundleDefinition<T>,
    context: HostContext,
  ): Promise<void> {
    this.stopped.abort();

    if (
      this.activation !== undefined &&
      (await this.activation) &&
      definition.deactivate !== undefined
    ) {
      try {
        await definition.deactivate(context);
      } catch (error) {
        context.log.error('deactivate failed', { error: messageOf(error) });
      }
    }

    await this.queue?.stop();

    if (definition.httpServer?.listening === true) {
      definition.httpServer.close();
    }

    this.send({ frame: { case: 'stopResult', value: {} } });
    this.outbox.close();
    await Promise.race([this.outbox.drained, this.streamDone]);
    this.exit(EXIT_STOPPED);
  }

  /** The stream ended: before `Accepted` it is `closed`, after it exit 70. */
  private ended(message: string): void {
    if (this.exitCode !== undefined || this.stopping) {
      return;
    }

    if (!this.accepted) {
      this.goneBeforeAccepted('closed', message);

      return;
    }

    this.stopped.abort(new HostGoneError('closed', message));
    this.gone.abort(new HostGoneError('closed', message));
    this.exit(EXIT_HOST_GONE);
  }

  private goneBeforeAccepted(reason: HostGoneReason, message: string): void {
    if (this.accepted || this.exitCode !== undefined) {
      return;
    }

    this.exit(EXIT_HOST_GONE);
    this.settleHello?.reject(new HostGoneError(reason, message));
  }
}
