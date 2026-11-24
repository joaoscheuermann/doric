// The routed world of `chat`'s host part (phase 3, S58): `chat.composer/v1`
// served by `createTestRouter` as `src/host/main.ts` serves it
// (`createChatHost`, its `activate`). Section D gives the host part no
// requirement, so the local world declares none (`requires: []`) and has no
// fake: `ComposerService` and the `message` kind's
// `ComposerFlushHandlerService` are both `chat`'s own.
//
// The remote world stands for another bundle that registered a comment kind
// (`papercraft` and its `papercraft-program`): `chat`'s own handler entry is
// left out (the test router refuses a definition serving a faked service) and
// a fake `ComposerFlushHandlerService` records each `Flush` it receives —
// its request as JSON, `callOf(context).scope` and its deadline — and answers
// from the test's script. The test router keys `requires` by service rather
// than by contract, so the remote world lists the handler service, which in
// production is a service of `chat`'s own contract.

import {
  type DescService,
  type JsonValue,
  type MessageInitShape,
  toJson,
} from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import {
  type Client,
  ConnectError,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';
import {
  type Caller,
  type CallScope,
  type ContractError,
  callOf,
  deadlineOf,
  fromConnectError,
} from 'bundle/contracts';
import type { HostContext, ServiceEntry } from 'bundle/host';
import { createTestRouter, type TestRouter } from 'bundle/testing';

import {
  ComposerFlushHandlerService,
  type ComposerFlushHandlerServiceFlushRequest,
  ComposerFlushHandlerServiceFlushRequestSchema,
  type ComposerFlushHandlerServiceFlushResponseSchema,
  type ComposerItem,
  ComposerService,
  type WatchResponse,
} from '../../src/contracts/gen/doric/chat/composer/v1/composer_pb.js';
import { type ChatHost, createChatHost } from '../../src/host/service.js';

export const projectId = 'project-1';
export const otherProjectId = 'project-2';
export const threadId = 'thread-1';
export const promptId = 'prompt-1';

/** The kind `papercraft` registers a flush for. */
export const REMOTE_KIND = 'papercraft-program';

/** `papercraft`'s instance as the router stamps it on its calls. */
export const PAPERCRAFT: Caller = {
  bundleId: 'papercraft',
  version: '1.0.0',
  generation: 1,
};

/** Another bundle, which would register a kind of its own. */
export const PREVIEW: Caller = {
  bundleId: 'preview',
  version: '1.0.0',
  generation: 1,
};

/** One `Flush` the fake handler received. */
export interface FlushCall {
  /** The request as JSON (`toJson`, implicit fields left out). */
  readonly request: JsonValue;
  readonly scope: CallScope | undefined;
  /** `deadlineOf(callOf(context))`, 0 when none. */
  readonly deadline: number;
}

export type FlushAnswer = MessageInitShape<
  typeof ComposerFlushHandlerServiceFlushResponseSchema
>;

/** How the fake handler answers one `Flush`; default `{ writes: [] }`. */
export type FlushScript = (
  request: ComposerFlushHandlerServiceFlushRequest,
  context: HandlerContext,
) => FlushAnswer | Promise<FlushAnswer>;

export interface WorldOptions {
  /** The remote world: a fake `ComposerFlushHandlerService` instead of `chat`'s own. Default local. */
  readonly remote?: boolean;
}

export interface ClientOptions {
  readonly scope?: CallScope;
  readonly caller?: Caller;
}

export interface ChatWorld {
  readonly router: TestRouter;
  readonly host: ChatHost;
  /** The fake handler's calls, in order (remote world). */
  readonly flushCalls: FlushCall[];
  /** Replaces the fake handler's answer (remote world). */
  script(answer: FlushScript): void;
  /** A client of `chat.composer/v1`; default scope `{ projectId, threadId }`, caller `papercraft`. */
  composer(options?: ClientOptions): Client<typeof ComposerService>;
  /** A client of `chat`'s own `ComposerFlushHandlerService` (local world). */
  handler(options?: ClientOptions): Client<typeof ComposerFlushHandlerService>;
  /** Activates the part as `main.ts` does. */
  activate(): Promise<HostContext>;
  /** Serves the part's services without running its `activate`. */
  serveWithoutActivate(): Promise<void>;
  stop(): Promise<void>;
}

const fakeOf = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

/** `chat`'s host part on a test router, not yet activated. */
export const chatWorld = (options: WorldOptions = {}): ChatWorld => {
  const host = createChatHost();
  const flushCalls: FlushCall[] = [];
  let answer: FlushScript = () => ({ writes: [] });
  const remote = options.remote === true;

  const router = createTestRouter({
    requires: remote ? [ComposerFlushHandlerService.typeName] : [],
    instance: { bundleId: 'chat' },
    fakes: remote
      ? [
          fakeOf(ComposerFlushHandlerService, {
            flush: async (request, context) => {
              const call = callOf(context);
              flushCalls.push({
                request: toJson(
                  ComposerFlushHandlerServiceFlushRequestSchema,
                  request,
                ),
                scope: call.scope,
                deadline: deadlineOf(call),
              });
              return await answer(request, context);
            },
          }),
        ]
      : [],
  });

  /** `main.ts`'s list; the remote world leaves out `chat`'s own handler service. */
  const services = (): readonly ServiceEntry[] => {
    const composer = [ComposerService, host.composer] as ServiceEntry;
    const handler = [
      ComposerFlushHandlerService,
      host.flushHandler,
    ] as ServiceEntry;
    return remote ? [composer] : [composer, handler];
  };

  return {
    router,
    host,
    flushCalls,
    script: (next) => {
      answer = next;
    },
    composer: (clientOptions = {}) =>
      router.client(ComposerService, {
        caller: clientOptions.caller ?? PAPERCRAFT,
        scope: clientOptions.scope ?? { projectId, threadId },
      }),
    handler: (clientOptions = {}) =>
      router.client(ComposerFlushHandlerService, {
        caller: clientOptions.caller ?? PAPERCRAFT,
        scope: clientOptions.scope ?? { projectId, threadId, promptId },
      }),
    activate: () =>
      router.activate<readonly DescService[]>({
        services: services(),
        activate: (context) => host.activate(context),
        deactivate: () => host.deactivate(),
      }),
    serveWithoutActivate: async () => {
      await router.activate<readonly DescService[]>({
        services: services(),
        activate: () => undefined,
      });
    },
    stop: () => router.control.stop(),
  };
};

/** The `ContractError` a failed client call carries. */
export const contractErrorFrom = (error: unknown): ContractError =>
  fromConnectError(ConnectError.from(error));

/** The `ContractError` of `call`, which must fail. */
export const failureOf = async (
  call: () => Promise<unknown>,
): Promise<ContractError> => {
  try {
    await call();
  } catch (error) {
    return contractErrorFrom(error);
  }
  throw new Error('The call did not fail.');
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `ready()` holds, failing with `what` after `ms`. */
export const until = async (
  ready: () => boolean,
  what: string,
  ms = 2000,
): Promise<void> => {
  const end = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(5);
  }
};

/** A promise the test settles. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

/**
 * A wire item as plain JSON, independent of `src/host/codec.ts`: `data` as
 * the JSON the `Value` holds (absent → no key), `author` only when set.
 */
export const itemJson = (item: ComposerItem): Record<string, unknown> => ({
  id: item.id,
  kind: item.kind,
  elementTag: item.elementTag,
  ...(item.data === undefined ? {} : { data: toJson(ValueSchema, item.data) }),
  ...(item.author === undefined ? {} : { author: item.author }),
  note: item.note,
});

/** One `Watch` response as plain values: its revision, its kind case and that case's fields. */
export const watchView = (response: WatchResponse): Record<string, unknown> => {
  const { revision, kind } = response;
  switch (kind.case) {
    case 'snapshot':
      return {
        revision,
        kind: 'snapshot',
        threadId: kind.value.threadId,
        text: kind.value.text,
        items: kind.value.items.map(itemJson),
      };
    case 'text':
      return {
        revision,
        kind: 'text',
        threadId: kind.value.threadId,
        text: kind.value.text,
      };
    case 'added':
    case 'updated':
      return {
        revision,
        kind: kind.case,
        threadId: kind.value.threadId,
        item:
          kind.value.item === undefined ? undefined : itemJson(kind.value.item),
      };
    case 'removed':
      return {
        revision,
        kind: 'removed',
        threadId: kind.value.threadId,
        id: kind.value.id,
      };
    default:
      return { revision, kind: undefined };
  }
};

/** One open `Watch`: its responses as they arrive, and how it ended. */
export interface OpenWatch {
  readonly responses: WatchResponse[];
  /** The responses through `watchView`. */
  views(): Record<string, unknown>[];
  /** Settles with the error the stream ended with, `undefined` when it returned. */
  readonly ended: Promise<unknown>;
  /** Whether the stream ended. */
  done(): boolean;
  /** Cancels the call. */
  cancel(): void;
}

export const openWatch = (
  client: Client<typeof ComposerService>,
  watchedThreadId: string = threadId,
): OpenWatch => {
  const responses: WatchResponse[] = [];
  const controller = new AbortController();
  let finished = false;
  const ended = (async (): Promise<unknown> => {
    try {
      for await (const response of client.watch(
        { threadId: watchedThreadId },
        { signal: controller.signal },
      )) {
        responses.push(response);
      }
      return undefined;
    } catch (error) {
      return error;
    } finally {
      finished = true;
    }
  })();

  return {
    responses,
    views: () => responses.map(watchView),
    ended,
    done: () => finished,
    cancel: () => controller.abort(),
  };
};
