// A fake `HostClients` (S64, `bundle/runtime`) over `createRouterTransport`
// of `@connectrpc/connect`, for the resources client part's tests of slice
// S65d (the same fake as `chat`'s `tests/support/connect.ts`; each bundle
// keeps its own copy, `bundles/AGENTS.md`): the window's host calls go to
// Connect services a test implements, each message through Connect's binary
// serialization, each call with the scope of its `use` as `doric-scope-bin`,
// and a resumable server stream is reopened after `generation_lost` as
// `ClientPart.use` does.

import { type DescService, getOption } from '@bufbuild/protobuf';
import {
  type CallOptions,
  type Client,
  type ConnectRouter,
  createClient,
  createRouterTransport,
  type Interceptor,
  type Transport,
} from '@connectrpc/connect';
import { type ClientPart, reopenResumable } from 'bundle/client';
import {
  type CallScope,
  type ClientServices,
  type ConnectionStatus,
  ContractError,
  type ContractErrorCode,
  type Disposable,
  type ProviderInfo,
  scopeFromHeader,
  scopeHeader,
  scopeHeaderValue,
  toConnectError,
} from 'bundle/contracts';
import { method as methodOption } from 'bundle/contracts/gen/doric/platform/v1/options_pb.js';
import type { HostClients } from 'bundle/runtime';

/** One call the window made to the host: `<Service>/<Method>`, its part and scope. */
export interface HostCall {
  readonly method: string;
  readonly part: string;
  /** The call's `doric-scope-bin`, read back; absent without one. */
  readonly scope?: CallScope;
}

/** The header the client SDK sets on every call of a part. */
const clientPartHeader = 'doric-client-part';

/** The scope a call carries in `header`, or undefined without one. */
export const scopeIn = (header: Headers): CallScope | undefined => {
  const value = header.get(scopeHeader);

  return value === null ? undefined : { ...scopeFromHeader(value) };
};

/** The scope of the call a handler serves (`context.requestHeader`). */
export const scopeOf = (context: {
  readonly requestHeader: Headers;
}): CallScope | undefined => scopeIn(context.requestHeader);

/**
 * A failure a test's answer threw, as the Connect error the host sends: a
 * `ContractError` keeps its code; anything else with a `code` is read as one;
 * the rest is `internal`.
 */
export const connectFailure = (error: unknown): unknown => {
  if (error instanceof ContractError) return toConnectError(error);
  const failure = error as { code?: string; message?: string } | undefined;

  return toConnectError(
    new ContractError(
      (failure?.code ?? 'internal') as ContractErrorCode,
      failure?.message ?? 'failed',
    ),
  );
};

/** `transport` with `doric-scope-bin: value` on every call, as `ClientPart.use({scope})` sends it. */
const scopedTransport = (transport: Transport, value: string): Transport => {
  const withScope = (
    header: ConstructorParameters<typeof Headers>[0],
  ): Headers => {
    const headers = new Headers(header);
    headers.set(scopeHeader, value);
    return headers;
  };

  return {
    unary: (method, signal, timeoutMs, header, input, contextValues) =>
      transport.unary(
        method,
        signal,
        timeoutMs,
        withScope(header),
        input,
        contextValues,
      ),
    stream: (method, signal, timeoutMs, header, input, contextValues) =>
      transport.stream(
        method,
        signal,
        timeoutMs,
        withScope(header),
        input,
        contextValues,
      ),
  };
};

/**
 * `client` with each resumable server-streaming method reopened after
 * `generation_lost`, with its original request, as `ClientPart.use` does
 * without `resume`.
 */
const resumable = <S extends DescService>(
  service: S,
  client: Client<S>,
): Client<S> => {
  const calls: Record<string, unknown> = { ...client };

  for (const rpc of service.methods) {
    if (
      rpc.methodKind !== 'server_streaming' ||
      !getOption(rpc, methodOption).resumable
    )
      continue;

    const open = calls[rpc.localName] as (
      request: unknown,
      options?: CallOptions,
    ) => AsyncIterable<unknown>;

    calls[rpc.localName] = (request: unknown, options?: CallOptions) =>
      reopenResumable((next) => open(next, options), request);
  }

  return calls as Client<S>;
};

export interface FakeHostClients {
  readonly hostClients: HostClients;
  /** Every call the window's parts made, in call order. */
  readonly calls: HostCall[];
}

/**
 * Host clients whose every part reaches the services `routes` registers;
 * `providers` answers `provider(contractId)`.
 */
export const fakeHostClients = (
  routes: (router: ConnectRouter) => void,
  providers: Readonly<Record<string, ProviderInfo>> = {},
): FakeHostClients => {
  const calls: HostCall[] = [];
  const parts = new Map<string, ClientPart>();

  const partOf = (bundleId: string): ClientPart => {
    const recording: Interceptor = (next) => async (request) => {
      request.header.set(clientPartHeader, bundleId);
      const scope = scopeIn(request.header);
      calls.push({
        method: `${request.service.typeName}/${request.method.name}`,
        part: bundleId,
        ...(scope === undefined ? {} : { scope }),
      });

      return next(request);
    };
    const transport = createRouterTransport(routes, {
      transport: { interceptors: [recording] },
    });

    return {
      bundleId,
      transport,
      use: (ref, options) => {
        const scope = options?.scope;
        const over =
          scope === undefined || Object.keys(scope).length === 0
            ? transport
            : scopedTransport(transport, scopeHeaderValue(scope));

        return resumable(ref, createClient(ref, over));
      },
    };
  };

  return {
    calls,
    hostClients: {
      part: (bundleId) => {
        let part = parts.get(bundleId);

        if (part === undefined) {
          part = partOf(bundleId);
          parts.set(bundleId, part);
        }

        return part;
      },
      provider: (contractId) => providers[contractId],
    },
  };
};

