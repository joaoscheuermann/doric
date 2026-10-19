// The comment seam (spec: "Comentários acima do prompt, rascunho no host").
//
// A comment is written in the canvas, in the inline input at its pin, and a
// **confirmed** note — on an element or on empty space — adds an **item to the
// composer stack** of `chat.composer/v1`: one line per comment — chat's own
// line, which edits it in place — edited or removed from the canvas or from
// the stack alike. A reply written in a pin's thread is an item too, naming
// the root it answers (`inReplyTo`). Nothing enters
// the durable log while it is a draft: the stack is host state, and it is the
// **send** that calls the flush registered for the `papercraft-preview` kind,
// which answers the `comments/v1.add` writes the sender then performs. The
// comment is a composer of prompt with spatial context: it leaves with the
// prompt — and a comment that is never sent never becomes an event, so there
// is no other path to the log.
//
// The flush lives in the main process (`src/desktop/comment-flush.ts`), the one
// place the real `chat.composer/v1.registerFlush` serves — it carries a
// function, so a window never reaches it. This client module only writes the
// stack's items, and sends the stack now through chat's own send
// (`chat.send/v1`) when the reader asks (the canvas window's
// `Cmd/Ctrl+Enter`, or its send button).
//
// The composer is chat's, consulted with `services.whenAvailable` like
// `ChatViewsV1`: while it is not active the gesture is unavailable, and a frame
// that rendered before chat activated learns of it through `subscribeComposer`.
// Every composer call carries the preview's `(projectId, threadId)` scope — the
// pair the composer keys a Thread's draft by — so a card lands in the stack the
// conversation's own composer shows.

import type { Services } from 'bundle/contracts';

import {
  CHAT_COMMENT_LINE_TAG,
  type ChatComposer,
  ChatComposerV1,
  ChatSendV1,
  type ComposerItem,
} from '../contracts/chat.js';
import {
  CommentsV1,
  type CommentTarget,
  callScopeOf,
  PAPERCRAFT_COMMENT_KIND,
  type PreviewItemData,
  type PreviewScope,
  previewItemTargetOf,
} from '../contracts/index.js';

/* Whether chat's composer is active, as a subscribable reading -------------- */

const state: { available: boolean } = { available: false };
const listeners = new Set<() => void>();

/**
 * Records whether `chat.composer/v1` is active. Called from the
 * `whenAvailable` registration in the client's activation, exactly as
 * `threads` binds its contracts; every subscribed frame re-reads it.
 */
export const setComposerAvailable = (available: boolean): void => {
  state.available = available;
  for (const listener of [...listeners]) listener();
};

/** Whether chat's composer is active right now. */
export const composerAvailable = (): boolean => state.available;

