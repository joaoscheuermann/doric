import { disposableSchema, streamListener } from 'bundle/contracts';
import { z } from 'zod';

import {
  type Project,
  projectSchema,
  type Thread,
  type ThreadEvent,
  threadEventSchema,
  threadSchema,
} from './model.js';

/*
 * The remote watches of the workspace (stage 9 R-STREAM): the items the
 * Socket.IO namespaces `/threads` and `/projects` emit, as stream items a
 * desktop window subscribes to over the bridge. Each watch subscribes to the
 * runtime notices before it reads durable data, buffers what arrives in
 * between and deduplicates replay against live events, as the transport
 * socket does. A snapshot that cannot be read ends the stream with
 * `ContractError('replay_failed', 'The snapshot could not be loaded.')`.
 */

/** The message a failed snapshot read ends a watch with (`workspace:error`). */
export const replayFailedMessage = 'The snapshot could not be loaded.';

export interface ThreadWatchInput {
  readonly threadId: string;
  /** Replay starts after this sequence; 0 replays the whole log. */
  readonly afterSequence: number;
}

/** One `/threads` namespace emission. */
export type ThreadWatchItem =
  | {
      /** `thread:snapshot`: an unknown Thread answers nulls and no events. */
      readonly kind: 'snapshot';
      readonly threadId: string;
      readonly projectId: string | null;
      readonly project: Project | null;
      readonly thread: Thread | null;
      readonly events: readonly ThreadEvent[];
    }
  /** `agent:event`: gap-free, each sequence once, after the snapshot. */
  | { readonly kind: 'event'; readonly event: ThreadEvent }
  /** `thread:updated`. */
  | { readonly kind: 'updated'; readonly thread: Thread }
  /** `thread:deleted`. */
  | {
      readonly kind: 'deleted';
      readonly projectId: string;
      readonly threadId: string;
    };

export interface ProjectWatchInput {
  readonly projectId: string;
}

/** One `/projects` namespace emission about the Project and its Threads. */
export type ProjectWatchItem =
  | {
      /** `project:snapshot`: an unknown Project answers `project: null`. */
      readonly kind: 'snapshot';
      readonly projectId: string;
      readonly project: Project | null;
      readonly threads: readonly Thread[];
    }
  | { readonly kind: 'project-updated'; readonly project: Project }
  | { readonly kind: 'project-deleted'; readonly projectId: string }
  | { readonly kind: 'thread-updated'; readonly thread: Thread }
  | {
      readonly kind: 'thread-deleted';
      readonly projectId: string;
      readonly threadId: string;
    };

/** The Thread a window shows (runtime.threads/v1 1.8.0, `viewThread`). */
export interface ThreadViewInput {
  readonly threadId: string;
}

/**
 * The one item a view stream emits once the runtime holds the view; the view
 * lasts until the stream ends. No other item follows.
 */
export interface ThreadViewItem {
  readonly kind: 'viewing';
  readonly threadId: string;
}

export const threadWatchInputSchema: z.ZodType<
  ThreadWatchInput,
  ThreadWatchInput
> = z
  .object({
    threadId: z.uuid(),
    afterSequence: z.number().int().nonnegative(),
  })
  .strict();

export const projectWatchInputSchema: z.ZodType<
  ProjectWatchInput,
  ProjectWatchInput
> = z.object({ projectId: z.uuid() }).strict();

export const threadViewInputSchema: z.ZodType<
  ThreadViewInput,
  ThreadViewInput
> = z.object({ threadId: z.uuid() }).strict();

export const threadViewItemSchema: z.ZodType<ThreadViewItem, ThreadViewItem> = z
  .object({ kind: z.literal('viewing'), threadId: z.uuid() })
  .strict();

export const threadWatchItemSchema: z.ZodType<
  ThreadWatchItem,
  ThreadWatchItem
> = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('snapshot'),
      threadId: z.string(),
      projectId: z.string().nullable(),
      project: projectSchema.nullable(),
      thread: threadSchema.nullable(),
      events: z.array(threadEventSchema),
    })
    .strict(),
  z.object({ kind: z.literal('event'), event: threadEventSchema }).strict(),
  z.object({ kind: z.literal('updated'), thread: threadSchema }).strict(),
  z
    .object({
      kind: z.literal('deleted'),
      projectId: z.string(),
      threadId: z.string(),
    })
    .strict(),
]);

/** The `ProjectWatchItem` arms after the snapshot. */
const projectWatchUpdateSchemas = [
  z
    .object({ kind: z.literal('project-updated'), project: projectSchema })
    .strict(),
  z
    .object({ kind: z.literal('project-deleted'), projectId: z.string() })
    .strict(),
  z
    .object({ kind: z.literal('thread-updated'), thread: threadSchema })
    .strict(),
  z
    .object({
      kind: z.literal('thread-deleted'),
      projectId: z.string(),
      threadId: z.string(),
    })
    .strict(),
] as const;

export const projectWatchItemSchema: z.ZodType<
  ProjectWatchItem,
  ProjectWatchItem
> = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('snapshot'),
      projectId: z.string(),
      project: projectSchema.nullable(),
      threads: z.array(threadSchema),
    })
    .strict(),
  ...projectWatchUpdateSchemas,
]);

/**
 * The method specs of the two watches and of the view stream, spread into
 * their contracts.
 */
export const watchMethods = {
  thread: {
    input: z.tuple([
      threadWatchInputSchema,
      streamListener(threadWatchItemSchema),
    ]),
    output: disposableSchema,
  },
  project: {
    input: z.tuple([
      projectWatchInputSchema,
      streamListener(projectWatchItemSchema),
    ]),
    output: disposableSchema,
  },
  view: {
    input: z.tuple([
      threadViewInputSchema,
      streamListener(threadViewItemSchema),
    ]),
    output: disposableSchema,
  },
} as const;
