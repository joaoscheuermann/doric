// The in-memory router of `bundle/testing` (spec
// `docs/designs/grpc-processes.md`, section 10, A61): a bundle's tests
// activate its host part, call its services and fake its dependencies in one
// process, over `createRouterTransport` of `@connectrpc/connect` (not the
// host SDK's router transport of `sdk/host/client.ts`). Light at import: it
// opens no socket and loads no `node:http2`.

import {
  create,
  type DescMessage,
  type DescMethod,
  type DescService,
  getOption,
  hasOption,
  type MessageInitShape,
  type MessageShape,
} from '@bufbuild/protobuf';
import { createValidator } from '@bufbuild/protovalidate';
import {
  type Client,
  createClient,
  createRouterTransport,
  decodeBinaryHeader,
  encodeBinaryHeader,
  type HandlerContext,
  type ServiceImpl,
  type Transport,
} from '@connectrpc/connect';

import type { Log, LogFields } from '../contracts/basic/log.js';
import {
  type Call,
  type Caller,
  type CallScope,
  callScopeSchema,
  deadlineOf,
} from '../contracts/call.js';
import { ContractError, toContractError } from '../contracts/error.js';
import {
  CallStartSchema,
  GenerationChangedSchema,
  PeerSignalSchema,
} from '../contracts/gen/doric/platform/v1/control_pb.js';
import { contract as contractOption } from '../contracts/gen/doric/platform/v1/options_pb.js';
import { isPlatformContract } from '../contracts/ids.js';
import { callContextKey, callerIncarnationKey } from '../contracts/metadata.js';
import { toConnectError } from '../contracts/status.js';
import { abortAtDeadline, anySignal } from '../runtime/call.js';
import { childTrace, newTrace } from '../runtime/trace.js';
import { createHostAssets } from '../sdk/host/assets.js';
import type { BundleInstance, HostContext } from '../sdk/host/context.js';
import { createGenerations } from '../sdk/host/generations.js';
import { createReplays } from '../sdk/host/replay.js';
import type { BundleDefinition, ServiceEntry } from '../sdk/host/run.js';
import { callFromStart, currentCall, runInCall } from '../sdk/host/serve.js';

/** What {@link createTestRouter} sets up. */
export interface TestRouterOptions {
  /**
   * The dependencies of the bundle under test: one `[Service,
   * implementation]` per service, served in process. Default `[]`. A service
   * listed twice makes `createTestRouter` throw a `TypeError`.
   *
   * A fake's handler runs with a `HandlerContext` whose `callOf` answers the
   * `Call` of the request: `caller` is the bundle under test
   * (`{ bundleId: instance.bundleId, version: '0.0.0', generation:
   * instance.generation }`); `scope` the scope of the call it was made from
   * (absent outside a handler, in `activate` for example, or when that call
   * had none); `trace` a child of that call's trace (a new trace outside a
   * handler); `signal` aborted when the caller cancels, at the deadline, and
   * on {@link TestRouterControl.stop}; `deadlineOf` the deadline the call
   * carried, 0 when none. A fake that throws a `ContractError` fails the call
   * with it (`fromConnectError` reads the same Doric code); any other value
   * fails it as `internal`.
   */
  readonly fakes?: readonly ServiceEntry[];
  /**
   * The full names (`DescService.typeName`) of the services the bundle under
   * test declares it calls: its `requires` and `optional`, flattened to
   * services, since the test router has no catalog to map contracts to them.
   *
   * Undefined: every service is declared (no enforcement). Given: a call
   * through `context.services.use(ref)` whose `ref.typeName` is neither
   * listed nor one of the bundle's own `services`, and whose file's
   * `(doric.platform.v1.contract).id` is not a `doric.*` platform contract
   * (`isPlatformContract`; those are always declared, as `routeCall`
   * step 3 exempts them), fails with
   * `PERMISSION_DENIED`, reason `undeclared_requirement`, whether or not a
   * fake serves it, as `routeCall` refuses it (step 3). A declared service
   * that neither a fake nor the bundle serves fails with `UNAVAILABLE`,
   * reason `unavailable`. `UseOptions.provider` and `UseOptions.target` are
   * ignored: a service has at most one fake. `UseOptions.resume` applies as
   * in the host SDK: a fake's resumable stream that ends with
   * `generation_lost` is opened again.
   */
  readonly requires?: readonly string[];
  /**
   * The caller the bundle's handlers see in `callOf(context).caller` for a
   * call made through {@link TestRouter.client}; default
   * `{ bundleId: 'test', version: '0.0.0', generation: 1 }`, the caller of
   * `createTestServices`. {@link TestClientOptions.caller} overrides it per
   * client.
   */
  readonly caller?: Caller;
  /**
   * The scope of every call made through {@link TestRouter.client}, as the
   * router would read it from `doric-scope-bin`; default none
   * (`callOf(context).scope` absent). A scope that breaks the bounds of
   * `callScopeSchema` makes `createTestRouter` throw a `ContractError`
   * `invalid_scope`. {@link TestClientOptions.scope} overrides it per client.
   */
  readonly scope?: CallScope;
  /**
   * The instance the bundle under test is, as `context.instance` answers it;
   * default `{ bundleId: 'test-bundle', generation: 1, incarnation: 1 }`.
   * Fields left out take their default.
   */
  readonly instance?: Partial<BundleInstance>;
  /**
   * The bundle directory of the bundle under test, as
   * `StartBundleOptions.bundleDir` gives it: `context.assets` reads its
   * `manifest.json`'s `host.assets` and its files, and `require` resolves
   * from it, as in development. Absent: `context.assets` rejects (`require`
   * throws) with an `Error` naming the bundle.
   */
  readonly bundleDir?: string;
}

