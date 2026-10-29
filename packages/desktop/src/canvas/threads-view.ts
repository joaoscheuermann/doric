// `threads-view.ts` — what a canvas draws of an artifact's threads: the pins,
// the count the comment control shows, the next pin's number, and the thread a
// pin opens (its messages and its target).
//
// The durable threads come from the log (`threads.ts`), the drafts from the
// composer stack, both on every revision of the artifact: a thread
// written on one revision carries over to the next, keeps its number, and its
// pin re-places itself through its anchor on the revision on screen. A draft
// root is a pin of its own until the send flushes it, when its durable comment
// — written under the draft's own id — takes its place; a draft reply joins
// the thread of the root it answers, sent or drafted. Pure: no DOM, no
// service.

import type { ContentPoint } from './geometry.js';
import type { CommentPin } from './pins-layer.js';
import type { ThreadMessage } from './thread-popover.js';
import type { CanvasThread } from './threads.js';

/** What a comment is written against: one revision of one target, anchored. */
export interface CanvasCommentTarget<A> {
  /** The target's kind; `artifact` for an artifact's revision. */
  readonly kind: string;
  readonly id: string;
  readonly revision?: number;
  readonly anchor: A;
}

/** One draft of the composer stack on an artifact, read off its item. */
export interface CanvasDraft<A> {
  /** The item's id: the comment's id once the send flushes it. */
  readonly id: string;
  readonly note: string;
  readonly author?: string;
  readonly target: CanvasCommentTarget<A>;
  readonly pin?: number;
  /** The root (comment or draft) this reply answers; absent on a root. */
  readonly inReplyTo?: string;
  /** Where the pin sat, in content coordinates, when it was placed. */
  readonly point?: ContentPoint;
}

/** The kind of an artifact's target. */
const ARTIFACT_TARGET_KIND = 'artifact';

/**
 * The anchored target of an artifact's revision: kind `artifact`, and the
 * revision only when one is given. Pure.
 */
export const artifactTargetOf = <A>(
  artifactId: string,
  revision: number | undefined,
  anchor: A,
): CanvasCommentTarget<A> => ({
  kind: ARTIFACT_TARGET_KIND,
  id: artifactId,
  ...(revision === undefined ? {} : { revision }),
  anchor,
});

/** The drafts that start a thread: no root to answer, and not sent yet. */
export const draftRootsOf = <A>(
  threads: readonly CanvasThread<A>[],
  drafts: readonly CanvasDraft<A>[],
): readonly CanvasDraft<A>[] => {
  const sent = new Set(threads.map((thread) => thread.root.commentId));

  return drafts.filter(
    (draft) => draft.inReplyTo === undefined && !sent.has(draft.id),
  );
};

/** What the comment control counts: the threads still open, and the draft pins. */
export const openCountOf = <A>(
  threads: readonly CanvasThread<A>[],
  drafts: readonly CanvasDraft<A>[],
): number =>
  threads.filter((thread) => thread.state !== 'done').length +
  draftRootsOf(threads, drafts).length;

/** The next pin's number: never one the artifact already shows. */
export const nextPinOf = <A>(
  threads: readonly CanvasThread<A>[],
  drafts: readonly CanvasDraft<A>[],
): number =>
  Math.max(
    threads.length,
    ...draftRootsOf(threads, drafts).map((draft) => draft.pin ?? 0),
    0,
  ) + 1;

/** The pin a draft root wears: its own number, else the next after the sent ones. */
const draftPinOf = <A>(
  draft: CanvasDraft<A>,
  index: number,
  threads: readonly CanvasThread<A>[],
): number => draft.pin ?? threads.length + index + 1;

/** The room between two detached pins, in surface pixels. */
export const DETACHED_STEP = 28;

/**
 * Every pin of the artifact: the sent threads (the resolved ones only while
 * `showResolved`; a root without an anchor never), then the draft roots.
 * `pointOf` places an anchor on the revision on screen — a draft's own point
 * is the fallback. A pin it still cannot place is never dropped: it is
 * `detached`, stacked down the content's left edge `step` content units apart,
 * so its thread stays counted and reachable. Pure.
 */
