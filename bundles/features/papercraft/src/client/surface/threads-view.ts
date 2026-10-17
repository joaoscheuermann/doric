// `threads-view.ts` — what the canvas draws of a preview's threads: the pins,
// the count the comment control shows, the next pin's number, and the thread a
// pin opens (its messages, its title and its whole anchor).
//
// The durable threads come from the log (`domain/preview-state.ts`), the drafts
// from the composer stack, both on every revision of the preview: a thread
// written on one revision carries over to the next, keeps its number, and its
// pin re-places itself through its anchor on the revision on screen. A draft
// root is a pin of its own until the send flushes it, when its durable comment
// — written under the draft's own id — takes its place; a draft reply joins
// the thread of the root it answers, sent or drafted. Pure: no DOM, no
// service.

import {
  ARTIFACT_TARGET_KIND,
  type CommentAnchor,
  type CommentTarget,
} from '../../contracts/index.js';
import type { PreviewDraft } from '../comment.js';
import type { PreviewThread } from '../domain/preview-state.js';
import type { ContentPoint } from './pin-geometry.js';
import type { CommentPin } from './pins-layer.js';
import type { ThreadMessage } from './thread-popover.js';

/** The drafts that start a thread: no root to answer, and not sent yet. */
export const draftRootsOf = (
  threads: readonly PreviewThread[],
  drafts: readonly PreviewDraft[],
): readonly PreviewDraft[] => {
  const sent = new Set(threads.map((thread) => thread.root.commentId));

  return drafts.filter(
    (draft) => draft.inReplyTo === undefined && !sent.has(draft.id),
  );
};

/** What the comment control counts: the threads still open, and the draft pins. */
export const openCountOf = (
  threads: readonly PreviewThread[],
  drafts: readonly PreviewDraft[],
): number =>
  threads.filter((thread) => thread.state !== 'done').length +
  draftRootsOf(threads, drafts).length;

/** The next pin's number: never one the preview already shows. */
export const nextPinOf = (
  threads: readonly PreviewThread[],
  drafts: readonly PreviewDraft[],
): number =>
  Math.max(
    threads.length,
    ...draftRootsOf(threads, drafts).map((draft) => draft.pin ?? 0),
    0,
  ) + 1;

/** The pin a draft root wears: its own number, else the next after the sent ones. */
const draftPinOf = (
  draft: PreviewDraft,
  index: number,
  threads: readonly PreviewThread[],
): number => draft.pin ?? threads.length + index + 1;

/** The room between two detached pins, in surface pixels. */
export const DETACHED_STEP = 28;

/**
 * Every pin of the preview: the sent threads (the resolved ones only while
 * they are shown), then the draft roots. `pointOf` places an anchor on the
 * rendered revision — its element, else the point the anchor recorded, else
 * the draft's own point. A pin it still cannot place (its element is gone
 * from this revision and its anchor recorded no point) is never dropped: it
 * is `detached`, stacked down the content's left edge, `step` content units
 * apart, so its thread stays counted and reachable.
 */
export const pinsOf = (
  threads: readonly PreviewThread[],
  drafts: readonly PreviewDraft[],
  showResolved: boolean,
  pointOf: (
    anchor: CommentAnchor,
    fallback?: ContentPoint,
  ) => ContentPoint | undefined,
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
export interface ThreadView {
  readonly rootId: string;
  readonly pin: number;
  /**
   * The root's target, with the revision the root was written on: what a
   * reply to it is written against, on whatever revision is on screen.
   */
  readonly target: CommentTarget;
  /** Where its pin was placed, for a draft root that never resolved to an element. */
  readonly point?: ContentPoint;
  readonly messages: readonly ThreadMessage[];
  /** The sent thread, when the root is sent. */
  readonly sent?: PreviewThread;
}

const draftMessage = (draft: PreviewDraft): ThreadMessage => ({
  id: draft.id,
  ...(draft.author === undefined ? {} : { author: draft.author }),
  text: draft.note,
  draft: true,
});

/**
 * The thread a pin opens: the sent root and its replies, then the drafts that
 * answer it; or, while the root is still a draft, the draft and its draft
 * replies. `undefined` once the root is gone (a removed draft).
 */
export const threadViewOf = (
  rootId: string,
  threads: readonly PreviewThread[],
  drafts: readonly PreviewDraft[],
  target: { readonly artifactId: string; readonly revision?: number },
): ThreadView | undefined => {
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
      target: {
        kind: ARTIFACT_TARGET_KIND,
        id: target.artifactId,
        ...(revision === undefined ? {} : { revision }),
        anchor,
      },
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

/** The component a file names: `src/Checkout.tsx` → `Checkout`. */
const componentOf = (path: string | undefined): string | undefined => {
  if (path === undefined || path === '') return undefined;

  const file = path.split('/').pop() ?? path;
  const dot = file.indexOf('.');

  return dot <= 0 ? file : file.slice(0, dot);
};

/**
 * Where a thread points, short, for the popover's title: `Checkout:42` for a
 * stamped element, `Checkout (412, 180)` for a point — the component read off
 * the anchor's file, else the preview's source.
 */
export const anchorTitleOf = (
  anchor: CommentAnchor,
  source: string | undefined,
): string => {
  const component =
    componentOf(anchor.path) ?? componentOf(source) ?? anchor.label ?? '';

  if (anchor.form === 'point')
    return `${component} (${String(Math.round(anchor.x ?? 0))}, ${String(
      Math.round(anchor.y ?? 0),
    )})`.trim();

  if (anchor.line !== undefined) return `${component}:${String(anchor.line)}`;

  return component === '' ? (anchor.selector ?? anchor.text ?? '') : component;
};

/**
 * The whole anchor, for the title's tooltip and the copy:
 * `path:line · element · rev N`, or `espaço em (x, y) · perto de element · rev N`.
 */
export const anchorTextOf = (
  anchor: CommentAnchor,
  revision: number | undefined,
): string => {
  const element = anchor.selector ?? anchor.label;
  const rev = revision === undefined ? [] : [`rev ${String(revision)}`];

  if (anchor.form === 'point') {
    return [
      `espaço em (${String(Math.round(anchor.x ?? 0))}, ${String(
        Math.round(anchor.y ?? 0),
      )})`,
      ...(element === undefined ? [] : [`perto de ${element}`]),
      ...rev,
    ].join(' · ');
  }

  const where =
    anchor.path === undefined
      ? undefined
      : anchor.line === undefined
        ? anchor.path
        : `${anchor.path}:${String(anchor.line)}`;

  return [
    ...(where === undefined ? [] : [where]),
    ...(element === undefined ? [] : [element]),
    ...(anchor.form === 'range' && anchor.text !== undefined
      ? [`“${anchor.text}”`]
      : []),
    ...rev,
  ].join(' · ');
};
