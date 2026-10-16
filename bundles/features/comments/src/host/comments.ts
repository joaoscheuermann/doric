// `comments/v1` (host): the registry of anchored comments.
//
// The registry never interprets a target — not its `kind`, not its `revision`,
// not what the anchor points at. It stores what the caller declared and
// forwards it, which is what lets the same service carry a comment on an
// artifact revision and a comment on a message.
//
// The durable record is the event log, and it is the only one: `add` and
// `resolve` append `comments.added/v1` and `comments.resolved/v1` to the
// call's Thread, and `list` and `resolve` fold those rows back out of the log
// (`runtime.threads/v1.threadEvents`). Nothing is held in the process, so a
// restarted host, a replay or a rewind answers exactly what the log keeps. A
// draft is never written here: only the send flushes.

import { randomUUID } from 'node:crypto';

import {
  type Call,
  ContractError,
  defineMethod,
  defineService,
  EventsV1,
  type Services,
} from 'bundle/contracts';
import { RuntimeThreadsV1, type ThreadEvent } from 'runtime/contracts';

import {
  COMMENT_ID_PATTERN,
  type Comment,
  type CommentAddInput,
  type CommentListInput,
  type CommentResolveInput,
  CommentsV1,
  type CommentTarget,
  type CommentTargetKey,
  commentsAddedEvent,
  commentsMethods,
  commentsResolvedEvent,
} from '../contracts/index.js';

/** A record without the keys whose value is `undefined`: absent means absent. */
const definedFields = <T extends object>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;

const newCommentId = (): string => `comment-${randomUUID()}`;

/**
 * Whether two targets name the same thing; the anchor is not part of it —
 * `list` filters by the target's identity, and the identity is the key.
 */
const sameTarget = (left: CommentTarget, right?: CommentTargetKey): boolean =>
  right !== undefined &&
  left.kind === right.kind &&
  left.id === right.id &&
  left.revision === right.revision;

/** The Project and, when the call names one, the Thread a call reads. */
interface ReadScope {
  readonly projectId: string;
  readonly threadId?: string;
}

const scopeError = (needs: string): ContractError =>
  new ContractError(
    'invalid_scope',
    `comments/v1 needs a call scope with ${needs}.`,
  );

/** The scope a read folds: the Project always, the Thread when given. */
const readScope = (call: Call): ReadScope => {
  const projectId = call.scope?.projectId;

  if (projectId === undefined) throw scopeError('a project');

  const threadId = call.scope?.threadId;

  return threadId === undefined ? { projectId } : { projectId, threadId };
};

/** The scope a write lands in: an event row needs all three keys. */
const writeScope = (call: Call): Required<ReadScope> => {
  const { projectId, threadId, promptId } = call.scope ?? {};

  if (
    projectId === undefined ||
    threadId === undefined ||
    promptId === undefined
  ) {
    throw scopeError('a project, a Thread and a prompt');
  }

  return { projectId, threadId };
};

/**
 * Folds one Thread's rows into its comments, in the order of the log: an
 * added row is a comment, a resolved row sets the state of a comment the
 * Thread already holds. A row that breaks the schema is skipped rather than
 * failing the read, as a projector skips what it does not know.
 */
const fold = (events: readonly ThreadEvent[]): Comment[] => {
  const comments = new Map<string, Comment>();

  for (const entry of events) {
    if (entry.type === commentsAddedEvent.type) {
      const parsed = commentsAddedEvent.payload.safeParse(entry.event);

      if (!parsed.success || comments.has(parsed.data.commentId)) continue;

      const { commentId, target, text, author, createdAt, inReplyTo } =
        parsed.data;

      comments.set(
        commentId,
        definedFields({
          commentId,
          target,
          text,
          author,
          resolved: false,
          createdAt: createdAt ?? entry.createdAt,
          inReplyTo,
        }),
      );
    } else if (entry.type === commentsResolvedEvent.type) {
      const parsed = commentsResolvedEvent.payload.safeParse(entry.event);

      if (!parsed.success) continue;

      const current = comments.get(parsed.data.commentId);

      if (current !== undefined) {
        comments.set(current.commentId, {
          ...current,
          resolved: parsed.data.resolved,
        });
      }
    }
  }

  return [...comments.values()];
};

/** The comments one Thread's log holds, only rows of the given Project. */
const threadComments = async (
  services: Services,
  call: Call,
  projectId: string,
  threadId: string,
): Promise<Comment[]> => {
  const log = await services
    .use(RuntimeThreadsV1)
    .threadEvents({ id: threadId, afterSequence: 0 }, call);

  return fold(
    (log?.events ?? []).filter(
      (entry) => entry.projectId === projectId && entry.threadId === threadId,
    ),
  );
};

/**
 * The comments of a read scope: the Thread's own, or every Thread of the
 * Project — each Thread in the log's order, the Threads by creation, which
 * is the order `projectThreads` answers.
 */
