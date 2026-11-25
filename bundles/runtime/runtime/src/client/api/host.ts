// The host contracts the records mirror calls, over the window's Connect path
// (slice S65a): the generated clients of `runtime/v2` (`RuntimeService`) and
// `runtime.threads/v1` (`ThreadsService`), read back as today's shapes, so
// the mirror's own modules keep their envelope-shaped hosts.

import type { DescMessage, JsonValue, MessageShape } from '@bufbuild/protobuf';
import { type Client, ConnectError } from '@connectrpc/connect';
import {
  ContractError,
  type Disposable,
  fromConnectError,
  type StreamObserver,
  toStreamObserver,
} from 'bundle/contracts';
import type { z } from 'zod';

import {
  ArchiveThreadRequestSchema,
  ArchiveThreadResponseSchema,
  CreateThreadRequestSchema,
  CreateThreadResponseSchema,
  DeleteThreadResponseSchema,
  RenameThreadRequestSchema,
  RenameThreadResponseSchema,
  RestoreThreadRequestSchema,
  RestoreThreadResponseSchema,
  SetThreadPinnedRequestSchema,
  SetThreadPinnedResponseSchema,
  TerminateThreadResponseSchema,
  ThreadResponseSchema,
  ThreadsRequestSchema,
  ThreadsResponseSchema,
  type ThreadsService,
  ViewThreadResponseSchema,
} from '../../contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import {
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  DeleteProjectResponseSchema,
  ProjectActivityResponseSchema,
  ProjectsRequestSchema,
  ProjectsResponseSchema,
  RenameProjectRequestSchema,
  RenameProjectResponseSchema,
  type RuntimeService,
  SetProjectColorRequestSchema,
  SetProjectColorResponseSchema,
  TerminateProjectResponseSchema,
  WatchProjectResponseSchema,
} from '../../contracts/gen/doric/runtime/v2/runtime_pb.js';
import {
  decode,
  encode,
  projectWatchItemSchema,
  type Runtime,
  type RuntimeThreads,
  runtimeMethods,
  runtimeOneofs,
  runtimeThreadsMethods,
  threadViewItemSchema,
} from '../../contracts/index.js';

/** The subset of `runtime/v2` the records mirror calls. */
export type RuntimeHost = Pick<
  Runtime,
  | 'projects'
  | 'projectActivity'
  | 'createProject'
  | 'renameProject'
  | 'setProjectColor'
  | 'terminateProject'
  | 'deleteProject'
  | 'watchProject'
>;

/**
 * The subset of `runtime.threads/v1` the records mirror calls. `archiveThread`,
 * `restoreThread`, `setThreadPinned` and `viewThread` need
 * `runtime.threads/v1@^1.8.0` (docs/designs/thread-archive.md §10.6, §10.8).
 */
export type ThreadsHost = Pick<
  RuntimeThreads,
  | 'threads'
  | 'thread'
  | 'createThread'
  | 'renameThread'
  | 'terminateThread'
  | 'deleteThread'
  | 'archiveThread'
  | 'restoreThread'
  | 'setThreadPinned'
  | 'viewThread'
>;

/** A Connect call's failure as its Doric error (`fromConnectError`); any other error unchanged. */
export const contractError = (error: unknown): unknown =>
  error instanceof ConnectError ? fromConnectError(error) : error;

