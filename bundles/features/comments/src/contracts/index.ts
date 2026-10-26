// Public contract of the `comments` bundle: one anchored annotation on any
// target the app can address — an artifact revision, a message, a file and a
// line, an element of a preview.
//
// The registry never interprets a target: it stores the reference, validates it
// against the schema and forwards it. The bundle that owns the `kind` is the one
// that knows what `revision` and `anchor` mean for it ([comentários] in
// `docs/architecture/bundles/comments.md`). The durable record is the event log:
// `comments.added/v1` when the comment is written (on the send flush, never
// while it is a draft) and `comments.resolved/v1` when it is attended to.

import {
  type CallArg,
  defineEvent,
  type MethodSpecs,
  ref,
} from 'bundle/contracts';
import { z } from 'zod';

/**
 * Where in the target the comment sits. Four forms, from the strongest to the
 * loosest: the stamped source of a built preview, a selector of the target's
 * derived structure, a free position with the nearest element named, and a
 * range of the target's text.
 *
 * Each form requires the fields that make it point somewhere: `source` a
 * `path` (its `line` is optional, a positive integer when given), `selector` a
 * `selector`, `point` both `x` and `y`, and `range` the selected `text`. The
 * other fields stay optional on every form — a stamped element also carries its
 * selector and label — and the schema below refuses an anchor that lacks its
 * form's own fields.
 */
export interface CommentAnchor {
  readonly form: 'source' | 'selector' | 'point' | 'range';
  /** The file and line of a `source` anchor, workspace-relative. */
  readonly path?: string;
  readonly line?: number;
  /** A selector of the target's derived structure. */
  readonly selector?: string;
  /** A position, for a click on empty space, and the nearest element's name. */
  readonly x?: number;
  readonly y?: number;
  readonly label?: string;
  /** The selected text of a `range` anchor. */
  readonly text?: string;
  /**
   * The `::before` / `::after` pseudo-element of the anchored element that the
   * comment is on, for a kind whose target draws them (a Papercraft preview).
   * The owner of `kind` writes and reads it; the registry stores it and never
   * interprets it. An anchor without it points at the element itself.
   */
  readonly pseudo?: '::before' | '::after';
  /**
   * Where in the target the range sits, for a kind that draws its target as
   * turns of blocks: the turn's own key and the 0-based index of the block the
   * selection starts in. The owner of `kind` writes and reads them; the
   * registry stores them and never interprets them, and an anchor without them
   * keeps the placement it has today.
   */
  readonly turn?: string;
  readonly block?: number;
  /**
   * How far into that block the selected text starts, counted in characters
   * that are not whitespace, so a reader of the anchor finds the occurrence
   * selected among repeated words. Optional, and valid only with `turn` and
   * `block`.
   */
  readonly at?: number;
  /**
   * The item of that block the selected text starts in, when the block is a
   * list, so a reader of the anchor reveals the item rather than the whole
   * list. Optional, and valid only with `turn` and `block`.
   */
  readonly item?: number;
}

/** What a comment is about; the registry never looks inside it. */
export interface CommentTarget {
  /** The kind of target, declared by the bundle that owns it. */
  readonly kind: string;
  /** The identity of the target within its kind. */
  readonly id: string;
  /** The revision of the target, when it has revisions. */
  readonly revision?: number;
  readonly anchor: CommentAnchor;
}

export interface Comment {
  readonly commentId: string;
  readonly target: CommentTarget;
  readonly text: string;
  readonly author?: string;
  readonly resolved: boolean;
  readonly createdAt: string;
  /**
   * The root comment this one answers. Threads are flat: a reply always names
   * the root, never another reply. Absent on a root comment.
   */
  readonly inReplyTo?: string;
}

export interface CommentAddInput {
  readonly target: CommentTarget;
  readonly text: string;
  readonly author?: string;
  /**
   * The id the comment is written under, chosen by the caller so it exists
   * before the flush (the prompt carries it). Matches `COMMENT_ID_PATTERN`.
   * Without it the registry generates `comment-<uuid>`. Idempotent: a comment
   * of the Thread's log with this id is returned as it is and nothing is
   * appended, so a retried flush never duplicates.
   */
  readonly commentId?: string;
  /**
   * The comment of the same Thread this one answers. A reply's id is
   * normalized to its root, so `inReplyTo` always names a root; an unknown id
   * is `invalid_input`. The reply keeps the `target` the caller passes.
   */
  readonly inReplyTo?: string;
}

/**
 * The identity of a target, as `list` filters by it: the anchor is where in
 * the target a comment sits, not which target it names, so a reader that
 * counts or lists a target's comments names the target without one.
 */
export interface CommentTargetKey {
  readonly kind: string;
  readonly id: string;
  readonly revision?: number;
}

export interface CommentListInput {
  /** Only the comments of this target, when given; the anchor is not part of it. */
  readonly target?: CommentTargetKey;
  /** Only the comments of this kind, when given. */
  readonly kind?: string;
}

export interface CommentResolveInput {
  readonly commentId: string;
  readonly resolved: boolean;
}

