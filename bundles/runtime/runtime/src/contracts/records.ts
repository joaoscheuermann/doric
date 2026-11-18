import {
  type CallArg,
  type Disposable,
  defineMethod,
  defineService,
  disposableSchema,
  functionSchema,
  noInput,
  ref,
} from 'bundle/contracts';
import { z } from 'zod';

import {
  type Project,
  type ProjectColor,
  projectColorSchema,
  projectSchema,
  type Thread,
  threadSchema,
} from './model.js';
import { type ProjectActivity, projectActivitySchema } from './runtime.js';

/*
 * runtime.records/v1 (1.0.0, bundle isolation phase 3): the window's mirror of
 * the host's Projects and Threads. A client contract: the runtime's client
 * part provides it in each window, over runtime/v1 and runtime.threads/v1.
 * Reads are local and synchronous; loads and writes go to the host.
 */

/**
 * One read of the mirror.
 *
 * - `loading`: a load is in flight; `value` is the last settled answer, if any.
 * - `ready`: `value` is the host's answer, kept current by its notices.
 * - `failed`: the last load failed with `error`, the rejection itself (its
 *   `code` and `message`, and any other field it carries). A failed refresh
 *   keeps the last `value`.
 */
export type RecordsRead<T> =
  | { readonly status: 'loading'; readonly value?: T }
  | { readonly status: 'ready'; readonly value: T }
  | {
      readonly status: 'failed';
      readonly value?: T;
      readonly error: { readonly code: string; readonly message: string };
    };

export interface RuntimeRecords {
  // Reads: local, synchronous, answered from memory.
  /**
   * The Project list. The first call starts the load of the list and answers
   * `loading`; later calls answer from memory and start no load.
   */
  projects(call?: CallArg): RecordsRead<readonly Project[]>;
  /** A Project of the loaded list; `undefined` otherwise. Starts no load. */
  project(projectId: string, call?: CallArg): Project | undefined;
  /**
   * The Threads of one Project. The first call for a Project starts the load
   * of its Threads and answers `loading`; from then on the Project is
   * described and its read is kept current.
   */
  threads(projectId: string, call?: CallArg): RecordsRead<readonly Thread[]>;
  /** A Thread of a described Project; `undefined` otherwise. Starts no load. */
  thread(threadId: string, call?: CallArg): Thread | undefined;
  /** Whether the window is connected to the host now. */
  connection(call?: CallArg): 'connected' | 'disconnected';
  /**
   * Called after every change of a read's answer or of the connection, until
   * the returned `Disposable` is disposed.
   */
  subscribe(listener: () => void, call?: CallArg): Disposable;

  // Loads.
  /**
   * Keeps the Project and its Threads current until disposed.
   */
  follow(input: { readonly projectId: string }, call?: CallArg): Disposable;
  /**
   * Starts the read again, whatever its state. It answers `loading` with its
   * last `value` until it settles.
   */
  reload(
    input:
      | { readonly target: 'projects' }
      | { readonly target: 'threads'; readonly projectId: string },
    call?: CallArg,
  ): void;
  /**
   * Asks the host for one Thread, for a Project that is not described;
   * `undefined` when the host has no such Thread. Changes no read. Rejects
   * when the host call fails.
   */
  findThread(
    input: { readonly threadId: string },
    call?: CallArg,
  ): Promise<Thread | undefined>;
  /** The activity of every Project, from the host. Rejects when the host call fails. Changes no read. */
  activity(call?: CallArg): Promise<readonly ProjectActivity[]>;

