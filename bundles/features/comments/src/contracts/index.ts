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
}

export interface CommentAddInput {
  readonly target: CommentTarget;
  readonly text: string;
  readonly author?: string;
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
 */
export interface Comments {
  /** Writes `comments.added/v1` and returns the comment's identity. */
  add(input: CommentAddInput, call?: CallArg): Promise<Comment>;
  /** The comments of a target (or of a `kind`), in the order of the log. */
  list(input: CommentListInput, call?: CallArg): Promise<readonly Comment[]>;
  /** Marks one comment attended, writing `comments.resolved/v1`. */
  resolve(
    input: CommentResolveInput,
    call?: CallArg,
  ): Promise<Comment | undefined>;
}

export const commentAnchorSchema: z.ZodType<CommentAnchor, CommentAnchor> =
  z.looseObject({
    form: z.enum(['source', 'selector', 'point', 'range']),
    path: z.string().optional(),
    line: z.number().int().optional(),
    selector: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    label: z.string().optional(),
    text: z.string().optional(),
  });

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
});

export const commentAddInputSchema: z.ZodType<
  CommentAddInput,
  CommentAddInput
> = z.looseObject({
  target: commentTargetSchema,
  text: z.string(),
  author: z.string().optional(),
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

/** The comment reached the log: written by the send, never by a draft. */
export const commentsAddedEvent = defineEvent({
  type: 'comments.added/v1',
  payload: z.looseObject({
    commentId: z.string(),
    target: commentTargetSchema,
    text: z.string(),
    author: z.string().optional(),
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
