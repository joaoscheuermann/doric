// The stored `comments.added/v1` and `comments.resolved/v1` bodies, read in
// either encoding a Thread log holds from S62 until the phase-4 migration
// (phase 3, S52a, D2): today's zod payload (the kernel's `events/v1`) and the
// message's JSON (`core`'s `events/v1` 1.1.0, the anchor nested by its oneof
// case).

import {
  type DescMessage,
  fromJson,
  type JsonValue,
  toJson,
} from '@bufbuild/protobuf';
import type { z } from 'zod';

import { CommentsAddedSchema } from '../contracts/gen/doric/comments/added/v1/added_pb.js';
import { CommentsResolvedSchema } from '../contracts/gen/doric/comments/resolved/v1/resolved_pb.js';
import {
  commentsAddedEvent,
  commentsResolvedEvent,
} from '../contracts/index.js';

/** A `comments.added/v1` payload in today's shape (the anchor flat, keyed by `form`). */
export type CommentsAddedPayload = z.output<typeof commentsAddedEvent.payload>;
/** A `comments.resolved/v1` payload in today's shape. */
export type CommentsResolvedPayload = z.output<
  typeof commentsResolvedEvent.payload
>;

/**
 * One stored `comments.added/v1` body read in either encoding a Thread log
 * holds from S62 until the phase-4 migration:
 * - today's (the kernel's `events/v1`): the zod payload, anchor flat with
 *   `form`;
 * - the message's JSON (`events/v1` 1.1.0, `core` stores `toJson` of
 *   `CommentsAdded`): anchor nested `{<form>: {…}}`, fields at their default
 *   left out.
 * Keys neither declares (`type` included) are ignored. Answers the payload in
 * today's shape, which passes today's zod schema, or `undefined` when the body
 * is neither (the fold skips it). Today's encoding is tried first, so a 1.x
 * row reads exactly as before. Never throws.
 */
export const commentsAddedOf = (
  body: unknown,
): CommentsAddedPayload | undefined => {
  const payload =
    parsed(commentsAddedEvent.payload, body) ??
    parsed(
      commentsAddedEvent.payload,
      flatAnchor(messageJsonOf(CommentsAddedSchema, body)),
    );

  if (payload === undefined) return undefined;

  const { commentId, target, text, author, createdAt, inReplyTo } = payload;

  return definedFields({
    commentId,
    target,
    text,
    author,
    createdAt,
    inReplyTo,
  });
};

/**
 * As {@link commentsAddedOf}, for `comments.resolved/v1`; a message-JSON body
 * without `resolved` reads `resolved: false` (a reopen).
 */
export const commentsResolvedOf = (
  body: unknown,
): CommentsResolvedPayload | undefined => {
  const payload =
    parsed(commentsResolvedEvent.payload, body) ??
    parsed(
      commentsResolvedEvent.payload,
      messageJsonOf(CommentsResolvedSchema, body),
    );

  if (payload === undefined) return undefined;

  return { commentId: payload.commentId, resolved: payload.resolved };
};

/** A record without the keys whose value is `undefined`: absent means absent. */
const definedFields = <T extends object>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;

/** `value` as `schema` reads it, or `undefined` when it does not. */
const parsed = <T>(schema: z.ZodType<T>, value: unknown): T | undefined => {
  const result = schema.safeParse(value);

  return result.success ? result.data : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `body` read as the message's JSON and written back with every implicit
 * field, so a field left out at its default reads its default; keys the
 * message does not declare are dropped. `undefined` when it is not one.
 */
const messageJsonOf = (desc: DescMessage, body: unknown): unknown => {
  if (!isRecord(body)) return undefined;

  try {
    return toJson(
      desc,
      fromJson(desc, body as JsonValue, { ignoreUnknownFields: true }),
      { alwaysEmitImplicit: true },
    );
  } catch {
    return undefined;
  }
};

/**
 * A message-JSON body whose `target.anchor` is nested by its oneof case
 * (`{<form>: {…}}`) with that anchor flat, keyed by `form`; the body
 * unchanged when it has no such anchor.
 */
const flatAnchor = (body: unknown): unknown => {
  if (!isRecord(body) || !isRecord(body.target)) return body;

  const { anchor } = body.target;

  if (!isRecord(anchor)) return body;

  const cases = Object.entries(anchor);
  const [only] = cases;

  if (cases.length !== 1 || only === undefined || !isRecord(only[1])) {
    return body;
  }

  return {
    ...body,
    target: { ...body.target, anchor: { form: only[0], ...only[1] } },
  };
};
