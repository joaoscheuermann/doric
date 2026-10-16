// `comments/v1` (host): the registry of anchored comments.
//
// The registry never interprets a target — not its `kind`, not its `revision`,
// not what the anchor points at. It stores what the caller declared and
// forwards it, which is what lets the same service carry a comment on an
// artifact revision and a comment on a message.
//
// The durable record is the event log (`comments.added/v1`,
// `comments.resolved/v1`); the list this service answers is the index of the
// comments this process saw, kept in the order they were written, which is the
// order of the log. A draft is never written here: only the send flushes.

import { randomBytes } from 'node:crypto';

import {
  type Call,
  ContractError,
  defineMethod,
  defineService,
  EventsV1,
  type Services,
} from 'bundle/contracts';

import {
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

const newCommentId = (): string => `comment-${randomBytes(4).toString('hex')}`;

/**
 * Whether two targets name the same thing; the anchor is not part of it —
 * `list` filters by the target's identity, and the identity is the key.
 */
const sameTarget = (left: CommentTarget, right?: CommentTargetKey): boolean =>
  right !== undefined &&
  left.kind === right.kind &&
  left.id === right.id &&
  left.revision === right.revision;

export const commentsService = () => {
  const comments: Comment[] = [];

  return defineService(CommentsV1, {
    add: defineMethod({
      expose: 'desktop',
      ...commentsMethods.add,
      execute: async (
        input: CommentAddInput,
        call: Call,
        services: Services,
      ): Promise<Comment> => {
        const text = input.text.trim();

        if (text.length === 0) {
          throw new ContractError('invalid_input', 'A comment needs text.', {
            target: input.target,
          });
        }

        const comment: Comment = definedFields({
          commentId: newCommentId(),
          target: input.target,
          text,
          author: input.author,
          resolved: false,
          createdAt: new Date().toISOString(),
        });

        comments.push(comment);

        await services.use(EventsV1).append(
          commentsAddedEvent,
          definedFields({
            commentId: comment.commentId,
            target: comment.target,
            text: comment.text,
            author: comment.author,
          }),
          call,
        );

        return comment;
      },
    }),
    list: defineMethod({
      expose: 'desktop',
      ...commentsMethods.list,
      execute: async (input: CommentListInput): Promise<readonly Comment[]> =>
        comments.filter(
          (comment) =>
            (input.kind === undefined || comment.target.kind === input.kind) &&
            (input.target === undefined ||
              sameTarget(comment.target, input.target)),
        ),
    }),
    resolve: defineMethod({
      expose: 'desktop',
      ...commentsMethods.resolve,
      execute: async (
        input: CommentResolveInput,
        call: Call,
        services: Services,
      ): Promise<Comment | undefined> => {
        const index = comments.findIndex(
          (comment) => comment.commentId === input.commentId,
        );

        if (index < 0) return undefined;

        const current = comments[index] as Comment;

        // Idempotent: the durable event records the transition, and a call
        // that asks for the state the comment already has writes nothing —
        // as `artifacts/v1.approve` does and the fake host always did.
        if (current.resolved === input.resolved) return current;

        const next: Comment = { ...current, resolved: input.resolved };

        comments[index] = next;

        await services
          .use(EventsV1)
          .append(
            commentsResolvedEvent,
            { commentId: next.commentId, resolved: next.resolved },
            call,
          );

        return next;
      },
    }),
  });
};
