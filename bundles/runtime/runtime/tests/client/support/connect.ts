// A fake `HostClients` (S64, `bundle/runtime`) over `createRouterTransport`
// of `@connectrpc/connect`, for the client part's tests of slice S65a: the
// window's host calls go to Connect services a test implements, each message
// through Connect's binary serialization. Each part's client reopens a
// resumable server stream after `generation_lost` as `ClientPart.use` does
// (`bundle/client`'s `reopenResumable`), so a test sees the SDK's reopening.

import { type DescService, getOption } from '@bufbuild/protobuf';
import {
  type CallOptions,
  type Client,
  type ConnectRouter,
  createClient,
  createRouterTransport,
  type Interceptor,
} from '@connectrpc/connect';
import { type ClientPart, reopenResumable } from 'bundle/client';
import type {
  ClientServices,
  ConnectionStatus,
  Disposable,
  ProviderInfo,
} from 'bundle/contracts';
import { method as methodOption } from 'bundle/contracts/gen/doric/platform/v1/options_pb.js';
import type { HostClients } from 'bundle/runtime';

/** One call the window made to the host: `<Service>/<Method>` and its part. */
export interface HostCall {
  readonly method: string;
  readonly part: string;
}

/** The header the client SDK sets on every call of a part. */
const clientPartHeader = 'doric-client-part';

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
      calls.push({
        method: `${request.service.typeName}/${request.method.name}`,
        part: bundleId,
      });

      return next(request);
    };
    const transport = createRouterTransport(routes, {
      transport: { interceptors: [recording] },
    });

    return {
      bundleId,
      transport,
      use: (ref) => resumable(ref, createClient(ref, transport)),
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
const isDescService = (value: unknown): value is DescService =>
  typeof value === 'object' &&
  value !== null &&
  (value as { readonly kind?: unknown }).kind === 'service' &&
  typeof (value as { readonly typeName?: unknown }).typeName === 'string';

export interface FakeClientServices {
  readonly services: ClientServices;
  /** The ids of the services the part provided. */
  readonly provided: { readonly id: string; readonly methods: object }[];
  /** Every envelope (`ref<T>()`) contract the part asked `use` for. */
  readonly envelope: string[];
}

/**
 * A window's `ClientServices` for one client part `bundleId`, as the window
 * runtime of S64 answers them: `use` of a generated descriptor is a client of
 * `hostClients.part(bundleId)`, `use` of `doric.connection/v1` is
 * `connection`, and `use` of any other `ref<T>()` is recorded in `envelope`
 * and answers a stub whose every call rejects.
 */
export const fakeClientServices = (input: {
  readonly bundleId: string;
  readonly hostClients: HostClients;
  readonly connection?: {
    status(): ConnectionStatus;
    subscribe(listener: (status: ConnectionStatus) => void): Disposable;
  };
}): FakeClientServices => {
  const provided: { readonly id: string; readonly methods: object }[] = [];
  const envelope: string[] = [];
  const connection = input.connection ?? {
    status: (): ConnectionStatus => 'connected',
    subscribe: (): Disposable => ({ dispose: () => undefined }),
  };
  const rejecting = (contract: string) =>
    new Proxy(Object.create(null) as object, {
      get: (_target, property) =>
        typeof property === 'string' && property !== 'then'
          ? () =>
              Promise.reject(
                new Error(`${contract}.${property} is on the envelope.`),
              )
          : undefined,
    });
  const services = {
    provide: (definition: {
      readonly id: string;
      readonly methods: object;
    }): Disposable => {
      provided.push(definition);
      return { dispose: () => undefined };
    },
    use: (contract: unknown) => {
      if (isDescService(contract))
        return input.hostClients.part(input.bundleId).use(contract);

      const { id } = contract as { readonly id: string };

      if (id === 'doric.connection/v1') return connection;
      envelope.push(id);
      return rejecting(id);
    },
    whenAvailable: (): Disposable => ({ dispose: () => undefined }),
  } as unknown as ClientServices;

  return { services, provided, envelope };
};

/** One opening of a server stream a fake service serves. */
export interface Opening<Request, Item> {
  readonly request: Request;
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
    context: { readonly signal: AbortSignal },
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