  // Writes: each calls the host and puts the answer into the mirror before it
  // resolves. A write the host refuses rejects with the host's error.
  /** Creates a Project; the new Project is described with no Threads. */
  createProject(
    input: { readonly name: string },
    call?: CallArg,
  ): Promise<Project>;
  /** Renames a Project; resolves with the renamed record. */
  renameProject(
    input: { readonly projectId: string; readonly name: string },
    call?: CallArg,
  ): Promise<Project>;
  /** Sets the Project's color, or clears it when `color` is absent. */
  setProjectColor(
    input: { readonly projectId: string; readonly color?: ProjectColor },
    call?: CallArg,
  ): Promise<Project>;
  /** Terminates a Project; resolves with its record. */
  terminateProject(
    input: { readonly projectId: string },
    call?: CallArg,
  ): Promise<Project>;
  /** Deletes a Project; the Project and its Threads leave every read. */
  deleteProject(
    input: { readonly projectId: string },
    call?: CallArg,
  ): Promise<void>;
  /** Creates a Thread, under `parentThreadId` when given. */
  createThread(
    input: {
      readonly projectId: string;
      readonly name: string;
      readonly parentThreadId?: string;
    },
    call?: CallArg,
  ): Promise<Thread>;
  /** Renames a Thread; resolves with the renamed record. */
  renameThread(
    input: { readonly threadId: string; readonly name: string },
    call?: CallArg,
  ): Promise<Thread>;
  /** Terminates a Thread; resolves with its record. */
  terminateThread(
    input: { readonly threadId: string },
    call?: CallArg,
  ): Promise<Thread>;
  /** Deletes a Thread; it and its descendants leave every read. */
  deleteThread(
    input: { readonly threadId: string },
    call?: CallArg,
  ): Promise<void>;
  /**
   * Archives the Thread and its idle, unpinned descendants as one batch.
   * `threads` holds every record the archive marked, the target first.
   */
  archiveThread(
    input: { readonly threadId: string },
    call?: CallArg,
  ): Promise<{ readonly batch: string; readonly threads: readonly Thread[] }>;
  /**
   * Un-archives the Thread and its descendants of one batch: `batch`, else
   * the Thread's own. Resolves with every restored record.
   */
  restoreThread(
    input: { readonly threadId: string; readonly batch?: string },
    call?: CallArg,
  ): Promise<readonly Thread[]>;
  /** Pins or unpins a Thread; resolves with its record. */
  setThreadPinned(
    input: { readonly threadId: string; readonly pinned: boolean },
    call?: CallArg,
  ): Promise<Thread>;

  // Presence.
  /**
   * Tells the host that this window shows the Thread, until disposed.
   * Changes no read and reports no failure.
   */
  view(input: { readonly threadId: string }, call?: CallArg): Disposable;
}

/**
 * The ids of `rootId` and of every Thread of `threads` below it, through
 * `parentThreadId`. Always contains `rootId`, even when `threads` lacks it.
 * Pure: it reads only its arguments and never fails.
 */
export const threadSubtreeIds = (
  threads: readonly Thread[],
  rootId: string,
): ReadonlySet<string> => {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const thread of threads) {
      if (
        thread.parentThreadId !== undefined &&
        ids.has(thread.parentThreadId) &&
        !ids.has(thread.id)
      ) {
        ids.add(thread.id);
        changed = true;
      }
    }
  }
  return ids;
};

/** The rejection a failed read holds: `code` and `message`, other fields kept (not strict). */
const recordsErrorSchema = z.looseObject({
  code: z.string(),
  message: z.string(),
});

const readSchema = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion('status', [
    z
      .object({ status: z.literal('loading'), value: value.optional() })
      .strict(),
    z.object({ status: z.literal('ready'), value }).strict(),
    z
      .object({
        status: z.literal('failed'),
        value: value.optional(),
        error: recordsErrorSchema,
      })
      .strict(),
  ]);

const projectIdInput = z.object({ projectId: z.string() }).strict();
const threadIdInput = z.object({ threadId: z.string() }).strict();

export const runtimeRecordsMethods = {
  projects: { input: noInput, output: readSchema(z.array(projectSchema)) },
  project: { input: z.string(), output: projectSchema.optional() },
  threads: { input: z.string(), output: readSchema(z.array(threadSchema)) },
  thread: { input: z.string(), output: threadSchema.optional() },
  connection: {
    input: noInput,
    output: z.enum(['connected', 'disconnected']),
  },
  subscribe: {
    input: functionSchema<() => void>(),
    output: disposableSchema,
  },
  follow: { input: projectIdInput, output: disposableSchema },
  reload: {
    input: z.discriminatedUnion('target', [
      z.object({ target: z.literal('projects') }).strict(),
      z
        .object({ target: z.literal('threads'), projectId: z.string() })
        .strict(),
    ]),
    output: z.void(),
  },
  findThread: { input: threadIdInput, output: threadSchema.optional() },
  activity: { input: noInput, output: z.array(projectActivitySchema) },
  createProject: {
    input: z.object({ name: z.string() }).strict(),
    output: projectSchema,
  },
  renameProject: {
    input: z.object({ projectId: z.string(), name: z.string() }).strict(),
    output: projectSchema,
  },
  setProjectColor: {
    input: z
      .object({ projectId: z.string(), color: projectColorSchema.optional() })
      .strict(),
    output: projectSchema,
  },
  terminateProject: { input: projectIdInput, output: projectSchema },
  deleteProject: { input: projectIdInput, output: z.void() },
  createThread: {
    input: z
      .object({
        projectId: z.string(),
        name: z.string(),
        parentThreadId: z.string().optional(),
      })
      .strict(),
    output: threadSchema,
  },
  renameThread: {
    input: z.object({ threadId: z.string(), name: z.string() }).strict(),
    output: threadSchema,
  },
  terminateThread: { input: threadIdInput, output: threadSchema },
  deleteThread: { input: threadIdInput, output: z.void() },
  archiveThread: {
    input: threadIdInput,
    output: z
      .object({ batch: z.string(), threads: z.array(threadSchema) })
      .strict(),
  },
  restoreThread: {
    input: z
      .object({ threadId: z.string(), batch: z.string().optional() })
      .strict(),
    output: z.array(threadSchema),
  },
  setThreadPinned: {
    input: z.object({ threadId: z.string(), pinned: z.boolean() }).strict(),
    output: threadSchema,
  },
  view: { input: threadIdInput, output: disposableSchema },
} as const;

