// Dev-only: `comments/v1`, in memory.
//
// The registry never interprets the target (`docs/architecture/bundles/comments.md`):
// it stores what it was given, appends `comments.added/v1` or
// `comments.resolved/v1` to the Thread log and answers the comment back. The
// anchor is opaque here — resolving it against the rendered structure is the
// target owner's job, and there is no rendered structure in a dev host.
//
// Events go to the Thread the call's scope names, with the scope's prompt —
// the one a send has just accepted, which is where the flush writes them — or
// else the Thread's current one: that places the cards in the conversation
// beside the turn they comment on. A call without that scope is refused.

import { randomUUID } from 'node:crypto';

import { DevHostError } from './bundles.mjs';

/** Whether two comment targets name the same thing, by the fields the wire has. */
const sameTarget = (left, right) => {
  if (left === undefined || right === undefined) return true;
  if (left.kind !== right.kind || left.id !== right.id) return false;

  return left.revision === undefined || right.revision === undefined
    ? true
    : left.revision === right.revision;
};

export const createComments = ({
  threads,
  log,
  now = () => new Date().toISOString(),
}) => {
  /** commentId → the comment, in the order the log holds them. */
  const comments = new Map();

  /**
   * The Thread an event belongs to: the call's own scope, never a default —
   * the real host scopes every write by the calling Project and Thread, and a
   * call without them is refused, as it would be there.
   */
  const scopeOf = (scope) => {
    if (typeof scope?.projectId !== 'string' || scope.projectId === '') {
      throw new DevHostError(
        'invalid_input',
        'The call needs a projectId in its scope.',
      );
    }

    if (typeof scope.threadId !== 'string' || scope.threadId === '') {
      throw new DevHostError(
        'invalid_input',
        'The call needs a threadId in its scope: its event belongs to a Thread log.',
      );
    }

    return {
      projectId: scope.projectId,
      threadId: scope.threadId,
      promptId: scope.promptId ?? threads.promptIdOf(scope.threadId),
    };
  };

  const append = (scope, type, event) =>
    threads.append({ ...scopeOf(scope), type, event });

  /** `comments/v1.add`: stores one comment and writes its event. */
  const add = (input = {}, scope) => {
    const { target, text, author } = input;

    if (target === undefined || typeof target.id !== 'string') {
      throw new DevHostError('invalid_input', 'A comment needs a target.');
    }

    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new DevHostError(
        'invalid_input',
        'A comment needs non-empty text.',
      );
    }

    const comment = {
      commentId: randomUUID(),
      target,
      text,
      resolved: false,
      createdAt: now(),
      ...(author === undefined ? {} : { author }),
    };

    comments.set(comment.commentId, comment);

    append(scope, 'comments.added/v1', {
      type: 'comments.added/v1',
      commentId: comment.commentId,
      target: comment.target,
      text: comment.text,
      ...(comment.author === undefined ? {} : { author: comment.author }),
    });

    log.note(
      `comment ${comment.commentId} on ${target.kind} ${target.id}: appended to the log of Thread ${scope.threadId}`,
    );

    return comment;
  };

  /** `comments/v1.list`: the comments of one target, or of one kind, by sequence. */
  const list = (input = {}) => {
    const { target, kind } = input;

    return [...comments.values()].filter((comment) => {
      if (kind !== undefined && comment.target.kind !== kind) return false;

      return sameTarget(comment.target, target);
    });
  };

  /** `comments/v1.resolve`: marks one comment attended, writing its event once. */
  const resolve = (input = {}, scope) => {
    const comment = comments.get(input.commentId);

    if (comment === undefined) return undefined;

    const resolved = input.resolved !== false;

    if (comment.resolved !== resolved) {
      comment.resolved = resolved;
      append(scope, 'comments.resolved/v1', {
        type: 'comments.resolved/v1',
        commentId: comment.commentId,
        resolved,
      });
    }

    return comment;
  };

  return { add, list, resolve };
};
