// The comment threads a Thread's log holds, folded from `comments.added/v1`
// and `comments.resolved/v1` across the whole log: each root comment with its
// replies in log order, and whether it is resolved. The state a thread is in is
// the one fact every surface of the conversation shows — the marker at the end
// of a user-turn line and the chip of an agent's reply block — so it is stated
// once here, in terms of the fold.

import type { TurnComment } from '../../contracts/index.js';

/** The author the agent's replies are written under (`comment_reply`). */
export const AGENT_COMMENT_AUTHOR = 'agent';

/** The tool the agent answers a comment with; its reply block replaces its row. */
export const COMMENT_REPLY_TOOL = 'comment_reply';

/**
 * Where a thread stands: resolved, waiting for the reader (the agent spoke
 * last), or open (the reader spoke last, or nobody answered yet).
 */
export type CommentThreadState = 'done' | 'await' | 'open';

/** One message of a thread, with the pin its user turn numbered it by. */
export type ThreadComment = TurnComment & {
  /** The 1-based position among its prompt's comments, for the line's `[n]`. */
  readonly pin?: number;
};

/** One comment thread of the log. */
export interface CommentThread {
  readonly rootId: string;
  /** The root's target, else the first message's. */
  readonly target: unknown;
  /** The root (when the log holds it) and then its replies, in log order. */
  readonly messages: readonly ThreadComment[];
  readonly resolved: boolean;
}

/** Every thread of a log, by root comment id. */
export type CommentThreads = ReadonlyMap<string, CommentThread>;

/** Whether the agent wrote this comment. */
export const isAgentComment = (comment: {
  readonly author?: string;
}): boolean => comment.author === AGENT_COMMENT_AUTHOR;

/** The root a comment belongs to: the one it answers, else itself. */
export const rootIdOf = (comment: TurnComment): string =>
  comment.inReplyTo ?? comment.commentId;

/** The state a thread is in. */
export const threadState = (thread: CommentThread): CommentThreadState => {
  if (thread.resolved) return 'done';
  const last = thread.messages.at(-1);
  return last !== undefined && isAgentComment(last) ? 'await' : 'open';
};

/** How many times the agent answered in a thread. */
export const agentReplies = (thread: CommentThread): number =>
  thread.messages.filter(isAgentComment).length;

/**
 * The message the agent answers when it replies now: the latest one the
 * reader wrote — the root, or the reader's own reply after it.
 */
export const askedIn = (thread: CommentThread): ThreadComment | undefined =>
  [...thread.messages].reverse().find((message) => !isAgentComment(message));

/**
 * Folds one comment into the threads (the map is the caller's copy). A root
 * leads its thread wherever its replies already stand; a reply follows.
 */
export const foldComment = (
  threads: Map<string, CommentThread>,
  comment: ThreadComment,
): void => {
  const rootId = rootIdOf(comment);
  const held = threads.get(rootId);
  if (held?.messages.some((message) => message.commentId === comment.commentId))
    return;
  const isRoot = comment.inReplyTo === undefined;
  threads.set(rootId, {
    rootId,
    target: isRoot || held === undefined ? comment.target : held.target,
    messages:
      held === undefined
        ? [comment]
        : isRoot
          ? [comment, ...held.messages]
          : [...held.messages, comment],
    resolved: held?.resolved ?? false,
  });
};

/** Folds one `comments.resolved/v1` into the threads (the caller's copy). */
export const foldResolved = (
  threads: Map<string, CommentThread>,
  commentId: string,
  resolved: boolean,
): void => {
  const held = threads.get(commentId);
  threads.set(
    commentId,
    held === undefined
      ? { rootId: commentId, target: undefined, messages: [], resolved }
      : { ...held, resolved },
  );
};

/** Reads a `comments.resolved/v1` payload, else `undefined`. */
export const resolvedFrom = (
  payload: unknown,
): { readonly commentId: string; readonly resolved: boolean } | undefined => {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  return typeof record.commentId === 'string' &&
    record.commentId.length > 0 &&
    typeof record.resolved === 'boolean'
    ? { commentId: record.commentId, resolved: record.resolved }
    : undefined;
};