export const pinsOf = <A>(
  threads: readonly CanvasThread<A>[],
  drafts: readonly CanvasDraft<A>[],
  showResolved: boolean,
  pointOf: (anchor: A, fallback?: ContentPoint) => ContentPoint | undefined,
  step: number = DETACHED_STEP,
): readonly CommentPin[] => {
  const pins: CommentPin[] = [];
  let detached = 0;
  const place = (point: ContentPoint | undefined) => {
    if (point !== undefined) return { point };

    detached += 1;

    return { point: { x: 0, y: detached * step }, detached: true };
  };

  for (const thread of threads) {
    if (thread.state === 'done' && !showResolved) continue;

    const anchor = thread.root.anchor;

    // A root without an anchor has nowhere to point and no thread to open.
    if (anchor === undefined) continue;

    pins.push({
      key: thread.root.commentId,
      pin: thread.pin,
      ...place(pointOf(anchor)),
      state: thread.state,
      replies: thread.replies.length,
      note: thread.root.text,
    });
  }

  draftRootsOf(threads, drafts).forEach((draft, index) => {
    pins.push({
      key: draft.id,
      pin: draftPinOf(draft, index, threads),
      ...place(pointOf(draft.target.anchor, draft.point) ?? draft.point),
      state: 'draft',
      replies: drafts.filter((reply) => reply.inReplyTo === draft.id).length,
      note: draft.note,
    });
  });

  return pins;
};

/** One thread as the popover shows it. */
export interface ThreadView<A> {
  readonly rootId: string;
  readonly pin: number;
  /**
   * The root's target, with the revision the root was written on: what a
   * reply to it is written against, on whatever revision is on screen.
   */
  readonly target: CanvasCommentTarget<A>;
  /** Where its pin was placed, for a draft root that never resolved to an element. */
  readonly point?: ContentPoint;
  readonly messages: readonly ThreadMessage[];
  /** The sent thread, when the root is sent. */
  readonly sent?: CanvasThread<A>;
}

const draftMessage = <A>(draft: CanvasDraft<A>): ThreadMessage => ({
  id: draft.id,
  ...(draft.author === undefined ? {} : { author: draft.author }),
  text: draft.note,
  draft: true,
});

/**
 * The thread a pin opens: the sent root and its replies, then the drafts that
 * answer it; or, while the root is still a draft, the draft and its draft
 * replies. A sent root's target is `artifactTargetOf(target.artifactId, the
 * root's revision ?? target.revision, its anchor)`. `undefined` once the root
 * is gone (a removed draft) or a sent root has no anchor.
 */
export const threadViewOf = <A>(
  rootId: string,
  threads: readonly CanvasThread<A>[],
  drafts: readonly CanvasDraft<A>[],
  target: { readonly artifactId: string; readonly revision?: number },
): ThreadView<A> | undefined => {
  const replies = drafts
    .filter((draft) => draft.inReplyTo === rootId)
    .map(draftMessage);
  const sent = threads.find((thread) => thread.root.commentId === rootId);

  if (sent !== undefined) {
    const anchor = sent.root.anchor;

    if (anchor === undefined) return undefined;

    const revision = sent.root.revision ?? target.revision;

    return {
      rootId,
      pin: sent.pin,
      target: artifactTargetOf(target.artifactId, revision, anchor),
      messages: [
        ...[sent.root, ...sent.replies].map((comment) => ({
          id: comment.commentId,
          ...(comment.author === undefined ? {} : { author: comment.author }),
          text: comment.text,
          ...(comment.createdAt === undefined
            ? {}
            : { createdAt: comment.createdAt }),
          draft: false,
        })),
        ...replies,
      ],
      sent,
    };
  }

  const roots = draftRootsOf(threads, drafts);
  const index = roots.findIndex((draft) => draft.id === rootId);
  const root = roots[index];

  if (root === undefined) return undefined;

  return {
    rootId,
    pin: draftPinOf(root, index, threads),
    target: root.target,
    ...(root.point === undefined ? {} : { point: root.point }),
    messages: [draftMessage(root), ...replies],
  };
};