export const RuntimeRecordsV1 = ref<RuntimeRecords>('runtime.records/v1');

/**
 * `records` behind a service definition of `runtime.records/v1`. Each method
 * reads the member at call time, so a member replaced later is what a caller
 * reaches.
 */
export const runtimeRecordsService = (records: RuntimeRecords) =>
  defineService('runtime.records/v1', {
    projects: defineMethod({
      ...runtimeRecordsMethods.projects,
      execute: () => records.projects(),
    }),
    project: defineMethod({
      ...runtimeRecordsMethods.project,
      execute: (projectId: string) => records.project(projectId),
    }),
    threads: defineMethod({
      ...runtimeRecordsMethods.threads,
      execute: (projectId: string) => records.threads(projectId),
    }),
    thread: defineMethod({
      ...runtimeRecordsMethods.thread,
      execute: (threadId: string) => records.thread(threadId),
    }),
    connection: defineMethod({
      ...runtimeRecordsMethods.connection,
      execute: () => records.connection(),
    }),
    subscribe: defineMethod({
      ...runtimeRecordsMethods.subscribe,
      execute: (listener: () => void) => records.subscribe(listener),
    }),
    follow: defineMethod({
      ...runtimeRecordsMethods.follow,
      execute: (input) => records.follow(input),
    }),
    reload: defineMethod({
      ...runtimeRecordsMethods.reload,
      execute: (input) => records.reload(input),
    }),
    findThread: defineMethod({
      ...runtimeRecordsMethods.findThread,
      execute: (input) => records.findThread(input),
    }),
    activity: defineMethod({
      ...runtimeRecordsMethods.activity,
      execute: () => records.activity(),
    }),
    createProject: defineMethod({
      ...runtimeRecordsMethods.createProject,
      execute: (input) => records.createProject(input),
    }),
    renameProject: defineMethod({
      ...runtimeRecordsMethods.renameProject,
      execute: (input) => records.renameProject(input),
    }),
    setProjectColor: defineMethod({
      ...runtimeRecordsMethods.setProjectColor,
      execute: (input) => records.setProjectColor(input),
    }),
    terminateProject: defineMethod({
      ...runtimeRecordsMethods.terminateProject,
      execute: (input) => records.terminateProject(input),
    }),
    deleteProject: defineMethod({
      ...runtimeRecordsMethods.deleteProject,
      execute: (input) => records.deleteProject(input),
    }),
    createThread: defineMethod({
      ...runtimeRecordsMethods.createThread,
      execute: (input) => records.createThread(input),
    }),
    renameThread: defineMethod({
      ...runtimeRecordsMethods.renameThread,
      execute: (input) => records.renameThread(input),
    }),
    terminateThread: defineMethod({
      ...runtimeRecordsMethods.terminateThread,
      execute: (input) => records.terminateThread(input),
    }),
    deleteThread: defineMethod({
      ...runtimeRecordsMethods.deleteThread,
      execute: (input) => records.deleteThread(input),
    }),
    archiveThread: defineMethod({
      ...runtimeRecordsMethods.archiveThread,
      execute: (input) => records.archiveThread(input),
    }),
    restoreThread: defineMethod({
      ...runtimeRecordsMethods.restoreThread,
      execute: (input) => records.restoreThread(input),
    }),
    setThreadPinned: defineMethod({
      ...runtimeRecordsMethods.setThreadPinned,
      execute: (input) => records.setThreadPinned(input),
    }),
    view: defineMethod({
      ...runtimeRecordsMethods.view,
      execute: (input) => records.view(input),
    }),
  });
