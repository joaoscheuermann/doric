// The window's Connect path to the host, faked for the chat's window tests
// (slice S65a; spec `docs/designs/grpc-processes.md`, section 13, "The window
// to main"): a `window.doric.connect` (`DoricConnectApi`) whose requests go
// to a Connect router, as main's relay forwards them to the host. Through it
// the window's own `windowHostClients` (S64) answers each part's
// `services.use(<X>Service)`, so the calls cross Connect's binary protocol
// and a resumable stream ended with `generation_lost` is reopened by the SDK.
//
// The router serves `ThreadsService`, `AttachmentsService` and
// `ModelsService.Icons` the way the host's own adapters do
// (`runtime/src/host/rpc/threads.ts`): each request read as today's JSON
// (`decode`), handed to the test's `<contract>.<method>` answer, and the
// answer written as the proto response (`encode`, the host's codec). A test
// keeps answering in today's shapes; an answer that is already the proto
// response message passes unchanged.

import {
  create,
  type DescMessage,
  isMessage,
  type MessageShape,
} from '@bufbuild/protobuf';
import {
  type ConnectRouter,
  createConnectRouter,
  type HandlerContext,
} from '@connectrpc/connect';
import { createUniversalHandlerClient } from '@connectrpc/connect/protocol';
import {
  ContractError,
  type ContractErrorCode,
  toConnectError,
} from 'bundle/contracts';
import {
  IconsRequestSchema,
  IconsResponseSchema,
  ModelsService,
} from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import type {
  BridgeCallEnvelope,
  ConnectPort,
  ConnectReply,
  DoricConnectApi,
} from 'desktop/client';
import { decode, encode, runtimeOneofs } from 'runtime/contracts';
import {
  AttachmentSchema,
  AttachmentsService,
  type AttachRequest,
  AttachResponseSchema,
  ReadResponseSchema,
} from 'runtime/contracts/gen/doric/runtime/attachments/v1/attachments_pb.js';
import {
  EditQueuedRequestSchema,
  EditQueuedResponseSchema,
  PauseRequestSchema,
  PauseResponseSchema,
  PromptRequestSchema,
  PromptResponseSchema,
  QueuedPromptRequestSchema,
  QueuedPromptResponseSchema,
  QueueResponseSchema,
  RemoveQueuedRequestSchema,
  RemoveQueuedResponseSchema,
  ResumeQueueResponseSchema,
  ResumeRequestSchema,
  ResumeResponseSchema,
  RetryRequestSchema,
  RetryResponseSchema,
  RewindRequestSchema,
  RewindResponseSchema,
  SetThreadExecutionRequestSchema,
  SetThreadExecutionResponseSchema,
  SteerRequestSchema,
  SteerResponseSchema,
  ThreadResponseSchema,
  ThreadsService,
  WatchThreadRequestSchema,
  type WatchThreadResponse,
  WatchThreadResponseSchema,
} from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';

/** What the host answers for one `<contract>.<method>`, in today's shapes. */
export type HostAnswer = (input: unknown) => unknown;

/** One open server stream of the host: the call it answers, and its pushes. */
export interface OpenStream {
  /** The call as the envelope named it: contract, method, today's input. */
  readonly envelope: BridgeCallEnvelope;
  /** Sends one item, in today's shape, to the window. */
  push(item: unknown): void;
  /** Ends the stream: without error, or with the Doric error `error`. */
  end(error?: { code: string; message: string }): void;
}

/** The header the client SDK names the calling part with. */
const clientPartHeader = 'doric-client-part';

/** A failure the test's answer threw, as the Connect error the host sends. */
const connectFailure = (error: unknown): unknown => {
  if (error instanceof ContractError) return toConnectError(error);
  const failure = error as { code?: string; message?: string } | undefined;
  return toConnectError(
    new ContractError(
      (failure?.code ?? 'internal') as ContractErrorCode,
      failure?.message ?? 'failed',
    ),
  );
};

/** `answer` already a message of `schema`, or today's JSON written as one. */
const response = <D extends DescMessage>(
  schema: D,
  answer: unknown,
): MessageShape<D> =>
  isMessage(answer, schema) ? answer : encode(schema, answer, runtimeOneofs);

let callIds = 0;

export interface HostConnect {
  /** The window's `doric:connect`. */
  readonly api: DoricConnectApi;
  /** Every open `ThreadsService.WatchThread` stream, in opening order. */
  readonly watches: () => readonly OpenStream[];
}

/**
 * The host behind the window's `doric:connect`: each call it serves is
 * appended to `calls` as the envelope named it (`<contract>.<method>` and
 * today's input; a tuple method's input as its tuple), then answered by
 * `host[<contract>.<method>]`; a method without an answer answers nothing.
 * `ModelsService.Icons` is served only when `icons` is true.
 */
