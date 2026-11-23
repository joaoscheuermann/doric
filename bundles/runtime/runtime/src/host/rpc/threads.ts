// `runtime.threads/v1` over the router (phase 3, slice S46b): one handler per
// RPC, each calling today's method (`services/threads.ts`).

import {
  create,
  type DescMessage,
  type MessageShape,
  toBinary,
} from '@bufbuild/protobuf';
import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import { callOf } from 'bundle/contracts';
import type { z } from 'zod';

import {
  ArchiveThreadRequestSchema,
  ArchiveThreadResponseSchema,
  CompactResponseSchema,
  CreateThreadRequestSchema,
  CreateThreadResponseSchema,
  DeleteThreadResponseSchema,
  EditQueuedRequestSchema,
  EditQueuedResponseSchema,
  EnqueueTerminalResultRequestSchema,
  EnqueueTerminalResultResponseSchema,
  EventsResponseSchema,
  FailTerminalResultResponseSchema,
  GetResponseSchema,
  InstructRequestSchema,
  InstructResponseSchema,
  InterruptResponseSchema,
  ListResponseSchema,
  PauseResponseSchema,
  ProjectThreadsResponseSchema,
  PromptRequestSchema,
  PromptResponseSchema,
  QueuedPromptResponseSchema,
  QueueResponseSchema,
  RemoveQueuedResponseSchema,
  RenameThreadRequestSchema,
  RenameThreadResponseSchema,
  RestartResponseSchema,
  RestoreThreadRequestSchema,
  RestoreThreadResponseSchema,
  ResumeQueueResponseSchema,
  ResumeResponseSchema,
  RetryResponseSchema,
  RewindRequestSchema,
  RewindResponseSchema,
  SendResponseSchema,
  SetThreadCwdRequestSchema,
  SetThreadCwdResponseSchema,
  SetThreadExecutionRequestSchema,
  SetThreadExecutionResponseSchema,
  SetThreadPinnedRequestSchema,
  SetThreadPinnedResponseSchema,
  SpawnRequestSchema,
  SpawnResponseSchema,
  SteerRequestSchema,
  SteerResponseSchema,
  StoredEventsAfterRequestSchema,
  StoredEventsAfterResponseSchema,
  StoredThreadResponseSchema,
  TerminateResponseSchema,
  TerminateThreadResponseSchema,
  ThreadEventsRequestSchema,
  ThreadEventsResponseSchema,
  ThreadResponseSchema,
  ThreadSnapshotSchema,
  type ThreadsService,
  ThreadsRequestSchema,
  ThreadsResponseSchema,
  UsageResponseSchema,
  ViewThreadResponseSchema,
  WatchThreadRequestSchema,
  type WatchThreadResponse,
  WatchThreadResponseSchema,
} from '../../contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import { runtimeThreadsMethods as methods } from '../../contracts/threads.js';

import type { RuntimeCore } from '../index.js';
import { decode, encode, runtimeOneofs } from './codec.js';
import { detached, parseInput, routed, routedError } from './errors.js';
import { type StreamSink, streamOf } from './streams.js';

/**
 * The largest encoded `WatchThreadResponse` snapshot: 3 MiB. A single event larger than it still goes alone
 * in its own `event` item.
 */
export const SNAPSHOT_MAX_BYTES = 3 * 1024 * 1024;

/** `value` parsed by today's input schema of `runtime.threads/v1.<method>`. */
const input = <S extends z.ZodType>(
  method: string,
  schema: S,
  value: unknown,
): z.output<S> => parseInput(`runtime.threads/v1 ${method}`, schema, value);

/** The request as today's JSON. */
const json = <D extends DescMessage>(schema: D, request: MessageShape<D>) =>
  decode(schema, request, runtimeOneofs);

/** The bytes a varint of `value` takes. */
const varintBytes = (value: number): number => {
  let bytes = 1;
  for (let rest = value; rest >= 0x80; rest = Math.floor(rest / 0x80))
    bytes += 1;
  return bytes;
};

/**
 * The encoded size of a `WatchThreadResponse` whose `snapshot` (field 1, a
 * one-byte tag) encodes to `snapshotBytes`.
 */
const itemBytes = (snapshotBytes: number): number =>
  1 + varintBytes(snapshotBytes) + snapshotBytes;