const isObject = (
  value: JsonValue,
): value is { readonly [key: string]: JsonValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The answer of one unary call as today's value: the response decoded to
 * today's JSON, its field `key` (the whole response without one), parsed by
 * today's output schema. A failed call rejects with its Doric error; an
 * answer outside the schema with `invalid_output`.
 */
const answer = async <D extends DescMessage, O extends z.ZodType>(
  method: string,
  schema: D,
  output: O,
  key: string | undefined,
  call: () => Promise<MessageShape<D>>,
): Promise<z.output<O>> => {
  let message: MessageShape<D>;
  try {
    message = await call();
  } catch (error) {
    throw contractError(error);
  }
  const json = decode(schema, message, runtimeOneofs);
  const value = key === undefined || !isObject(json) ? json : json[key];
  const parsed = output.safeParse(value);
  if (!parsed.success)
    throw new ContractError(
      'invalid_output',
      `${method} answered outside its schema: ${parsed.error.message}`,
    );
  return parsed.data;
};

/**
 * Follows one server stream as an envelope observer: each item reaches
 * `next` as `read` returns it, the end reaches `end` (a failure as its Doric
 * error, an item `read` refuses as that error). `dispose` cancels the stream
 * and reports nothing more. Never throws.
 */
export const observe = <Message, Item>(
  open: (signal: AbortSignal) => AsyncIterable<Message>,
  read: (message: Message) => Item,
  observer: StreamObserver<Item>,
): Disposable => {
  const controller = new AbortController();
  const { signal } = controller;

  void (async () => {
    try {
      for await (const message of open(signal)) {
        if (signal.aborted) return;
        observer.next(read(message));
      }
      if (!signal.aborted) observer.end?.();
    } catch (error) {
      if (signal.aborted) return;
      const failure = contractError(error);
      observer.end?.(
        failure instanceof ContractError
          ? failure
          : new ContractError(
              'internal',
              failure instanceof Error ? failure.message : String(failure),
            ),
      );
    } finally {
      controller.abort();
    }
  })();

  return { dispose: () => controller.abort() };
};

/**
 * A stream item as today's value: `message` decoded to today's JSON and
 * parsed by today's item schema; an item outside it throws `invalid_output`.
 */
const item =
  <D extends DescMessage, O extends z.ZodType>(
    method: string,
    schema: D,
    output: O,
  ) =>
  (message: MessageShape<D>): z.output<O> => {
    const parsed = output.safeParse(decode(schema, message, runtimeOneofs));
    if (!parsed.success)
      throw new ContractError(
        'invalid_output',
        `${method} answered outside its schema: ${parsed.error.message}`,
      );
    return parsed.data;
  };

/**
 * `runtime/v2`'s members the mirror calls, over the `RuntimeService` client
 * `client` answers; it is asked for at each call, so creating the host
 * creates no client.
 */
export const runtimeHost = (
  client: () => Client<typeof RuntimeService>,
): RuntimeHost => ({
  projects: async (page) =>
    answer(
      'runtime/v2 projects',
      ProjectsResponseSchema,
      runtimeMethods.projects.output,
      undefined,
      () => client().projects(encode(ProjectsRequestSchema, page)),
    ),
  projectActivity: async () =>
    answer(
      'runtime/v2 projectActivity',
      ProjectActivityResponseSchema,
      runtimeMethods.projectActivity.output,
      'projectActivity',
      () => client().projectActivity({}),
    ),
  createProject: async (input) =>
    answer(
      'runtime/v2 createProject',
      CreateProjectResponseSchema,
      runtimeMethods.createProject.output,
      'project',
      () => client().createProject(encode(CreateProjectRequestSchema, input)),
    ),
  renameProject: async (input) =>
    answer(
      'runtime/v2 renameProject',
      RenameProjectResponseSchema,
      runtimeMethods.renameProject.output,
      'project',
      () => client().renameProject(encode(RenameProjectRequestSchema, input)),
    ),
  setProjectColor: async ({ id, color }) =>
    answer(
      'runtime/v2 setProjectColor',
      SetProjectColorResponseSchema,
      runtimeMethods.setProjectColor.output,
      'project',
      () =>
        client().setProjectColor(
          encode(
            SetProjectColorRequestSchema,
            color === null ? { id } : { id, color },
          ),
        ),
    ),
  terminateProject: async (id) =>
    answer(
      'runtime/v2 terminateProject',
      TerminateProjectResponseSchema,
      runtimeMethods.terminateProject.output,
      'project',
      () => client().terminateProject({ id }),
    ),
  deleteProject: async (id) =>
    answer(
      'runtime/v2 deleteProject',
      DeleteProjectResponseSchema,
      runtimeMethods.deleteProject.output,
      'deleteResult',
      () => client().deleteProject({ id }),
    ),
  watchProject: (input, listener) =>
    observe(
      (signal) => client().watchProject(input, { signal }),
      item(
        'runtime/v2 watchProject',
        WatchProjectResponseSchema,
        projectWatchItemSchema,
      ),
      toStreamObserver(listener),
    ),
});

/**
 * `runtime.threads/v1`'s members the mirror calls, over the `ThreadsService`
 * client `client` answers at each call.
 */
export const threadsHost = (
  client: () => Client<typeof ThreadsService>,
): ThreadsHost => ({
  threads: async (input) =>
    answer(
      'runtime.threads/v1 threads',
      ThreadsResponseSchema,
      runtimeThreadsMethods.threads.output,
      'threadPage',
      () => client().threads(encode(ThreadsRequestSchema, input)),
    ),
  thread: async (id) =>
    answer(
      'runtime.threads/v1 thread',
      ThreadResponseSchema,
      runtimeThreadsMethods.thread.output,
      'thread',
      () => client().thread({ id }),
    ),
  createThread: async (input) =>
    answer(
      'runtime.threads/v1 createThread',
      CreateThreadResponseSchema,
      runtimeThreadsMethods.createThread.output,
      undefined,
      () => client().createThread(encode(CreateThreadRequestSchema, input)),
    ),
  renameThread: async (input) =>
    answer(
      'runtime.threads/v1 renameThread',
      RenameThreadResponseSchema,
      runtimeThreadsMethods.renameThread.output,
      'thread',
      () => client().renameThread(encode(RenameThreadRequestSchema, input)),
    ),
  terminateThread: async (id) =>
    answer(
      'runtime.threads/v1 terminateThread',
      TerminateThreadResponseSchema,
      runtimeThreadsMethods.terminateThread.output,
      'thread',
      () => client().terminateThread({ id }),
    ),
  deleteThread: async (id) =>
    answer(
      'runtime.threads/v1 deleteThread',
      DeleteThreadResponseSchema,
      runtimeThreadsMethods.deleteThread.output,
      'deleteResult',
      () => client().deleteThread({ id }),
    ),
  archiveThread: async (input) =>
    answer(
      'runtime.threads/v1 archiveThread',
      ArchiveThreadResponseSchema,
      runtimeThreadsMethods.archiveThread.output,
      undefined,
      () => client().archiveThread(encode(ArchiveThreadRequestSchema, input)),
    ),
  restoreThread: async (input) =>
    answer(
      'runtime.threads/v1 restoreThread',
      RestoreThreadResponseSchema,
      runtimeThreadsMethods.restoreThread.output,
      undefined,
      () => client().restoreThread(encode(RestoreThreadRequestSchema, input)),
    ),
  setThreadPinned: async (input) =>
    answer(
      'runtime.threads/v1 setThreadPinned',
      SetThreadPinnedResponseSchema,
      runtimeThreadsMethods.setThreadPinned.output,
      'thread',
      () =>
        client().setThreadPinned(encode(SetThreadPinnedRequestSchema, input)),
    ),
  viewThread: (input, listener) =>
    observe(
      (signal) => client().viewThread(input, { signal }),
      item(
        'runtime.threads/v1 viewThread',
        ViewThreadResponseSchema,
        threadViewItemSchema,
      ),
      toStreamObserver(listener),
    ),
});