export const serveHostConnect = (input: {
  readonly host: Readonly<Record<string, HostAnswer>>;
  readonly calls: BridgeCallEnvelope[];
  readonly icons: boolean;
}): HostConnect => {
  const streams: OpenStream[] = [];

  /** Records one call and runs its answer, as today's output. */
  const call = async (
    contract: string,
    method: string,
    callInput: unknown,
    context: HandlerContext,
  ): Promise<unknown> => {
    callIds += 1;
    input.calls.push({
      id: `connect-${String(callIds)}`,
      contract,
      method,
      input: callInput,
      bundleId: context.requestHeader.get(clientPartHeader),
      deadline: 0,
      traceparent: '',
    });
    const answer = input.host[`${contract}.${method}`];
    try {
      return answer === undefined ? undefined : await answer(callInput);
    } catch (error) {
      throw connectFailure(error);
    }
  };

  /** A unary `runtime.threads/v1` method: today's answer under `key`, or the whole response. */
  const threads = <D extends DescMessage>(
    method: string,
    schema: D,
    key: string | null,
  ) => {
    return async (
      callInput: unknown,
      context: HandlerContext,
    ): Promise<MessageShape<D>> => {
      const answer = await call(
        'runtime.threads/v1',
        method,
        callInput,
        context,
      );
      if (isMessage(answer, schema)) return answer;
      try {
        return response(schema, key === null ? answer : { [key]: answer });
      } catch (error) {
        throw connectFailure(error);
      }
    };
  };

  /** A request as today's JSON. */
  const json = <D extends DescMessage>(schema: D, request: MessageShape<D>) =>
    decode(schema, request, runtimeOneofs);

  const routes = (router: ConnectRouter) => {
    router.service(ThreadsService, {
      thread: ({ id }, context) =>
        threads('thread', ThreadResponseSchema, 'thread')([id], context),
      queue: ({ id }, context) =>
        threads('queue', QueueResponseSchema, 'threadQueue')([id], context),
      resumeQueue: ({ id }, context) =>
        threads(
          'resumeQueue',
          ResumeQueueResponseSchema,
          'resumeResult',
        )([id], context),
      prompt: (request, context) =>
        threads(
          'prompt',
          PromptResponseSchema,
          'promptResult',
        )(json(PromptRequestSchema, request), context),
      retry: (request, context) =>
        threads(
          'retry',
          RetryResponseSchema,
          'promptResult',
        )(json(RetryRequestSchema, request), context),
      steer: (request, context) =>
        threads(
          'steer',
          SteerResponseSchema,
          'steerResult',
        )(json(SteerRequestSchema, request), context),
      resume: (request, context) =>
        threads(
          'resume',
          ResumeResponseSchema,
          'resumeResult',
        )(json(ResumeRequestSchema, request), context),
      rewind: (request, context) =>
        threads(
          'rewind',
          RewindResponseSchema,
          null,
        )(json(RewindRequestSchema, request), context),
      pause: (request, context) =>
        threads(
          'pause',
          PauseResponseSchema,
          'interruptResult',
        )(json(PauseRequestSchema, request), context),
      queuedPrompt: (request, context) =>
        threads(
          'queuedPrompt',
          QueuedPromptResponseSchema,
          'queuedPrompt',
        )(json(QueuedPromptRequestSchema, request), context),
      editQueued: (request, context) =>
        threads(
          'editQueued',
          EditQueuedResponseSchema,
          null,
        )(json(EditQueuedRequestSchema, request), context),
      removeQueued: (request, context) =>
        threads(
          'removeQueued',
          RemoveQueuedResponseSchema,
          'removeQueuedResult',
        )(json(RemoveQueuedRequestSchema, request), context),
      setThreadExecution: (request, context) =>
        threads(
          'setThreadExecution',
          SetThreadExecutionResponseSchema,
          null,
        )(json(SetThreadExecutionRequestSchema, request), context),
      async *watchThread(request, context) {
        const queue: {
          item?: WatchThreadResponse;
          end?: true;
          error?: unknown;
        }[] = [];
        let wake: (() => void) | undefined;
        let closed = false;
        const notify = () => {
          wake?.();
          wake = undefined;
        };
        callIds += 1;
        const envelope: BridgeCallEnvelope = {
          id: `connect-${String(callIds)}`,
          contract: 'runtime.threads/v1',
          method: 'watchThread',
          input: [json(WatchThreadRequestSchema, request)],
          bundleId: context.requestHeader.get(clientPartHeader),
          deadline: 0,
          traceparent: '',
        };
        const stream: OpenStream = {
          envelope,
          push: (item) => {
            if (closed) return;
            queue.push({ item: response(WatchThreadResponseSchema, item) });
            notify();
          },
          end: (error) => {
            if (closed) return;
            queue.push(
              error === undefined
                ? { end: true }
                : { end: true, error: connectFailure(error) },
            );
            notify();
          },
        };
        const close = () => {
          closed = true;
          const index = streams.indexOf(stream);
          if (index >= 0) streams.splice(index, 1);
          notify();
        };
        input.calls.push(envelope);
        streams.push(stream);
        context.signal.addEventListener('abort', close, { once: true });
        try {
          while (true) {
            const next = queue.shift();
            if (next === undefined) {
              if (closed) return;
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              continue;
            }
            if (next.end === true) {
              if (next.error !== undefined) throw next.error;
              return;
            }
            yield next.item as WatchThreadResponse;
          }
        } finally {
          close();
          context.signal.removeEventListener('abort', close);
        }
      },
    });

    router.service(AttachmentsService, {
      attach: async (requests: AsyncIterable<AttachRequest>, context) => {
        let name = '';
        const chunks: Uint8Array[] = [];
        for await (const { item } of requests) {
          if (item.case === 'head') name = item.value.name;
          else if (item.case === 'chunk') chunks.push(item.value);
        }
        const answer = await call(
          'runtime.attachments/v1',
          'attach',
          { name, bytes: Buffer.concat(chunks).toString('base64') },
          context,
        );
        if (isMessage(answer, AttachResponseSchema)) return answer;
        try {
          return response(AttachResponseSchema, { attachment: answer });
        } catch (error) {
          throw connectFailure(error);
        }
      },
      async *read({ id }, context) {
        const answer = (await call(
          'runtime.attachments/v1',
          'read',
          { id },
          context,
        )) as { readonly bytes?: string } | undefined;
        // No attachment by that id: a head without one, and no chunk.
        if (answer === undefined || answer === null) {
          yield create(ReadResponseSchema, {
            item: { case: 'head', value: {} },
          });
          return;
        }
        const { bytes, ...attachment } = answer;
        let head: MessageShape<typeof AttachmentSchema>;
        try {
          head = response(AttachmentSchema, attachment);
        } catch (error) {
          throw connectFailure(error);
        }
        yield create(ReadResponseSchema, {
          item: { case: 'head', value: { attachment: head } },
        });
        const data = Buffer.from(bytes ?? '', 'base64');
        if (data.length > 0)
          yield create(ReadResponseSchema, {
            item: { case: 'chunk', value: new Uint8Array(data) },
          });
      },
    });

    router.service(
      ModelsService,
      input.icons
        ? {
            icons: async (request, context) => {
              const answer = (await call(
                'models/v1',
                'icons',
                decode(IconsRequestSchema, request),
                context,
              )) as
                | {
                    readonly svgs?: unknown;
                    readonly answers?: readonly {
                      readonly provider?: string;
                      readonly models: readonly (string | null)[];
                    }[];
                  }
                | undefined;
              if (isMessage(answer, IconsResponseSchema)) return answer;
              try {
                // An icon-less model travels as `""`.
                return encode(IconsResponseSchema, {
                  ...answer,
                  answers: (answer?.answers ?? []).map((each) => ({
                    ...each,
                    models: each.models.map((name) => name ?? ''),
                  })),
                });
              } catch (error) {
                throw connectFailure(error);
              }
            },
          }
        : {},
    );
  };

  const router = createConnectRouter();
  routes(router);
  const handle = createUniversalHandlerClient(router.handlers);

  const api: DoricConnectApi = {
    request: async ({ path, headers, body }): Promise<ConnectReply> => {
      const abort = new AbortController();
      const header = new Headers(headers as [string, string][]);
      const contentType = header.get('content-type') ?? '';
      const answer = handle({
        url: `http://doric.window${path}`,
        method: 'POST',
        header,
        body: (async function* () {
          yield body;
        })(),
        signal: abort.signal,
      });

      // A unary call: the whole response.
      if (!contentType.startsWith('application/connect+')) {
        const unary = await answer;
        const parts: Uint8Array[] = [];
        if (unary.body !== undefined)
          for await (const part of unary.body) parts.push(part);
        return {
          status: unary.status,
          headers: [...unary.header] as [string, string][],
          body: new Uint8Array(Buffer.concat(parts)),
        };
      }

      // A streaming call: its head at once, as main relays it, and the body
      // on the port as the host sends it (a failure ends it in-band).
      return {
        status: 200,
        headers: [['content-type', contentType]],
        port: portOf(
          answer.then(({ body: items }) => items),
          abort,
        ),
      };
    },
  };

  return { api, watches: () => streams };
};

/**
 * The page's end of a stream's port, as main's relay posts the body: each
 * chunk a message, then `null`. Closing it cancels the call.
 */
const portOf = (
  body: Promise<AsyncIterable<Uint8Array> | undefined>,
  abort: AbortController,
): ConnectPort => {
  const listeners = {
    message: new Set<(event: { readonly data?: unknown }) => void>(),
    close: new Set<(event: { readonly data?: unknown }) => void>(),
  };
  let started = false;
  let closed = false;
  // A call cancelled before its port started rejects unheard.
  body.catch(() => undefined);
  const emit = (type: 'message' | 'close', data?: unknown) => {
    for (const listener of [...listeners[type]]) listener({ data });
  };

  return {
    addEventListener: (type, listener) => {
      listeners[type].add(listener);
    },
    start: () => {
      if (started) return;
      started = true;
      void (async () => {
        try {
          const items = await body;
          if (items !== undefined)
            for await (const chunk of items) {
              if (closed) return;
              emit('message', chunk);
            }
          if (!closed) emit('message', null);
        } catch {
          if (!closed) emit('close');
        }
      })();
    },
    close: () => {
      if (closed) return;
      closed = true;
      abort.abort();
    },
  };
};