const scopeComments = async (
  services: Services,
  call: Call,
  scope: ReadScope,
): Promise<Comment[]> => {
  if (scope.threadId !== undefined) {
    return threadComments(services, call, scope.projectId, scope.threadId);
  }

  const threads = await services
    .use(RuntimeThreadsV1)
    .projectThreads(scope.projectId, call);
  const perThread = await Promise.all(
    threads.map((thread) =>
      threadComments(services, call, scope.projectId, thread.id),
    ),
  );

  return perThread.flat();
};

/**
 * Writes one comment under the call's Thread. The caller may choose the id and
 * the root it answers; without an id one is generated. A comment of the log
 * with the chosen id is returned as it stands and nothing is appended, which
 * makes a retried flush safe. A reply is normalized to the thread's root.
 */
export const addComment = async (
  services: Services,
  call: Call,
  input: CommentAddInput,
): Promise<Comment> => {
  const text = input.text.trim();

  if (text.length === 0) {
    throw new ContractError('invalid_input', 'A comment needs text.', {
      target: input.target,
    });
  }

  if (
    input.commentId !== undefined &&
    !COMMENT_ID_PATTERN.test(input.commentId)
  ) {
    throw new ContractError(
      'invalid_input',
      'A comment id has 1 to 128 letters, digits, "_" or "-".',
    );
  }

  const { projectId, threadId } = writeScope(call);

  // The log is read only when the answer depends on it: a chosen id may
  // already be written, and a reply must name a comment the Thread holds.
  const existing =
    input.commentId === undefined && input.inReplyTo === undefined
      ? []
      : await threadComments(services, call, projectId, threadId);

  const written = existing.find(
    (comment) => comment.commentId === input.commentId,
  );

  if (written !== undefined) return written;

  let inReplyTo: string | undefined;

  if (input.inReplyTo !== undefined) {
    const parent = existing.find(
      (comment) => comment.commentId === input.inReplyTo,
    );

    if (parent === undefined) {
      throw new ContractError(
        'invalid_input',
        `The comment "${input.inReplyTo}" is unknown in this Thread.`,
      );
    }

    inReplyTo = parent.inReplyTo ?? parent.commentId;
  }

  const comment: Comment = definedFields({
    commentId: input.commentId ?? newCommentId(),
    target: input.target,
    text,
    author: input.author,
    resolved: false,
    createdAt: new Date().toISOString(),
    inReplyTo,
  });

  // The append is the write: a refused append leaves nothing behind.
  await services.use(EventsV1).append(
    commentsAddedEvent,
    definedFields({
      commentId: comment.commentId,
      target: comment.target,
      text: comment.text,
      author: comment.author,
      createdAt: comment.createdAt,
      inReplyTo: comment.inReplyTo,
    }),
    call,
  );

  return comment;
};

/**
 * Marks one comment of the call's Thread attended (or reopens it). Only the
 * comments of the call's own Thread: a comment is resolved where it was
 * written, so the event lands next to its `added` row.
 */
export const resolveComment = async (
  services: Services,
  call: Call,
  input: CommentResolveInput,
): Promise<Comment | undefined> => {
  const { projectId, threadId } = writeScope(call);
  const current = (
    await threadComments(services, call, projectId, threadId)
  ).find((comment) => comment.commentId === input.commentId);

  if (current === undefined) return undefined;

  // Idempotent: the durable event records the transition, and a call
  // that asks for the state the comment already has writes nothing —
  // as `artifacts/v1.approve` does.
  if (current.resolved === input.resolved) return current;

  await services
    .use(EventsV1)
    .append(
      commentsResolvedEvent,
      { commentId: current.commentId, resolved: input.resolved },
      call,
    );

  return { ...current, resolved: input.resolved };
};

/** The comment of the call's Thread with this id, if the log holds it. */
export const findComment = async (
  services: Services,
  call: Call,
  commentId: string,
): Promise<Comment | undefined> => {
  const { projectId, threadId } = writeScope(call);

  return (await threadComments(services, call, projectId, threadId)).find(
    (comment) => comment.commentId === commentId,
  );
};

export const commentsService = () =>
  defineService(CommentsV1, {
    add: defineMethod({
      expose: 'desktop',
      ...commentsMethods.add,
      execute: (input: CommentAddInput, call: Call, services: Services) =>
        addComment(services, call, input),
    }),
    list: defineMethod({
      expose: 'desktop',
      ...commentsMethods.list,
      execute: async (
        input: CommentListInput,
        call: Call,
        services: Services,
      ): Promise<readonly Comment[]> =>
        (await scopeComments(services, call, readScope(call))).filter(
          (comment) =>
            (input.kind === undefined || comment.target.kind === input.kind) &&
            (input.target === undefined ||
              sameTarget(comment.target, input.target)),
        ),
    }),
    resolve: defineMethod({
      expose: 'desktop',
      ...commentsMethods.resolve,
      execute: (input: CommentResolveInput, call: Call, services: Services) =>
        resolveComment(services, call, input),
    }),
  });
