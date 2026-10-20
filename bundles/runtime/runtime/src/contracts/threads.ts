import {
  type CallArg,
  type Disposable,
  ref,
  type StreamListener,
} from 'bundle/contracts';
import { z } from 'zod';

import {
  type CompactResult,
  type CwdResult,
  compactResultSchema,
  cwdResultSchema,
  type DeleteResult,
  deleteResultSchema,
  type EditQueueResult,
  editQueueResultSchema,
  type Page,
  type PromptAcceptResult,
  type QueuedPrompt,
  queuedPromptSchema,
  type RemoveQueuedResult,
  type ResumeResult,
  type RewindResult,
  removeQueuedResultSchema,
  resumeResultSchema,
  rewindResultSchema,
  type SteerResult,
  steerResultSchema,
  type Thread,
  type ThreadCreateResult,
  type ThreadEvent,
  type ThreadQueue,
  type ThreadUsage,
  threadCreateResultSchema,
  threadEventSchema,
  threadPageRecordsSchema,
  threadQueueSchema,
  threadSchema,
  threadUsageSchema,
} from './model.js';
import {
  type ThreadWatchInput,
  type ThreadWatchItem,
  watchMethods,
} from './watches.js';

/*
 * Each schema is annotated with its interface so a provider returns the
 * interface it already has; the runtime value stays a loose zod object.
 */

/*
 * runtime.threads/v1: the direct-child controls of one active parent prompt,
 * derived one to one from the tool-host ThreadControl. Record schemas are
 * loose so the host's real (larger) records validate and travel unchanged.
 */