/**
 * A `snapshot` item as the items `WatchThread` sends: the snapshot with the
 * events that keep it under {@link SNAPSHOT_MAX_BYTES}, then the rest as
 * `event` items in order. A repeated field's encoding is the sum of its
 * elements' encodings, so each event's share is measured once.
 */
const splitSnapshot = (item: WatchThreadResponse): WatchThreadResponse[] => {
  if (item.item.case !== 'snapshot') return [item];
  if (toBinary(WatchThreadResponseSchema, item).byteLength < SNAPSHOT_MAX_BYTES)
    return [item];
  const snapshot = item.item.value;
  let bytes = toBinary(ThreadSnapshotSchema, {
    ...snapshot,
    events: [],
  }).byteLength;
  let kept = 0;
  for (const event of snapshot.events) {
    const share = toBinary(
      ThreadSnapshotSchema,
      create(ThreadSnapshotSchema, { events: [event] }),
    ).byteLength;
    if (itemBytes(bytes + share) >= SNAPSHOT_MAX_BYTES) break;
    bytes += share;
    kept += 1;
  }

  return [
    create(WatchThreadResponseSchema, {
      item: {
        case: 'snapshot',
        value: { ...snapshot, events: snapshot.events.slice(0, kept) },
      },
    }),
    ...snapshot.events.slice(kept).map((event) =>
      create(WatchThreadResponseSchema, {
        item: { case: 'event', value: event },
      }),
    ),
  ];
};

/**
 * `runtime.threads/v1` over `RuntimeCore`. It has one handler per RPC of `threads.proto:33-208`, each calling
 * today's method (`services/threads.ts:29-252`) with its request fields as today's input. For a tuple:
 * - `Spawn` → `[prompt, title?, options?]`;
 * - `List` → `[limit?, cursor?]`;
 * - `Events` → `[threadId, afterSequence?, limit?]`;
 * - `Send` and `Restart` → `[threadId, prompt]`;
 * - `Interrupt` → `[threadId, promptId?]`;
 * - `Terminate` → `threadId`.
 *
 * The controls bind to `callOf(context).scope` as today. A closed binding fails with `thread_control_inactive`
 * (FAILED_PRECONDITION, message unchanged). `Instruct`'s `bundle` source is the router-stamped
 * `call.caller.bundleId`.
 *
 * `WatchThread{threadId, afterSequence}`:
 * - first item `snapshot` holds the events while the encoded item stays under 3 MiB (3,145,728 bytes,
 *   `toBinary` size);
 * - the snapshot's remaining events follow as `event` items, in sequence order, before any live item;
 * - then live events (each sequence once) and the Thread's `updated` / `deleted`;
 * - a failed snapshot read ends the stream with `replay_failed`.
 * `ViewThread{threadId}`: one `{kind:'viewing', threadId}` item, the view held until the caller cancels;
 * `not_found` / `internal` as today, holding no view.
 */