/** How one {@link TestRouter.client} calls the bundle under test. */
export interface TestClientOptions {
  /** Replaces {@link TestRouterOptions.caller} for this client's calls. */
  readonly caller?: Caller;
  /**
   * Replaces {@link TestRouterOptions.scope} for this client's calls; same
   * bounds: `client` throws the same `ContractError` `invalid_scope`.
   */
  readonly scope?: CallScope;
}

/** One record the bundle under test wrote through `context.log`. */
export interface TestLogRecord {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly fields?: LogFields;
}

/** The control frames a test sends the bundle, as the host would. */
export interface TestRouterControl {
  /**
   * Sends the bundle under test a `GenerationChanged` as the router would
   * (section 6): runs its `context.generations.onChanged` handlers as the
   * host SDK does (`createGenerations`), with `self` the test's instance and
   * `generation` and `incarnation` those of `event.subject`, or of the
   * test's instance without one. Resolves when the host SDK would answer
   * `GenerationAck`: once every handler settled, or 10 s
   * (`generationAckTimeoutMs`) after the call; at once with no handler,
   * before `activate` and after `stop`, where no handler runs. A handler's
   * failure is recorded in {@link TestRouter.logs} at level `error`. Never
   * rejects. The router sends nothing else: no state changes, no call ends.
   */
  generationChanged(
    event: MessageInitShape<typeof GenerationChangedSchema>,
  ): Promise<void>;
  /**
   * Delivers the bundle under test a `PeerSignal` as the router would
   * (section 6): calls its `context.generations.onSignal` handlers in order,
   * with `self` the test's instance and `live` the last `generationChanged`
   * frame's (the test's instance alone as `active` before any). Resolves
   * once every handler was called and its promise settled; at once before
   * `activate` and after `stop`, where no handler runs. A handler's
   * failure is recorded in {@link TestRouter.logs} at level `error`. Never
   * rejects.
   */
  peerSignal(signal: MessageInitShape<typeof PeerSignalSchema>): Promise<void>;
  /**
   * Stops the bundle as `Stop` does: aborts `context.signal`, then runs
   * `deactivate` once, only when `activate` resolved; its failure is
   * recorded in {@link TestRouter.logs} at level `error`, message
   * `deactivate failed`, never thrown. Aborts the signal of every call in
   * flight, to the bundle and to the fakes. Afterwards every call through a
   * client fails with `UNAVAILABLE`, reason `unavailable`, and `activate`
   * rejects with a `TypeError`. Resolves once `deactivate` settled; never
   * rejects; a later call resolves when the first does.
   */
  stop(): Promise<void>;
}

