// The two boundaries `comments`' registry reaches (phase 3, S52a): the Thread
// log it folds and the event writer it appends to. The kernel entry binds them
// over its `Services` (`kernelCommentsPorts`), the host part over the router
// (`routedCommentsPorts`, `./routed.ts`); the registry and `comment_reply` are
// written once, over the ports.

import {
  bindRegistrant,
  type Call,
  type ContractTool,
  EventsV1,
  type Registrable,
  type Services,
} from 'bundle/contracts';
import { RuntimeThreadsV1, type ThreadEvent } from 'runtime/contracts';
import type { ToolInput, ToolOutput, UnboundTool } from 'tool';

import {
  type CommentsAddedPayload,
  type CommentsResolvedPayload,
  commentsAddedEvent,
  commentsResolvedEvent,
} from '../contracts/index.js';

/**
 * The two boundaries the registry reaches: the Thread log it folds and the
 * event writer it appends to. Every method runs under `call` (its scope,
 * deadline and signal) and rejects with the provider's `ContractError`; no
 * method retries or caches.
 */
export interface CommentsPorts {
  /**
   * Every row of Thread `threadId`'s log, from its first event, in log order,
   * as `runtime.threads/v1` holds them (`event` is the stored JSON body);
   * `[]` when no Thread has that id.
   */
  threadEvents(threadId: string, call: Call): Promise<readonly ThreadEvent[]>;
  /** The ids of every Thread of Project `projectId`, `createdAt` then id ascending. */
  projectThreadIds(projectId: string, call: Call): Promise<readonly string[]>;
  /**
   * Appends one `comments.added/v1` row to the call's Thread; resolves once the
   * row is written. On rejection nothing was written (`invalid_scope`,
   * `unknown_event`, `not_owner`, `invalid_input`, `unavailable`).
   */
  appendAdded(payload: CommentsAddedPayload, call: Call): Promise<void>;
  /** As {@link CommentsPorts.appendAdded}, for `comments.resolved/v1`. */
  appendResolved(payload: CommentsResolvedPayload, call: Call): Promise<void>;
}

/**
 * The ports over the kernel `Services`: `RuntimeThreadsV1.threadEvents({id,
 * afterSequence: 0})` (`[]` for `undefined`), `projectThreads` (ids), and
 * `EventsV1.append(commentsAddedEvent | commentsResolvedEvent, payload, call)`.
 * Makes no call until a method is called. Kernel-only; removed with the
 * kernel (group F).
 */
export const kernelCommentsPorts = (services: Services): CommentsPorts => ({
  threadEvents: async (threadId, call) =>
    (
      await services
        .use(RuntimeThreadsV1)
        .threadEvents({ id: threadId, afterSequence: 0 }, call)
    )?.events ?? [],
  projectThreadIds: async (projectId, call) =>
    (await services.use(RuntimeThreadsV1).projectThreads(projectId, call)).map(
      (thread) => thread.id,
    ),
  appendAdded: (payload, call) =>
    services.use(EventsV1).append(commentsAddedEvent, payload, call),
  appendResolved: (payload, call) =>
    services.use(EventsV1).append(commentsResolvedEvent, payload, call),
});

/**
 * A tool over `CommentsPorts` as the kernel `tools/v1` registers it: binding
 * it with the registering bundle's `Services` answers
 * `definition.bind(kernelCommentsPorts(services))`. Never throws.
 * Kernel-only.
 */
export const kernelRegistrable = (
  definition: UnboundTool<ToolInput, ToolOutput, CommentsPorts>,
): Registrable<ContractTool> => ({
  [bindRegistrant]: (services) =>
    definition.bind(kernelCommentsPorts(services)),
});
