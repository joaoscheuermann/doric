// The artifacts client's structural copy of the `comments` bundle's
// `comments/v1`, as `papercraft` keeps it: this bundle's frame counts what is
// still pending on an artifact revision, so it reads the comments of the
// target, but the comments bundle is built separately and this one must not
// import it at compile time.

import { type CallArg, ref } from 'bundle/contracts';

/** The identity of a target, as `comments/v1.list` filters by it. */
export interface CommentTargetKey {
  readonly kind: string;
  readonly id: string;
  readonly revision?: number;
}

/** One comment as the registry answers it. */
export interface Comment {
  readonly commentId: string;
  readonly text: string;
  readonly resolved: boolean;
  readonly createdAt: string;
}

export interface Comments {
  /** The comments of one target (or of one kind), in the order of the log. */
  list(
    input: {
      readonly target?: CommentTargetKey;
      readonly kind?: string;
    },
    call?: CallArg,
  ): Promise<readonly Comment[]>;
}

export const CommentsV1 = ref<Comments>('comments/v1');