/** One bundle under test, its fakes, and the calls between them. */
export interface TestRouter {
  /**
   * Activates `definition` as `runBundle` would, in this process: serves its
   * `services` from now on and runs `activate` once with a fresh
   * `HostContext` (`instance` of {@link TestRouterOptions.instance};
   * `services.use` routed to the fakes and to the bundle's own services, see
   * {@link TestRouterOptions.requires} and {@link TestRouterOptions.fakes};
   * `log` into {@link TestRouter.logs}; `signal` aborted by
   * {@link TestRouterControl.stop}; `registrations.track` makes its first
   * call and tracks the registration, which is never replayed, since the
   * test router sends no `ProviderChanged`; `instances.onGone` keeps its
   * handlers, which never run, since it sends no `InstanceGone`).
   *
   * Resolves with that context once `activate` resolved. Rejects with what
   * `activate` threw, unchanged; the services stay served until `stop`, as
   * the host SDK keeps the process running. Rejects with a `TypeError`,
   * without running `activate`, when called a second time, after `stop`,
   * when `definition.services` lists a service twice, or when it lists a
   * service also faked.
   */
  activate<const T extends readonly DescService[] = []>(
    definition: BundleDefinition<T>,
  ): Promise<HostContext>;
  /**
   * A Connect client of `ref`, calling the bundle under test in memory.
   * Creating it makes no call; it throws only for an out-of-bounds
   * `options.scope`. Each call reaches the implementation the activated
   * definition lists for `ref`, as the host SDK serves a `CallStart`: the
   * request is validated with protovalidate first (`invalid_input`), and the
   * handler's `callOf(context)` answers a `Call` whose `caller` and `scope`
   * are the options' (see {@link TestRouterOptions.caller}), `trace` a new
   * trace, `signal` aborted when the call's own `signal` aborts, at its
   * `timeoutMs` and on `stop`, and `deadlineOf` that deadline (0 without
   * `timeoutMs`). `currentCall()` answers the same `Call` while the handler
   * runs, so its `context.services.use` calls inherit scope, trace, deadline
   * and signal.
   *
   * A call fails with a `ConnectError` whose Doric code `fromConnectError`
   * reads: `UNAVAILABLE` `unavailable` before `activate` and after `stop`;
   * `UNIMPLEMENTED` `unknown_contract` when the definition does not serve
   * `ref` (fakes are not reachable through a client); otherwise with the
   * handler's error, encoded as for a fake.
   */
  client<S extends DescService>(ref: S, options?: TestClientOptions): Client<S>;
  /** The control frames of the host: generation events and `Stop`. */
  readonly control: TestRouterControl;
  /**
   * What the bundle under test wrote through `context.log`, in order. The
   * array grows as it writes; the test router never clears it.
   */
  readonly logs: readonly TestLogRecord[];
}

/**
 * Creates an in-memory router for one bundle under test. Makes no call, runs
 * no bundle code and opens no socket. Throws a `TypeError` when
 * `options.fakes` lists a service twice, and a `ContractError`
 * `invalid_scope` for an out-of-bounds `options.scope`.
 *
 * Calls between the bundle and its fakes, and from clients to the bundle, go
 * through `createRouterTransport` of `@connectrpc/connect`: each message
 * passes Connect's binary serialization, as a call over the router does.
 */