/** A generated service descriptor, as `ClientServices.use` tells it apart. */
export const isDescService = (value: unknown): value is DescService =>
  typeof value === 'object' &&
  value !== null &&
  (value as { readonly kind?: unknown }).kind === 'service' &&
  typeof (value as { readonly typeName?: unknown }).typeName === 'string';

/**
 * What a host contract's `ref<T>()` answers once its client parts call it
 * over Connect: every method rejects, naming the contract, and the rejection
 * is already handled (a caller that drops it raises no unhandled rejection);
 * the promise is also a `Disposable`, as a stream's answer was.
 */
export const onEnvelope = (contract: string): object =>
  new Proxy(Object.create(null) as object, {
    get: (_target, property) =>
      typeof property === 'string' && property !== 'then'
        ? () => {
            const refused = Promise.reject(
              new Error(
                `${contract}.${property} is on the envelope; the host serves it over Connect.`,
              ),
            );
            refused.catch(() => undefined);

            return Object.assign(refused, { dispose: () => undefined });
          }
        : undefined,
  });

export interface FakeClientServices {
  readonly services: ClientServices;
  /** Every envelope (`ref<T>()`) contract the part asked `use` for. */
  readonly envelope: string[];
}

/**
 * A window's `ClientServices` for one client part `bundleId`, as the window
 * runtime of S64 answers them: `use` of a generated descriptor is a client of
 * `hostClients.part(bundleId)` with `{ scope }`, `use` of
 * `doric.connection/v1` is `connection`, and `use` of any other `ref<T>()` is
 * recorded in `envelope` and answers `onEnvelope`.
 */
export const fakeClientServices = (input: {
  readonly bundleId: string;
  readonly hostClients: HostClients;
  readonly connection?: {
    status(): ConnectionStatus;
    subscribe(listener: (status: ConnectionStatus) => void): Disposable;
  };
}): FakeClientServices => {
  const envelope: string[] = [];
  const connection = input.connection ?? {
    status: (): ConnectionStatus => 'connected',
    subscribe: (): Disposable => ({ dispose: () => undefined }),
  };
  const services = {
    provide: (): Disposable => ({ dispose: () => undefined }),
    use: (contract: unknown, scope?: CallScope) => {
      if (isDescService(contract))
        return input.hostClients
          .part(input.bundleId)
          .use(contract, scope === undefined ? undefined : { scope });

      const { id } = contract as { readonly id: string };

      if (id === 'doric.connection/v1') return connection;
      envelope.push(id);
      return onEnvelope(id);
    },
    whenAvailable: (): Disposable => ({ dispose: () => undefined }),
  } as unknown as ClientServices;

  return { services, envelope };
};

/** One opening of a server stream a fake service serves. */
export interface Opening<Request, Item> {
  readonly request: Request;
  /** The opening's `doric-scope-bin`, read back. */
  readonly scope: CallScope | undefined;
  /** Sends one item to the caller. */
  push(item: Item): void;
  /** Ends the stream: without error, or with `error` (a `ConnectError`). */
  end(error?: unknown): void;
  /** Whether the stream is over: ended, or cancelled by the caller. */
  readonly closed: boolean;
}

/**
 * The openings of one server-streaming method: `serve` is its handler, each
 * call of which adds an opening a test drives with `push` and `end`; the
 * caller's cancelling closes it.
 */
export const streamOf = <Request, Item>() => {
  const openings: Opening<Request, Item>[] = [];

  async function* serve(
    request: Request,
    context: { readonly signal: AbortSignal; readonly requestHeader: Headers },
  ): AsyncGenerator<Item> {
    const queue: { item?: Item; end?: true; error?: unknown }[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const opening: Opening<Request, Item> = {
      request,
      scope: scopeOf(context),
      push: (item) => {
        queue.push({ item });
        notify();
      },
      end: (error) => {
        queue.push(error === undefined ? { end: true } : { end: true, error });
        notify();
      },
      get closed() {
        return closed;
      },
    };
    const cancel = () => {
      closed = true;
      notify();
    };

    context.signal.addEventListener('abort', cancel, { once: true });
    openings.push(opening);
    try {
      while (!closed) {
        const next = queue.shift();

        if (next === undefined) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        if (next.end === true) {
          closed = true;
          if (next.error !== undefined) throw next.error;
          return;
        }
        yield next.item as Item;
      }
    } finally {
      closed = true;
      context.signal.removeEventListener('abort', cancel);
    }
  }

  return {
    serve,
    openings,
    /** The openings still open. */
    open: () => openings.filter((opening) => !opening.closed),
    /** The latest opening. */
    latest: (): Opening<Request, Item> => {
      const last = openings.at(-1);

      if (last === undefined) throw new Error('No stream was opened.');
      return last;
    },
  };
};

/** Lets every pending promise, `setImmediate` and stream item run. */
export const settle = async (rounds = 20): Promise<void> => {
  for (let round = 0; round < rounds; round += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

/** Waits until `check` holds, polling every few milliseconds. */
export const until = async (
  check: () => boolean,
  what: string,
  timeoutMs = 2_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${what}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

/** Waits `ms` milliseconds of real time. */
export const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
