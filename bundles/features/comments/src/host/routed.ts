// `CommentsPorts` over the router (phase 3, S52a): the Thread log read through
// `runtime.threads/v1`, the rows appended through `events/v1`, and the two
// event types registered without a sink (D6).

import { toJson } from '@bufbuild/protobuf';
import { anyPack, ValueSchema } from '@bufbuild/protobuf/wkt';
import type { Client } from '@connectrpc/connect';
import { EventsService } from 'bundle/contracts/gen/doric/events/v1/events_pb.js';
import {
  contractErrorOf,
  type HostContext,
  type HostServices,
} from 'bundle/host';
import { readThreadEventLog, type ThreadEvent } from 'runtime/contracts';
import { ThreadsService } from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import type { ThreadEvent as ThreadEventMessage } from 'runtime/contracts/gen/doric/runtime/v2/runtime_pb.js';

import { CommentsAddedSchema } from '../contracts/gen/doric/comments/added/v1/added_pb.js';
import { CommentsResolvedSchema } from '../contracts/gen/doric/comments/resolved/v1/resolved_pb.js';
import {
  commentsAddedEvent,
  commentsResolvedEvent,
} from '../contracts/index.js';
import { addedMessageOf, resolvedMessageOf } from './codec.js';
import type { CommentsPorts } from './ports.js';

/** Runs `work`, rethrowing a routed call's failure as its `ContractError`. */
const routed = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw contractErrorOf(error);
  }
};

/** A `runtime.threads/v1` row as the kernel answers it (`event` the stored JSON). */
const threadEventOf = (entry: ThreadEventMessage): ThreadEvent => ({
  projectId: entry.projectId,
  threadId: entry.threadId,
  promptId: entry.promptId,
  sequence: entry.sequence,
  type: entry.type,
  event:
    entry.event === undefined ? undefined : toJson(ValueSchema, entry.event),
  createdAt: entry.createdAt,
});

/**
 * `CommentsPorts` over the router. Each method makes one call per Thread
 * through a client of `services.use(…)` created on first use; calls made
 * inside a handler inherit its scope, deadline and signal. Failures reject
 * with `contractErrorOf`'s `ContractError`.
 * - `threadEvents`: `runtime.threads/v1.ThreadEvents{id, afterSequence: 0}`;
 *   an absent `threadEventLog` answers `[]`; each `ThreadEvent` as
 *   `toJson(…, {alwaysEmitImplicit: true})` (`event` the stored JSON).
 * - `projectThreadIds`: `ProjectThreads{projectId}` → `threads[].id`.
 * - `appendAdded`/`appendResolved`: `events/v1.Append{type, payload:
 *   anyPack(Schema, addedMessageOf(p) | resolvedMessageOf(p))}`.
 */
export const routedCommentsPorts = (
  services: Pick<HostServices, 'use'>,
): CommentsPorts => {
  let threadsClient: Client<typeof ThreadsService> | undefined;
  let eventsClient: Client<typeof EventsService> | undefined;
  const threads = () => (threadsClient ??= services.use(ThreadsService));
  const events = () => (eventsClient ??= services.use(EventsService));

  return {
    threadEvents: (threadId) =>
      routed(async () => {
        const threadEventLog = await readThreadEventLog(threads(), {
          id: threadId,
          afterSequence: 0,
        });

        return (threadEventLog?.events ?? []).map(threadEventOf);
      }),
    projectThreadIds: (projectId) =>
      routed(async () =>
        (await threads().projectThreads({ projectId })).threads.map(
          (thread) => thread.id,
        ),
      ),
    appendAdded: (payload) =>
      routed(async () => {
        await events().append({
          type: commentsAddedEvent.type,
          payload: anyPack(CommentsAddedSchema, addedMessageOf(payload)),
        });
      }),
    appendResolved: (payload) =>
      routed(async () => {
        await events().append({
          type: commentsResolvedEvent.type,
          payload: anyPack(CommentsResolvedSchema, resolvedMessageOf(payload)),
        });
      }),
  };
};

/**
 * Registers the two event types through `context.registrations.track(EventsService, …)`
 * (D6), replayed after a `core` restart. Resolves once both answered; rejects
 * with the first refusal (`registration_conflict`, `invalid_input`,
 * `not_owner`), which fails `activate`.
 */
export const registerCommentEvents = async (
  context: Pick<HostContext, 'registrations'>,
): Promise<void> => {
  for (const [type, messageType] of [
    [commentsAddedEvent.type, CommentsAddedSchema.typeName],
    [commentsResolvedEvent.type, CommentsResolvedSchema.typeName],
  ] as const) {
    await context.registrations.track(EventsService, (client) =>
      routed(() => client.register({ type, messageType })),
    );
  }
};