export const createTestRouter = (
  options: TestRouterOptions = {},
): TestRouter => {
  const fakes = servicesByName(options.fakes ?? [], 'fakes');
  const routerScope = checkedScope(options.scope);
  const routerCaller = options.caller ?? defaultCaller;
  const instance: BundleInstance = Object.freeze({
    ...defaultInstance,
    ...options.instance,
  });
  const bundleCaller: Caller = {
    bundleId: instance.bundleId,
    version: '0.0.0',
    generation: instance.generation,
  };
  const declared =
    options.requires === undefined ? undefined : new Set(options.requires);
  const stopped = new AbortController();
  const logs: TestLogRecord[] = [];
  const fakeTransport = createRouterTransport((router) => {
    for (const [service, implementation] of fakes.values()) {
      router.service(service, served(service, implementation, stopped.signal));
    }
  });
  let phase: 'idle' | 'active' | 'stopped' = 'idle';
  let bundle: ReadonlyMap<string, ServiceEntry> = new Map();
  let bundleTransport: Transport | undefined;
  let deactivation: (() => Promise<void>) | undefined;
  let stopping: Promise<void> | undefined;

  const log: Log = {
    debug: (message, fields) => record(logs, 'debug', message, fields),
    info: (message, fields) => record(logs, 'info', message, fields),
    warn: (message, fields) => record(logs, 'warn', message, fields),
    error: (message, fields) => record(logs, 'error', message, fields),
  };

  /** The transport `context.services.use` reaches `typeName` through. */
  const useTarget = (typeName: string, service: DescService): Transport => {
    const own = bundle.has(typeName) ? bundleTransport : undefined;

    if (
      declared !== undefined &&
      own === undefined &&
      !declared.has(typeName) &&
      !isPlatformService(service)
    ) {
      throw failure(
        'undeclared_requirement',
        `The bundle does not declare that it calls ${typeName}.`,
      );
    }

    if (own !== undefined) {
      return own;
    }

    if (fakes.has(typeName)) {
      return fakeTransport;
    }

    throw failure('unavailable', `No provider of ${typeName} is available.`);
  };

  /** The transport a client reaches `typeName` of the bundle through. */
  const clientTarget = (typeName: string): Transport => {
    if (phase !== 'active' || bundleTransport === undefined) {
      throw failure('unavailable', 'The bundle under test is not active.');
    }

    if (!bundle.has(typeName)) {
      throw failure(
        'unknown_contract',
        `The bundle under test does not serve ${typeName}.`,
      );
    }

    return bundleTransport;
  };

  // `bundle/testing` sends no `ProviderChanged` and no `InstanceGone`:
  // `track` makes its first call and tracks it without a replay, and the
  // `onGone` handlers never run.
  const replays = createReplays({
    transport: () =>
      hopTransport(useTarget, () => {
        const parent = currentCall();

        return {
          caller: bundleCaller,
          ...(parent?.scope === undefined ? {} : { scope: parent.scope }),
          ...(parent === undefined ? {} : { parent }),
        };
      }),
    replayDone: () => {},
    log,
  });
  const generations = createGenerations({ instance, log });
  const context: HostContext = {
    instance,
    services: replays.services,
    registrations: replays.registrations,
    instances: replays.instances,
    generations: generations.api,
    assets: createHostAssets({
      bundleDir: options.bundleDir,
      bundleId: instance.bundleId,
    }),
    log,
    signal: stopped.signal,
  };

  return {
    activate: async (definition) => {
      if (phase !== 'idle') {
        throw new TypeError(
          phase === 'active'
            ? 'The bundle under test is already activated.'
            : 'The bundle under test is stopped.',
        );
      }

      const own = servicesByName(definition.services ?? [], 'services');

      for (const typeName of own.keys()) {
        if (fakes.has(typeName)) {
          throw new TypeError(
            `The bundle under test serves ${typeName}, which a fake serves too.`,
          );
        }
      }

      phase = 'active';
      bundle = own;
      bundleTransport = createRouterTransport((router) => {
        for (const [service, implementation] of own.values()) {
          router.service(
            service,
            served(service, implementation, stopped.signal),
          );
        }
      });

      await definition.activate(context);

      const { deactivate } = definition;

      if (deactivate !== undefined) {
        deactivation = async () => {
          await deactivate.call(definition, context);
        };
      }

      return context;
    },
    client: (ref, clientOptions = {}) => {
      const scope =
        clientOptions.scope === undefined
          ? routerScope
          : checkedScope(clientOptions.scope);
      const caller = clientOptions.caller ?? routerCaller;

      return createClient(
        ref,
        hopTransport(clientTarget, () => ({
          caller,
          ...(scope === undefined ? {} : { scope }),
        })),
      );
    },
    control: {
      generationChanged: (event) =>
        phase === 'active'
          ? generations.changed(create(GenerationChangedSchema, event))
          : Promise.resolve(),
      peerSignal: (signal) =>
        phase === 'active'
          ? generations.signalled(create(PeerSignalSchema, signal))
          : Promise.resolve(),
      stop: () => {
        stopping ??= (async () => {
          phase = 'stopped';
          stopped.abort(new Error('The bundle under test stopped.'));

          try {
            await deactivation?.();
          } catch (error) {
            log.error('deactivate failed', { error: messageOf(error) });
          }
        })();

        return stopping;
      },
    },
    logs,
  };
};

const defaultCaller: Caller = Object.freeze({
  bundleId: 'test',
  version: '0.0.0',
  generation: 1,
});