/** A child thread record as it crosses the contract. */
export interface ThreadView {
  readonly id: string;
  readonly projectId: string;
  readonly parentThreadId?: string;
  readonly name: string;
  readonly state: string;
  readonly lastSequence: number;
  readonly activePromptId?: string;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

/** A persisted child event as it crosses the contract. */
export interface ThreadEventView {
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId: string;
  readonly sequence: number;
  readonly type: string;
  readonly event: unknown;
  readonly createdAt: string;
}

/** The final result of the most recent finished prompt. */
export interface ThreadResult {
  readonly status: string;
  readonly text: string;
  readonly promptId: string;
  readonly at: string;
}

export interface ThreadPage {
  readonly items: readonly ThreadView[];
  readonly nextCursor?: string;
}

/** A child's state and, when one exists, its most recent finished result. */
export interface ThreadSummary {
  readonly thread: ThreadView;
  readonly result?: ThreadResult;
}

/** A bounded page of a child's persisted events, with the next exclusive cursor. */
export interface ThreadEventsPage {
  readonly events: readonly ThreadEventView[];
  readonly nextSequence?: number;
}

export interface SpawnedThread {
  readonly threadId: string;
  readonly promptId: string;
}

export type PromptResult =
  | { readonly status: 'accepted'; readonly promptId: string }
  /**
   * The reader may not write here: an agent Thread takes only pause, continue
   * and retry.
   */
  | { readonly status: 'missing' | 'inactive' | 'forbidden' };

export type InterruptResult =
  | 'interrupted'
  | 'missing'
  | 'inactive'
  | 'not_running';

export const threadViewSchema: z.ZodType<ThreadView, ThreadView> =
  z.looseObject({
    id: z.string(),
    projectId: z.string(),
    parentThreadId: z.string().optional(),
    name: z.string(),
    state: z.string(),
    lastSequence: z.number(),
    activePromptId: z.string().optional(),
    errorCode: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
  });

export const threadEventViewSchema: z.ZodType<
  ThreadEventView,
  ThreadEventView
> = z.looseObject({
  projectId: z.string(),
  threadId: z.string(),
  promptId: z.string(),
  sequence: z.number(),
  type: z.string(),
  event: z.unknown(),
  createdAt: z.string(),
});

export const threadResultSchema: z.ZodType<ThreadResult, ThreadResult> =
  z.looseObject({
    status: z.string(),
    text: z.string(),
    promptId: z.string(),
    at: z.string(),
  });

export const threadPageSchema: z.ZodType<ThreadPage, ThreadPage> =
  z.looseObject({
    items: z.array(threadViewSchema),
    nextCursor: z.string().optional(),
  });

export const threadSummarySchema: z.ZodType<ThreadSummary, ThreadSummary> =
  z.looseObject({
    thread: threadViewSchema,
    result: threadResultSchema.optional(),
  });

export const threadEventsPageSchema: z.ZodType<
  ThreadEventsPage,
  ThreadEventsPage
> = z.looseObject({
  events: z.array(threadEventViewSchema),
  nextSequence: z.number().optional(),
});

export const spawnedThreadSchema: z.ZodType<SpawnedThread, SpawnedThread> =
  z.looseObject({
    threadId: z.string(),
    promptId: z.string(),
  });

export const promptResultSchema: z.ZodType<PromptResult, PromptResult> =
  z.union([
    z.looseObject({ status: z.literal('accepted'), promptId: z.string() }),
    z.looseObject({ status: z.enum(['missing', 'inactive', 'forbidden']) }),
  ]);

export const interruptResultSchema = z.enum([
  'interrupted',
  'missing',
  'inactive',
  'not_running',
]);

/**
 * The controls a running parent prompt has over its direct children. A
 * provider binds every method to `call.scope` (the calling prompt) and to
 * direct children of its Thread in the same Project; once the prompt's
 * binding ended every method rejects with
 * `Error('Thread control is no longer active.')`.
 */
export interface RuntimeThreadControls {
  /** Names the child `title`, or the start of `prompt` without one. */
  spawn(prompt: string, title?: string, call?: CallArg): Promise<SpawnedThread>;
  list(limit: number, cursor?: string, call?: CallArg): Promise<ThreadPage>;
  /** The child's state and, when a prompt has finished, its result. */
  get(threadId: string, call?: CallArg): Promise<ThreadSummary>;
  /** A bounded, forward page of the child's events after a cursor. */
  events(
    threadId: string,
    afterSequence: number,
    limit: number,
    call?: CallArg,
  ): Promise<ThreadEventsPage>;
  send(threadId: string, prompt: string, call?: CallArg): Promise<PromptResult>;
  interrupt(
    threadId: string,
    promptId: string,
    call?: CallArg,
  ): Promise<InterruptResult>;
  terminate(threadId: string, call?: CallArg): Promise<ThreadView>;
}

/** The whole log after a cursor, with the Thread's last sequence. */
export interface ThreadEventLog {
  readonly events: readonly ThreadEvent[];
  readonly lastSequence: number;
}

/**
 * The stage-1 controls plus the WorkspaceService.threads operations (design 57
 * §2.3, API mínima). The user-facing methods ignore `call.scope`.
 */
export interface RuntimeThreads extends RuntimeThreadControls {
  createThread(
    input: {
      readonly projectId: string;
      readonly name: string;
      readonly parentThreadId?: string;
    },
    call?: CallArg,
  ): Promise<ThreadCreateResult>;
  /** service.threads.find: with the in-memory storage-pause overlay. */
  thread(id: string, call?: CallArg): Promise<Thread | undefined>;
  /** The stored record, without the overlay (the Socket.IO snapshot read). */
  storedThread(id: string, call?: CallArg): Promise<Thread | undefined>;
  threads(
    input: {
      readonly projectId: string;
      readonly limit: number;
      readonly cursor?: string;
      readonly parentThreadId?: string;
    },
    call?: CallArg,
  ): Promise<Page<Thread> | undefined>;
  /** Every Thread of a Project, createdAt then id ascending. */
  projectThreads(projectId: string, call?: CallArg): Promise<readonly Thread[]>;
  renameThread(
    input: { readonly id: string; readonly name: string },
    call?: CallArg,
  ): Promise<Thread | undefined>;
  setThreadCwd(
    input: { readonly id: string; readonly cwd: string },
    call?: CallArg,
  ): Promise<CwdResult>;
  prompt(
    input: { readonly id: string; readonly prompt: string },
    call?: CallArg,
  ): Promise<PromptAcceptResult>;
  /**
   * Sends the reader's input into the running prompt `promptId` (1.3.0). The
   * prompt takes it in at its next safe point — after the tool batch in flight,
   * or before its final answer would end the turn — and `interrupt` aborts the
   * current step so it continues with the steer at once. Input for a prompt
   * that is no longer running, or while the Thread is stopping, is queued.
   */
  steer(
    input: {
      readonly id: string;
      readonly prompt: string;
      readonly promptId: string;
      readonly interrupt?: boolean;
    },
    call?: CallArg,
  ): Promise<SteerResult>;
  /**
   * 1.5.0: gives the Thread an instruction from the calling bundle, as a steer
   * of `promptId` (or of the prompt running now, without one), queued when
   * nothing runs. Its source is `{ kind: 'bundle' }` with the caller's own
   * bundle id, so the model and the reader see who spoke and why; unlike the
   * reader's `steer`, it reaches agent Threads too. `retain` asks the
   * executor to keep it as a standing instruction (see `InputSource`).
   */
  instruct(
    input: {
      readonly id: string;
      readonly prompt: string;
      readonly reason: string;
      readonly promptId?: string;
      readonly interrupt?: boolean;
      readonly retain?: boolean;
    },
    call?: CallArg,
  ): Promise<SteerResult>;
  resume(
    input: { readonly id: string; readonly promptId: string },
    call?: CallArg,
  ): Promise<ResumeResult>;
  /**
   * 1.4.0: sends the Thread's last prompt again, without the reader writing
   * anything — the third lever an agent Thread offers beside pause and
   * continue. The text comes from the Thread's own log, so this cannot become a
   * way to prompt an agent Thread.
   */
  retry(
    input: { readonly id: string },
    call?: CallArg,
  ): Promise<PromptAcceptResult>;
  rewind(
    input: {
      readonly id: string;
      readonly promptId: string;
      readonly prompt: string;
    },
    call?: CallArg,
  ): Promise<RewindResult>;
  /** service.threads.compact: the on-demand context compaction. */
  compact(
    input: { readonly id: string },
    call?: CallArg,
  ): Promise<CompactResult>;
  /** service.threads.events: the whole log after the cursor. */
  threadEvents(
    input: { readonly id: string; readonly afterSequence: number },
    call?: CallArg,
  ): Promise<ThreadEventLog | undefined>;
  /** The stored events after the cursor, with no record check (replay). */
  storedEventsAfter(
    input: { readonly id: string; readonly afterSequence: number },
    call?: CallArg,
  ): Promise<readonly ThreadEvent[]>;
  /** The reader stop: `promptId` is accepted and ignored, as today. */
  pause(
    input: { readonly id: string; readonly promptId: string },
    call?: CallArg,
  ): Promise<InterruptResult>;
  terminateThread(id: string, call?: CallArg): Promise<Thread | undefined>;
  deleteThread(id: string, call?: CallArg): Promise<DeleteResult>;
  queue(id: string, call?: CallArg): Promise<ThreadQueue | undefined>;
  resumeQueue(id: string, call?: CallArg): Promise<ResumeResult>;
  queuedPrompt(
    input: { readonly id: string; readonly promptId: string },
    call?: CallArg,
  ): Promise<QueuedPrompt | undefined>;
  editQueued(
    input: {
      readonly id: string;
      readonly promptId: string;
      readonly text: string;
      readonly revision: number;
    },
    call?: CallArg,
  ): Promise<EditQueueResult>;
  removeQueued(
    input: { readonly id: string; readonly promptId: string },
    call?: CallArg,
  ): Promise<RemoveQueuedResult>;
  usage(id: string, call?: CallArg): Promise<ThreadUsage | undefined>;
  /**
   * 1.2.0: delivers a background terminal's result to its Thread as a
   * terminal-sourced prompt. Under the Project lock it does nothing for a
   * closing Project or Thread; otherwise it enqueues the redacted text. A
   * failed enqueue logs `Terminal result delivery failed` and closes the
   * Thread with `terminal_result_failed`.
   */
  enqueueTerminalResult(
    input: TerminalResultInput,
    call?: CallArg,
  ): Promise<void>;
  /** 1.2.0: that same log and close, for a result that never arrived. */
  failTerminalResult(
    input: { readonly threadId: string },
    call?: CallArg,
  ): Promise<void>;
  /**
   * The `/threads` namespace as a stream (stage 9 R-STREAM, 1.1.0): one
   * snapshot with the events after `afterSequence`, then gap-free live
   * events and the Thread's lifecycle notices. Remote-callable.
   */
  watchThread(
    input: ThreadWatchInput,
    listener: StreamListener<ThreadWatchItem>,
    call?: CallArg,
  ): Disposable;
}

export interface TerminalResultInput {
  readonly threadId: string;
  readonly promptId: string;
  readonly terminalId: string;
  readonly text: string;
}

export const terminalResultInputSchema = z
  .object({
    threadId: z.string(),
    promptId: z.string(),
    terminalId: z.string(),
    text: z.string(),
  })
  .strict();

const threadPrompt = z
  .object({ id: z.string(), promptId: z.string() })
  .strict();
const afterSequence = z
  .object({ id: z.string(), afterSequence: z.number() })
  .strict();

export const threadEventLogSchema: z.ZodType<ThreadEventLog, ThreadEventLog> =
  z.looseObject({
    events: z.array(threadEventSchema),
    lastSequence: z.number(),
  });

export const runtimeThreadsMethods = {
  spawn: {
    input: z.tuple([z.string(), z.string().optional()]),
    output: spawnedThreadSchema,
  },
  list: {
    input: z.tuple([z.number(), z.string().optional()]),
    output: threadPageSchema,
  },
  get: { input: z.string(), output: threadSummarySchema },
  events: {
    input: z.tuple([z.string(), z.number(), z.number()]),
    output: threadEventsPageSchema,
  },
  send: {
    input: z.tuple([z.string(), z.string()]),
    output: promptResultSchema,
  },
  interrupt: {
    input: z.tuple([z.string(), z.string()]),
    output: interruptResultSchema,
  },
  terminate: { input: z.string(), output: threadViewSchema },
  createThread: {
    input: z
      .object({
        projectId: z.string(),
        name: z.string(),
        parentThreadId: z.string().optional(),
      })
      .strict(),
    output: threadCreateResultSchema,
  },
  thread: { input: z.string(), output: threadSchema.optional() },
  storedThread: { input: z.string(), output: threadSchema.optional() },
  threads: {
    input: z
      .object({
        projectId: z.string(),
        limit: z.number(),
        cursor: z.string().optional(),
        parentThreadId: z.string().optional(),
      })
      .strict(),
    output: threadPageRecordsSchema.optional(),
  },
  projectThreads: { input: z.string(), output: z.array(threadSchema) },
  renameThread: {
    input: z.object({ id: z.string(), name: z.string() }).strict(),
    output: threadSchema.optional(),
  },
  setThreadCwd: {
    input: z.object({ id: z.string(), cwd: z.string() }).strict(),
    output: cwdResultSchema,
  },
  prompt: {
    input: z.object({ id: z.string(), prompt: z.string() }).strict(),
    output: promptResultSchema,
  },
  retry: {
    input: z.object({ id: z.string() }).strict(),
    output: promptResultSchema,
  },
  steer: {
    input: z
      .object({
        id: z.string(),
        prompt: z.string(),
        promptId: z.string(),
        interrupt: z.boolean().optional(),
      })
      .strict(),
    output: steerResultSchema,
  },
  instruct: {
    input: z
      .object({
        id: z.string(),
        prompt: z.string().min(1),
        reason: z.string().min(1).max(64),
        promptId: z.string().optional(),
        interrupt: z.boolean().optional(),
        retain: z.boolean().optional(),
      })
      .strict(),
    output: steerResultSchema,
  },
  resume: { input: threadPrompt, output: resumeResultSchema },
  rewind: {
    input: z
      .object({ id: z.string(), promptId: z.string(), prompt: z.string() })
      .strict(),
    output: rewindResultSchema,
  },
  compact: {
    input: z.object({ id: z.string() }).strict(),
    output: compactResultSchema,
  },
  threadEvents: {
    input: afterSequence,
    output: threadEventLogSchema.optional(),
  },
  storedEventsAfter: {
    input: afterSequence,
    output: z.array(threadEventSchema),
  },
  pause: { input: threadPrompt, output: interruptResultSchema },
  terminateThread: { input: z.string(), output: threadSchema.optional() },
  deleteThread: { input: z.string(), output: deleteResultSchema },
  queue: { input: z.string(), output: threadQueueSchema.optional() },
  resumeQueue: { input: z.string(), output: resumeResultSchema },
  queuedPrompt: { input: threadPrompt, output: queuedPromptSchema.optional() },
  editQueued: {
    input: z
      .object({
        id: z.string(),
        promptId: z.string(),
        text: z.string(),
        revision: z.number(),
      })
      .strict(),
    output: editQueueResultSchema,
  },
  removeQueued: { input: threadPrompt, output: removeQueuedResultSchema },
  usage: { input: z.string(), output: threadUsageSchema.optional() },
  enqueueTerminalResult: { input: terminalResultInputSchema, output: z.void() },
  failTerminalResult: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.void(),
  },
  watchThread: watchMethods.thread,
} as const;

export const RuntimeThreadsV1 = ref<RuntimeThreads>('runtime.threads/v1');