/** Subscribes to changes of `composerAvailable`; the release ends it. */
export const subscribeComposer = (listener: () => void): (() => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

/**
 * The composer bound to a preview's scope, when chat's composer is active and
 * the preview names its Thread; otherwise there is no stack to join.
 */
export const composerFor = (
  services: Services,
  scope: PreviewScope | undefined,
): { readonly api: ChatComposer; readonly threadId: string } | undefined => {
  if (!state.available || scope?.threadId === undefined) return undefined;

  const threadId = scope.threadId;

  return {
    api: services.use(ChatComposerV1, callScopeOf(scope)),
    threadId,
  };
};

/* The scope a frame can read off the window's location ---------------------- */

/**
 * The Project and Thread the window's location names — a conversation route
 * (`/projects/:projectId/threads/:threadId`) — when the frame was handed no
 * scope of its own.
 */
export const locationScope = (): PreviewScope | undefined => {
  if (typeof location === 'undefined') return undefined;

  const threadId = /\/threads\/([^/?#]+)/.exec(location.pathname)?.[1];
  const projectId = /\/projects\/([^/?#]+)/.exec(location.pathname)?.[1];

  if (projectId === undefined) return undefined;

  return { projectId, ...(threadId === undefined ? {} : { threadId }) };
};

/* The draft the gesture produces -------------------------------------------- */

/**
 * The data one stack item of this kind carries: the contracts'
 * `PreviewItemData` — the target, the pin, the root a reply answers and the
 * preview's title and source for chat's line to name.
 */
export type PendingCommentData = PreviewItemData;

/** One draft ready to become a stack item. */
export interface PendingComment {
  readonly data: PendingCommentData;
  readonly note: string;
}

/** One draft of the stack on a preview, read off its item. */
export interface PreviewDraft {
  /** The item's id: the comment's id once the send flushes it. */
  readonly id: string;
  readonly note: string;
  readonly author?: string;
  readonly target: CommentTarget;
  readonly pin?: number;
  /** The root (comment or draft) this reply answers; absent on a root. */
  readonly inReplyTo?: string;
  readonly point?: { readonly x: number; readonly y: number };
}

const pointOf = (
  value: unknown,
): { readonly x: number; readonly y: number } | undefined => {
  const point = value as { readonly x?: unknown; readonly y?: unknown };

  return typeof point?.x === 'number' && typeof point.y === 'number'
    ? { x: point.x, y: point.y }
    : undefined;
};

/**
 * The draft a stack item is on one preview, or `undefined` when the item is
 * another kind's or names another artifact. A draft shows on every revision of
 * its preview, as a sent comment does; its target keeps the revision it was
 * written on. A draft written before items carried their `target` still reads
 * from the fields it recorded.
 */
export const draftOfItem = (
  item: ComposerItem,
  artifactId: string,
): PreviewDraft | undefined => {
  if (item.kind !== PAPERCRAFT_COMMENT_KIND) return undefined;

  const target = previewItemTargetOf(item.data);

  if (target?.id !== artifactId) return undefined;

  const data = item.data as {
    readonly pin?: unknown;
    readonly inReplyTo?: unknown;
    readonly point?: unknown;
  };
  const point = pointOf(data.point);

  return {
    id: item.id,
    note: item.note,
    ...(item.author === undefined ? {} : { author: item.author }),
    target,
    ...(typeof data.pin === 'number' ? { pin: data.pin } : {}),
    ...(typeof data.inReplyTo === 'string' && data.inReplyTo !== ''
      ? { inReplyTo: data.inReplyTo }
      : {}),
    ...(point === undefined ? {} : { point }),
  };
};

export type CommentOutcome =
  | { readonly kind: 'stack'; readonly itemId: string }
  | { readonly kind: 'unavailable' };

/**
 * What one confirmed note becomes — a new comment, or a reply to a thread when
 * its data names the root (`inReplyTo`): with chat's composer active and a
 * Thread at hand, the draft joins that Thread's stack with its note — nothing
 * durable yet; it is sent with the next prompt. Otherwise nothing happens: there is no stack to join, and a draft has
 * no other place to live.
 */
export const beginComment = async (
  services: Services,
  scope: PreviewScope | undefined,
  pending: PendingComment,
): Promise<CommentOutcome> => {
  const composer = composerFor(services, scope);

  if (composer === undefined) return { kind: 'unavailable' };

  // Chat draws (and edits) the line itself: the item names chat's own line.
  const item = await composer.api.addItem({
    threadId: composer.threadId,
    kind: PAPERCRAFT_COMMENT_KIND,
    elementTag: CHAT_COMMENT_LINE_TAG,
    data: pending.data,
    note: pending.note,
  });

  return { kind: 'stack', itemId: item.id };
};

/** Edits the note of one draft of the stack; one draft, wherever it is edited. */
export const editComment = async (
  services: Services,
  scope: PreviewScope | undefined,
  itemId: string,
  note: string,
): Promise<void> => {
  const composer = composerFor(services, scope);

  await composer?.api.updateNote({
    threadId: composer.threadId,
    id: itemId,
    note,
  });
};

/** Removes one draft from the stack: it never reaches the log. */
export const removeComment = async (
  services: Services,
  scope: PreviewScope | undefined,
  itemId: string,
): Promise<void> => {
  const composer = composerFor(services, scope);

  await composer?.api.removeItem({ threadId: composer.threadId, id: itemId });
};

/**
 * Sends the Thread's stack now (the canvas window's `Cmd+Enter`, or its send
 * button):
 * the composer's own send, through `chat.send/v1` — the drafts become the
 * prompt and, once the host accepts it, the durable comments. Without chat's
 * send there is nothing to send with, and the drafts stay where they are.
 */
export const sendComments = async (
  services: Services,
  scope: PreviewScope | undefined,
): Promise<'accepted' | 'empty' | 'refused' | 'unavailable'> => {
  if (scope?.threadId === undefined) return 'unavailable';

  try {
    const result = await services
      .use(ChatSendV1, callScopeOf(scope))
      .send({ projectId: scope.projectId, threadId: scope.threadId });

    return result.status;
  } catch {
    return 'unavailable';
  }
};

/**
 * Resolves (or reopens) one sent root comment through `comments/v1.resolve`,
 * written under the prompt the root itself was written in — the scope the
 * registry needs, which the Thread's log names for every comment. Without a
 * Thread, without that prompt, or without the registry answering, nothing is
 * written and the answer says so.
 */
export const resolveComment = async (
  services: Services,
  scope: PreviewScope | undefined,
  input: {
    readonly commentId: string;
    readonly promptId: string | undefined;
    readonly resolved: boolean;
  },
): Promise<'done' | 'unavailable'> => {
  if (scope?.threadId === undefined || input.promptId === undefined)
    return 'unavailable';

  try {
    await services
      .use(CommentsV1, {
        projectId: scope.projectId,
        threadId: scope.threadId,
        promptId: input.promptId,
      })
      .resolve({ commentId: input.commentId, resolved: input.resolved });

    return 'done';
  } catch {
    return 'unavailable';
  }
};
