// `comments/v1` messages ⇄ today's domain values (phase 3, S52a, D3). The
// anchor's oneof case is today's `form` and the case message's fields sit
// beside it; an absent optional field is an absent key; `revision` is a
// number. Unknown keys of a loose domain value are dropped on the way to a
// message. The registry's logic runs on domain values, unchanged.

import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { ContractError } from 'bundle/contracts';

import {
  type CommentsAdded,
  CommentsAddedSchema,
} from '../contracts/gen/doric/comments/added/v1/added_pb.js';
import {
  type CommentsResolved,
  CommentsResolvedSchema,
} from '../contracts/gen/doric/comments/resolved/v1/resolved_pb.js';
import {
  type AddRequest,
  type CommentAnchorFieldsSchema,
  type Comment as CommentMessage,
  CommentSchema,
  type CommentTarget as CommentTargetMessage,
  type CommentTargetSchema,
  type ListRequest,
  type ResolveRequest,
} from '../contracts/gen/doric/comments/v1/comments_pb.js';
import {
  type Comment,
  type CommentAddInput,
  type CommentAnchor,
  type CommentListInput,
  type CommentResolveInput,
  type CommentsAddedPayload,
  type CommentsResolvedPayload,
  type CommentTarget,
  commentSchema,
  commentsAddedEvent,
} from '../contracts/index.js';

/** A record without the keys whose value is `undefined`: absent means absent. */
const definedFields = <T extends object>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;

const isPseudo = (
  value: string,
): value is NonNullable<CommentAnchor['pseudo']> =>
  value === '::before' || value === '::after';

/** A wire target as today's: the anchor's oneof case is `form`. */
const targetOf = (target: CommentTargetMessage | undefined): CommentTarget => {
  const form = target?.anchor?.form;

  if (target === undefined || form?.case === undefined) {
    throw new ContractError(
      'invalid_input',
      'A comment needs a target and its anchor.',
    );
  }

  const {
    path,
    line,
    selector,
    x,
    y,
    label,
    text,
    pseudo,
    turn,
    block,
    at,
    item,
  } = form.value;

  if (pseudo !== undefined && !isPseudo(pseudo)) {
    throw new ContractError(
      'invalid_input',
      `A comment anchor's pseudo is "::before" or "::after", not "${pseudo}".`,
    );
  }

  const anchor = definedFields({
    form: form.case,
    path,
    line,
    selector,
    x,
    y,
    label,
    text,
    pseudo,
    turn,
    block,
    at,
    item,
  });

  return definedFields({
    kind: target.kind,
    id: target.id,
    revision: target.revision,
    anchor,
  });
};

/** Today's target as the wire init; only the keys the message declares. */
const targetInitOf = (
  target: CommentTarget,
): MessageInitShape<typeof CommentTargetSchema> => {
  const {
    form,
    path,
    line,
    selector,
    x,
    y,
    label,
    text,
    pseudo,
    turn,
    block,
    at,
    item,
  } = target.anchor;
  const value: MessageInitShape<typeof CommentAnchorFieldsSchema> =
    definedFields({
      path,
      line,
      selector,
      x,
      y,
      label,
      text,
      pseudo,
      turn,
      block,
      at,
      item,
    });

  return definedFields({
    kind: target.kind,
    id: target.id,
    revision: target.revision,
    anchor: { form: { case: form, value } },
  });
};

/** A validated `AddRequest` as `addComment`'s input. Never throws for a request protovalidate accepted. */
export const addInputOf = (request: AddRequest): CommentAddInput =>
  definedFields({
    target: targetOf(request.target),
    text: request.text,
    author: request.author,
    commentId: request.commentId,
    inReplyTo: request.inReplyTo,
  });

/** A `ListRequest` as `listComments`' input (`target` and `kind` only when set). Never throws. */
export const listInputOf = (request: ListRequest): CommentListInput =>
  definedFields({
    target:
      request.target === undefined
        ? undefined
        : definedFields({
            kind: request.target.kind,
            id: request.target.id,
            revision: request.target.revision,
          }),
    kind: request.kind,
  });

/** A `ResolveRequest` as `resolveComment`'s input. Never throws. */
export const resolveInputOf = (
  request: ResolveRequest,
): CommentResolveInput => ({
  commentId: request.commentId,
  resolved: request.resolved,
});

/**
 * A domain comment as the wire `Comment`. Throws `ContractError('invalid_output')`
 * when the value does not fit the message (a stored row with a target the
 * proto cannot carry), so the call fails rather than answering a partial
 * comment.
 */
export const commentMessageOf = (comment: Comment): CommentMessage => {
  const checked = commentSchema.safeParse(comment);

  if (!checked.success) {
    throw new ContractError(
      'invalid_output',
      `The comment "${comment.commentId}" does not fit comments/v1.Comment.`,
      { commentId: comment.commentId, issues: checked.error.issues },
    );
  }

  return create(
    CommentSchema,
    definedFields({
      commentId: comment.commentId,
      target: targetInitOf(comment.target),
      text: comment.text,
      author: comment.author,
      resolved: comment.resolved,
      createdAt: comment.createdAt,
      inReplyTo: comment.inReplyTo,
    }),
  );
};

/** A payload as the `Append` message; throws `ContractError('invalid_input')` when it does not fit. */
export const addedMessageOf = (
  payload: CommentsAddedPayload,
): CommentsAdded => {
  const checked = commentsAddedEvent.payload.safeParse(payload);

  if (!checked.success) {
    throw new ContractError(
      'invalid_input',
      `The comment "${payload.commentId}" does not fit comments.added/v1.`,
      { commentId: payload.commentId, issues: checked.error.issues },
    );
  }

  return create(
    CommentsAddedSchema,
    definedFields({
      commentId: payload.commentId,
      target: targetInitOf(payload.target),
      text: payload.text,
      author: payload.author,
      createdAt: payload.createdAt,
      inReplyTo: payload.inReplyTo,
    }),
  );
};

/** As {@link addedMessageOf}, for `comments.resolved/v1`. */
export const resolvedMessageOf = (
  payload: CommentsResolvedPayload,
): CommentsResolved =>
  create(CommentsResolvedSchema, {
    commentId: payload.commentId,
    resolved: payload.resolved,
  });