const defaultInstance: BundleInstance = Object.freeze({
  bundleId: 'test-bundle',
  generation: 1,
  incarnation: 1,
});

/**
 * The request header that carries a call's `Call` from the calling side to
 * the handler, as the `CallStart` the host SDK would receive: caller, scope,
 * traceparent and absolute deadline. Only the in-memory transports of this
 * module set and read it.
 */
const callHeader = 'doric-test-call-bin';

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const record = (
  logs: TestLogRecord[],
  level: TestLogRecord['level'],
  message: string,
  fields: LogFields | undefined,
): void => {
  logs.push(
    Object.freeze({
      level,
      message,
      ...(fields === undefined ? {} : { fields }),
    }),
  );
};

/**
 * Whether `service` belongs to a `doric.*` platform contract: its file's
 * `(doric.platform.v1.contract).id` is one (`isPlatformContract`), as
 * `routeCall` reads it; the package name does not count.
 */
const isPlatformService = (service: DescService): boolean =>
  hasOption(service.file, contractOption) &&
  isPlatformContract(getOption(service.file, contractOption).id);

/** The `ConnectError` a call fails with for the Doric `code`. */
const failure = (code: string, message: string): Error =>
  toConnectError(new ContractError(code, message));

/** `scope`, frozen; a `ContractError` `invalid_scope` when out of bounds. */
const checkedScope = (scope: CallScope | undefined): CallScope | undefined => {
  if (scope === undefined) {
    return undefined;
  }

  const parsed = callScopeSchema.safeParse({ ...scope });

  if (!parsed.success) {
    throw new ContractError(
      'invalid_scope',
      `The scope breaks the scope bounds: ${parsed.error.message}`,
    );
  }

  return Object.freeze(parsed.data);
};

/** `entries` by full service name; a `TypeError` for a service listed twice. */
const servicesByName = (
  entries: readonly ServiceEntry[],
  list: string,
): ReadonlyMap<string, ServiceEntry> => {
  const byName = new Map<string, ServiceEntry>();

  for (const entry of entries) {
    if (byName.has(entry[0].typeName)) {
      throw new TypeError(`${list} lists ${entry[0].typeName} twice.`);
    }

    byName.set(entry[0].typeName, entry);
  }

  return byName;
};

/** Who makes the calls of a {@link hopTransport}, read when each call starts. */
interface Hop {
  readonly caller: Caller;
  readonly scope?: CallScope;
  /** The call the hop is made from: its deadline, trace and signal carry over. */
  readonly parent?: Call;
}

/**
 * A transport that stamps each call with the `Call` of `hop()` (in
 * {@link callHeader}) and passes it to the transport `target` answers for the
 * method's service; `target` throws the `ConnectError` the call fails with.
 * The deadline is the earliest of the call's `timeoutMs` and the parent's.
 */
const hopTransport = (
  target: (typeName: string, service: DescService) => Transport,
  hop: () => Hop,
): Transport => {
  const prepare = (
    method: DescMethod,
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
    header: ConstructorParameters<typeof Headers>[0],
  ) => {
    const transport = target(method.parent.typeName, method.parent);
    const { caller, scope, parent } = hop();
    const own =
      timeoutMs !== undefined && timeoutMs > 0 ? Date.now() + timeoutMs : 0;
    const inherited = parent === undefined ? 0 : deadlineOf(parent);
    const deadline =
      own === 0 || (inherited > 0 && inherited < own) ? inherited : own;
    const start = create(CallStartSchema, {
      method: `/${method.parent.typeName}/${method.name}`,
      caller,
      scope: { ...scope },
      traceparent: (parent === undefined
        ? newTrace()
        : childTrace(parent.trace)
      ).traceparent,
      deadlineUnixMs: deadline,
    });
    const headers = new Headers(header);
    const signals = [signal, parent?.signal].filter(
      (item): item is AbortSignal => item !== undefined,
    );

    headers.set(callHeader, encodeBinaryHeader(start, CallStartSchema));

    return {
      transport,
      signal: signals.length === 0 ? undefined : anySignal(signals),
      timeoutMs: deadline > 0 ? Math.max(1, deadline - Date.now()) : undefined,
      headers,
    };
  };

  return {
    unary: async (method, signal, timeoutMs, header, input, contextValues) => {
      const call = prepare(method, signal, timeoutMs, header);

      return await call.transport.unary(
        method,
        call.signal,
        call.timeoutMs,
        call.headers,
        input,
        contextValues,
      );
    },
    stream: async (method, signal, timeoutMs, header, input, contextValues) => {
      const call = prepare(method, signal, timeoutMs, header);

      return await call.transport.stream(
        method,
        call.signal,
        call.timeoutMs,
        call.headers,
        input,
        contextValues,
      );
    },
  };
};