/**
 * `comments/v1` (host), cardinality `one`. A comment is immutable: editing one
 * is a new event, not a rewrite of the stored row.
 *
 * The Thread event log is the only record: `list` and `resolve` fold the
 * `comments.added/v1` and `comments.resolved/v1` rows of the call's scope, so
 * a restarted host, a replay or a rewind answers what the log holds. Every
 * call is scoped: `add` and `resolve` need the Project, the Thread and the
 * prompt the event is written under (`invalid_scope` otherwise), and `list`
 * needs at least the Project.
 */
export interface Comments {
  /** Writes `comments.added/v1` in the call's Thread and returns the comment. */
  add(input: CommentAddInput, call?: CallArg): Promise<Comment>;
  /**
   * The comments of a target (or of a `kind`), in the order of the log: the
   * call's Thread when the scope names one, else every Thread of its Project.
   */
  list(input: CommentListInput, call?: CallArg): Promise<readonly Comment[]>;
  /**
   * Marks one comment of the call's Thread attended, writing
   * `comments.resolved/v1` there; a comment the Thread's log does not hold —
   * one of another Thread or Project included — answers `undefined` and writes
   * nothing.
   */
  resolve(
    input: CommentResolveInput,
    call?: CallArg,
  ): Promise<Comment | undefined>;
}

/** The ids a caller may choose for a comment. */
export const COMMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** The fields every form may carry; each form then requires its own. */
const anchorFields = {
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  selector: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  label: z.string().optional(),
  text: z.string().optional(),
  pseudo: z.enum(['::before', '::after']).optional(),
  // A seat's own shape is `add`'s to refuse: the schema runs before the call,
  // so a malformed seat is turned away there, as a rejection of the write,
  // while the fields stay declared here for every form they may ride on.
  turn: z.string().optional(),
  block: z.number().optional(),
  at: z.number().optional(),
  item: z.number().optional(),
};

export const commentAnchorSchema: z.ZodType<CommentAnchor, CommentAnchor> =
  z.discriminatedUnion('form', [
    z.looseObject({
      ...anchorFields,
      form: z.literal('source'),
      path: z.string().min(1),
    }),
    z.looseObject({
      ...anchorFields,
      form: z.literal('selector'),
      selector: z.string().min(1),
    }),
    z.looseObject({
      ...anchorFields,
      form: z.literal('point'),
      x: z.number(),
      y: z.number(),
    }),
    z.looseObject({
      ...anchorFields,
      form: z.literal('range'),
      text: z.string().min(1),
    }),
  ]);

export const commentTargetSchema: z.ZodType<CommentTarget, CommentTarget> =
  z.looseObject({
    kind: z.string(),
    id: z.string(),
    revision: z.number().int().optional(),
    anchor: commentAnchorSchema,
  });

export const commentSchema: z.ZodType<Comment, Comment> = z.looseObject({
  commentId: z.string(),
  target: commentTargetSchema,
  text: z.string(),
  author: z.string().optional(),
  resolved: z.boolean(),
  createdAt: z.string(),
  inReplyTo: z.string().optional(),
});

export const commentAddInputSchema: z.ZodType<
  CommentAddInput,
  CommentAddInput
> = z.looseObject({
  target: commentTargetSchema,
  text: z.string(),
  author: z.string().optional(),
  commentId: z.string().regex(COMMENT_ID_PATTERN).optional(),
  inReplyTo: z.string().optional(),
});

export const commentTargetKeySchema: z.ZodType<
  CommentTargetKey,
  CommentTargetKey
> = z.looseObject({
  kind: z.string(),
  id: z.string(),
  revision: z.number().int().optional(),
});

const commentListInputSchema: z.ZodType<CommentListInput, CommentListInput> =
  z.looseObject({
    target: commentTargetKeySchema.optional(),
    kind: z.string().optional(),
  });

const commentResolveInputSchema: z.ZodType<
  CommentResolveInput,
  CommentResolveInput
> = z.looseObject({
  commentId: z.string(),
  resolved: z.boolean(),
});

export const commentsMethods = {
  add: { input: commentAddInputSchema, output: commentSchema },
  list: { input: commentListInputSchema, output: z.array(commentSchema) },
  resolve: {
    input: commentResolveInputSchema,
    output: commentSchema.optional(),
  },
} as const satisfies MethodSpecs;

export const CommentsV1 = ref<Comments>('comments/v1');

// Events ----------------------------------------------------------------------

/**
 * The comment reached the log: written by the send, never by a draft. The
 * registry rebuilds `list` from these rows, so `createdAt` is the comment's
 * own time; a row written before it was carried reads the log entry's time.
 */
export const commentsAddedEvent = defineEvent({
  type: 'comments.added/v1',
  payload: z.looseObject({
    commentId: z.string(),
    target: commentTargetSchema,
    text: z.string(),
    author: z.string().optional(),
    createdAt: z.string().optional(),
    /** The root comment this one answers; absent on a root comment. */
    inReplyTo: z.string().optional(),
  }),
});

/** The comment was attended to (or reopened). */
export const commentsResolvedEvent = defineEvent({
  type: 'comments.resolved/v1',
  payload: z.looseObject({
    commentId: z.string(),
    resolved: z.boolean(),
  }),
});
