import { type CallArg, ref } from 'bundle/contracts';
import { z } from 'zod';

/*
 * Each schema is annotated with its interface so a provider returns the
 * interface it already has; the runtime value stays a loose zod object.
 */

/*
 * runtime.threads/v1: the direct-child controls of one active parent prompt,
 * derived one to one from packages/host's ThreadControl. Record schemas are
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
  | { readonly status: 'missing' | 'inactive' };

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
    z.looseObject({ status: z.enum(['missing', 'inactive']) }),
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
 * direct children of its Thread in the same Project.
 */
export interface RuntimeThreads {
  spawn(prompt: string, call?: CallArg): Promise<SpawnedThread>;
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

export const runtimeThreadsMethods = {
  spawn: { input: z.string(), output: spawnedThreadSchema },
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
} as const;

export const RuntimeThreadsV1 = ref<RuntimeThreads>('runtime.threads/v1');