/** A method of a service implementation, as Connect calls it. */
type Handler = (input: unknown, context: HandlerContext) => unknown;

/**
 * `implementation`, served as the host SDK serves a `CallStart`: each handler
 * gets the `Call` of {@link callHeader} under `callContextKey` and as
 * `currentCall()`, with a signal that also aborts at its deadline and on
 * `stopped`; the request is validated with protovalidate first; an error
 * fails the call as `toContractError` encodes it.
 */
const served = (
  service: DescService,
  implementation: object,
  stopped: AbortSignal,
): ServiceImpl<DescService> => {
  const handlers: Record<string, Handler> = {};

  for (const method of service.methods) {
    const handler = (implementation as Record<string, unknown>)[
      method.localName
    ];

    if (typeof handler !== 'function') {
      continue;
    }

    handlers[method.localName] = (input, context) => {
      const call = callOfRequest(context, stopped);
      const streamsRequest =
        method.methodKind === 'client_streaming' ||
        method.methodKind === 'bidi_streaming';
      const respond = (): unknown =>
        runInCall(call, () =>
          (handler as Handler)(
            streamsRequest
              ? validEach(method.input, input as AsyncIterable<unknown>)
              : valid(method.input, input),
            context,
          ),
        );

      context.values.set(callContextKey, call);
      // The test router runs one instance of each caller: incarnation 1.
      context.values.set(callerIncarnationKey, 1);

      return method.methodKind === 'server_streaming' ||
        method.methodKind === 'bidi_streaming'
        ? streamed(call, respond)
        : answered(respond);
    };
  }

  return handlers as ServiceImpl<DescService>;
};

/** The response of a unary or client-streaming handler. */
const answered = async (respond: () => unknown): Promise<unknown> => {
  try {
    return await respond();
  } catch (error) {
    throw toConnectError(toContractError(error));
  }
};

/** The responses of a streaming handler, each taken inside its call. */
async function* streamed(
  call: Call,
  respond: () => unknown,
): AsyncGenerator<unknown> {
  try {
    const responses = (await respond()) as AsyncIterable<unknown>;
    const iterator = responses[Symbol.asyncIterator]();

    for (;;) {
      const next = await runInCall(call, () => iterator.next());

      if (next.done === true) {
        return;
      }

      yield next.value;
    }
  } catch (error) {
    throw toConnectError(toContractError(error));
  }
}

/** The `Call` a request carries in {@link callHeader}; see `callFromStart`. */
const callOfRequest = (context: HandlerContext, stopped: AbortSignal): Call => {
  const value = context.requestHeader.get(callHeader);
  const start =
    value === null
      ? create(CallStartSchema, { traceparent: newTrace().traceparent })
      : decodeBinaryHeader(value, CallStartSchema);
  const deadline = new AbortController();

  if (start.deadlineUnixMs > 0) {
    abortAtDeadline(deadline, start.deadlineUnixMs, Date.now);
  }

  return callFromStart(
    start,
    anySignal([context.signal, stopped, deadline.signal]),
  );
};

const validator = createValidator();

/** `message`, when it keeps its protovalidate rules; else `invalid_input`. */
const valid = <Desc extends DescMessage>(
  schema: Desc,
  message: unknown,
): MessageShape<Desc> => {
  const result = validator.validate(schema, message as MessageShape<Desc>);

  if (result.kind !== 'valid') {
    throw new ContractError('invalid_input', result.error.message);
  }

  return message as MessageShape<Desc>;
};

/** The request messages of a stream, each checked by {@link valid}. */
async function* validEach(
  schema: DescMessage,
  messages: AsyncIterable<unknown>,
): AsyncGenerator<unknown> {
  for await (const message of messages) {
    yield valid(schema, message);
  }
}