export const routedThreadsService = (
  core: () => RuntimeCore,
): ServiceImpl<typeof ThreadsService> => {
  /** Runs `work` on the core and encodes its answer as `schema`. */
  const answer = <D extends DescMessage>(
    schema: D,
    work: (runtime: RuntimeCore) => Promise<unknown>,
  ): Promise<MessageShape<D>> =>
    routed(async () =>
      encode(schema, await detached(() => work(core())), runtimeOneofs),
    );

  /** The Host facade of the prompt the call's scope names. */
  const control = (runtime: RuntimeCore, context: HandlerContext) =>
    runtime.bindings.bound(callOf(context)).host.threads;

  /** Each message `open` pushes, as a server stream. */
  async function* items<T>(
    signal: AbortSignal,
    open: Parameters<typeof streamOf<T>>[0],
  ): AsyncGenerator<T> {
    try {
      yield* streamOf<T>((sink) => detached(() => open(sink)), signal);
    } catch (error) {
      throw routedError(error);
    }
  }

  /** A domain listener that pushes each item encoded as `schema`. */
  const encoded =
    <D extends DescMessage>(
      schema: D,
      sink: StreamSink<MessageShape<D>>,
      expand: (message: MessageShape<D>) => MessageShape<D>[] = (message) => [
        message,
      ],
    ) => ({
      next: (item: unknown) => {
        try {
          for (const message of expand(encode(schema, item, runtimeOneofs)))
            sink.next(message);
        } catch (error) {
          sink.end(error);
        }
      },
      end: (error?: unknown) => sink.end(error),
    });

  return {
    spawn: (request, context) =>
      answer(SpawnResponseSchema, async (runtime) => {
        const { prompt, title, options } = json(SpawnRequestSchema, request) as {
          prompt?: unknown;
          title?: unknown;
          options?: unknown;
        };
        const [text, name, spawn] = input('spawn', methods.spawn.input, [
          prompt,
          title,
          options,
        ]);
        return await control(runtime, context).spawn(text, name, spawn);
      }),
    list: ({ limit, cursor }, context) =>
      answer(ListResponseSchema, async (runtime) => {
        const [size, after] = input('list', methods.list.input, [limit, cursor]);
        return await control(runtime, context).list(size, after);
      }),
    get: ({ threadId }, context) =>
      answer(GetResponseSchema, async (runtime) =>
        control(runtime, context).get(input('get', methods.get.input, threadId)),
      ),
    events: ({ threadId, afterSequence, limit }, context) =>
      answer(EventsResponseSchema, async (runtime) => {
        const [id, after, size] = input('events', methods.events.input, [
          threadId,
          afterSequence,
          limit,
        ]);
        return await control(runtime, context).events(id, after, size);
      }),
    send: ({ threadId, prompt }, context) =>
      answer(SendResponseSchema, async (runtime) => {
        const [id, text] = input('send', methods.send.input, [threadId, prompt]);
        return { promptResult: await control(runtime, context).send(id, text) };
      }),
    restart: ({ threadId, prompt }, context) =>
      answer(RestartResponseSchema, async (runtime) => {
        const [id, text] = input('restart', methods.restart.input, [
          threadId,
          prompt,
        ]);
        return await control(runtime, context).restart(id, text);
      }),
    interrupt: ({ threadId, promptId }, context) =>
      answer(InterruptResponseSchema, async (runtime) => {
        const [id, prompt] = input('interrupt', methods.interrupt.input, [
          threadId,
          promptId,
        ]);
        return {
          interruptResult: await control(runtime, context).interrupt(id, prompt),
        };
      }),
    terminate: ({ threadId }, context) =>
      answer(TerminateResponseSchema, async (runtime) => ({
        threadView: await control(runtime, context).terminate(
          input('terminate', methods.terminate.input, threadId),
        ),
      })),
    createThread: (request) =>
      answer(CreateThreadResponseSchema, async ({ service }) => {
        const { projectId, name, parentThreadId } = input(
          'createThread',
          methods.createThread.input,
          json(CreateThreadRequestSchema, request),
        );
        return await service.threads.create(projectId, name, parentThreadId);
      }),
    thread: ({ id }) =>
      answer(ThreadResponseSchema, async ({ service }) => ({
        thread: await service.threads.find(
          input('thread', methods.thread.input, id),
        ),
      })),
    storedThread: ({ id }) =>
      answer(StoredThreadResponseSchema, async ({ threads }) => ({
        thread: await threads.record(
          input('storedThread', methods.storedThread.input, id),
        ),
      })),
    threads: (request) =>
      answer(ThreadsResponseSchema, async ({ service }) => {
        const { projectId, limit, cursor, parentThreadId } = input(
          'threads',
          methods.threads.input,
          json(ThreadsRequestSchema, request),
        );
        return {
          threadPage: await service.threads.list(
            projectId,
            limit,
            cursor,
            parentThreadId,
          ),
        };
      }),
    projectThreads: ({ projectId }) =>
      answer(ProjectThreadsResponseSchema, async ({ threads }) => ({
        threads: await threads.listByProject(
          input('projectThreads', methods.projectThreads.input, projectId),
        ),
      })),
    renameThread: (request) =>
      answer(RenameThreadResponseSchema, async ({ service }) => {
        const { id, name } = input(
          'renameThread',
          methods.renameThread.input,
          json(RenameThreadRequestSchema, request),
        );
        return { thread: await service.threads.rename(id, name) };
      }),
    setThreadCwd: (request) =>
      answer(SetThreadCwdResponseSchema, async ({ service }) => {
        const { id, cwd } = input(
          'setThreadCwd',
          methods.setThreadCwd.input,
          json(SetThreadCwdRequestSchema, request),
        );
        return await service.threads.setCwd(id, cwd);
      }),
    setThreadExecution: (request) =>
      answer(SetThreadExecutionResponseSchema, async ({ service }) => {
        const { id, ...execution } = input(
          'setThreadExecution',
          methods.setThreadExecution.input,
          json(SetThreadExecutionRequestSchema, request),
        );
        return await service.threads.setExecution(id, execution);
      }),
    archiveThread: (request) =>
      answer(ArchiveThreadResponseSchema, async ({ service }) => {
        const { id } = input(
          'archiveThread',
          methods.archiveThread.input,
          json(ArchiveThreadRequestSchema, request),
        );
        return await service.threads.archive(id);
      }),
    restoreThread: (request) =>
      answer(RestoreThreadResponseSchema, async ({ service }) => {
        const { id, batch } = input(
          'restoreThread',
          methods.restoreThread.input,
          json(RestoreThreadRequestSchema, request),
        );
        return await service.threads.restore(id, batch);
      }),
    setThreadPinned: (request) =>
      answer(SetThreadPinnedResponseSchema, async ({ service }) => {
        const { id, pinned } = input(
          'setThreadPinned',
          methods.setThreadPinned.input,
          json(SetThreadPinnedRequestSchema, request),
        );
        return { thread: await service.threads.setPinned(id, pinned) };
      }),
    prompt: (request) =>
      answer(PromptResponseSchema, async ({ service }) => {
        const { id, prompt } = input(
          'prompt',
          methods.prompt.input,
          json(PromptRequestSchema, request),
        );
        return { promptResult: await service.threads.prompt(id, prompt) };
      }),
    retry: ({ id }) =>
      answer(RetryResponseSchema, async ({ service }) => {
        const parsed = input('retry', methods.retry.input, { id });
        return { promptResult: await service.threads.retry(parsed.id) };
      }),
    steer: (request) =>
      answer(SteerResponseSchema, async ({ service }) => {
        const { id, prompt, promptId, interrupt } = input(
          'steer',
          methods.steer.input,
          json(SteerRequestSchema, request),
        );
        return {
          steerResult: await service.threads.steer(id, prompt, {
            promptId,
            ...(interrupt === undefined ? {} : { interrupt }),
          }),
        };
      }),
    instruct: (request, context) => {
      const { caller } = callOf(context);
      return answer(InstructResponseSchema, async ({ service }) => {
        const { id, prompt, reason, promptId, interrupt, retain } = input(
          'instruct',
          methods.instruct.input,
          json(InstructRequestSchema, request),
        );
        return {
          steerResult: await service.threads.instruct(
            id,
            prompt,
            {
              bundleId: caller.bundleId,
              reason,
              ...(retain === undefined ? {} : { retain }),
            },
            {
              ...(promptId === undefined ? {} : { promptId }),
              ...(interrupt === undefined ? {} : { interrupt }),
            },
          ),
        };
      });
    },
    resume: ({ id, promptId }) =>
      answer(ResumeResponseSchema, async ({ service }) => {
        const parsed = input('resume', methods.resume.input, { id, promptId });
        return {
          resumeResult: await service.threads.resume(parsed.id, parsed.promptId),
        };
      }),
    rewind: (request) =>
      answer(RewindResponseSchema, async ({ service }) => {
        const { id, promptId, prompt } = input(
          'rewind',
          methods.rewind.input,
          json(RewindRequestSchema, request),
        );
        return await service.threads.rewind(id, promptId, prompt);
      }),
    compact: ({ id }) =>
      answer(CompactResponseSchema, async ({ service }) => {
        const parsed = input('compact', methods.compact.input, { id });
        return await service.threads.compact(parsed.id);
      }),
    threadEvents: (request) =>
      answer(ThreadEventsResponseSchema, async ({ service }) => {
        const { id, afterSequence } = input(
          'threadEvents',
          methods.threadEvents.input,
          json(ThreadEventsRequestSchema, request),
        );
        return {
          threadEventLog: await service.threads.events(id, afterSequence),
        };
      }),
    storedEventsAfter: (request) =>
      answer(StoredEventsAfterResponseSchema, async ({ threads }) => {
        const { id, afterSequence } = input(
          'storedEventsAfter',
          methods.storedEventsAfter.input,
          json(StoredEventsAfterRequestSchema, request),
        );
        return { events: await threads.eventsAfter(id, afterSequence) };
      }),
    pause: ({ id, promptId }) =>
      answer(PauseResponseSchema, async ({ service }) => {
        const parsed = input('pause', methods.pause.input, { id, promptId });
        return {
          interruptResult: await service.threads.interrupt(
            parsed.id,
            parsed.promptId,
          ),
        };
      }),
    terminateThread: ({ id }) =>
      answer(TerminateThreadResponseSchema, async ({ service }) => ({
        thread: await service.threads.terminate(
          input('terminateThread', methods.terminateThread.input, id),
        ),
      })),
    deleteThread: ({ id }) =>
      answer(DeleteThreadResponseSchema, async ({ service }) => ({
        deleteResult: await service.threads.delete(
          input('deleteThread', methods.deleteThread.input, id),
        ),
      })),
    queue: ({ id }) =>
      answer(QueueResponseSchema, async ({ service }) => ({
        threadQueue: await service.threads.queue(
          input('queue', methods.queue.input, id),
        ),
      })),
    resumeQueue: ({ id }) =>
      answer(ResumeQueueResponseSchema, async ({ service }) => ({
        resumeResult: await service.threads.resumeQueue(
          input('resumeQueue', methods.resumeQueue.input, id),
        ),
      })),
    queuedPrompt: ({ id, promptId }) =>
      answer(QueuedPromptResponseSchema, async ({ service }) => {
        const parsed = input('queuedPrompt', methods.queuedPrompt.input, {
          id,
          promptId,
        });
        return {
          queuedPrompt: await service.threads.queuedPrompt(
            parsed.id,
            parsed.promptId,
          ),
        };
      }),
    editQueued: (request) =>
      answer(EditQueuedResponseSchema, async ({ service }) => {
        const { id, promptId, text, revision } = input(
          'editQueued',
          methods.editQueued.input,
          json(EditQueuedRequestSchema, request),
        );
        return await service.threads.editQueued(id, promptId, text, revision);
      }),
    removeQueued: ({ id, promptId }) =>
      answer(RemoveQueuedResponseSchema, async ({ service }) => {
        const parsed = input('removeQueued', methods.removeQueued.input, {
          id,
          promptId,
        });
        return {
          removeQueuedResult: await service.threads.removeQueued(
            parsed.id,
            parsed.promptId,
          ),
        };
      }),
    usage: ({ id }) =>
      answer(UsageResponseSchema, async ({ service }) => ({
        threadUsage: await service.threads.usage(
          input('usage', methods.usage.input, id),
        ),
      })),
    enqueueTerminalResult: (request) =>
      answer(EnqueueTerminalResultResponseSchema, async ({ service }) => {
        await service.threads.terminalResult(
          input(
            'enqueueTerminalResult',
            methods.enqueueTerminalResult.input,
            json(EnqueueTerminalResultRequestSchema, request),
          ),
        );
        return {};
      }),
    failTerminalResult: ({ threadId }) =>
      answer(FailTerminalResultResponseSchema, async ({ service }) => {
        const parsed = input(
          'failTerminalResult',
          methods.failTerminalResult.input,
          { threadId },
        );
        await service.threads.failTerminalResult(parsed.threadId);
        return {};
      }),
    async *watchThread(request, context) {
      const { watches } = core();
      const [parsed] = input('watchThread', methods.watchThread.input, [
        json(WatchThreadRequestSchema, request),
        () => undefined,
      ]);
      yield* items<WatchThreadResponse>(context.signal, (sink) =>
        watches.thread(
          parsed,
          encoded(WatchThreadResponseSchema, sink, splitSnapshot),
        ),
      );
    },
    async *viewThread({ threadId }, context) {
      const { service } = core();
      const [parsed] = input('viewThread', methods.viewThread.input, [
        { threadId },
        () => undefined,
      ]);
      yield* items(context.signal, (sink) =>
        service.threads.view(
          parsed.threadId,
          encoded(ViewThreadResponseSchema, sink),
        ),
      );
    },
  };
};
