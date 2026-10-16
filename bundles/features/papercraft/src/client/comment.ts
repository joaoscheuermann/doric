// The comment seam (spec: "Comentários acima do prompt, rascunho no host").
//
// A commented click — on an element or on empty space — adds an **item to the
// composer stack** of `chat.composer/v1`: one card per comment, the same stack
// the node's button and the window's `Comentar` control feed. Nothing enters
// the durable log while it is a draft: the stack is host state, and it is the
// **send** that calls the flush registered for the `papercraft-preview` kind,
// which answers the `comments/v1.add` writes the sender then performs. The
// comment is a composer of prompt with spatial context: it leaves with the
// prompt.
//
// The flush lives in the main process (`src/desktop/comment-flush.ts`), the one
// place the real `chat.composer/v1.registerFlush` serves — it carries a
// function, so a window never reaches it. This client module only adds items to
// the stack.
//
// While the `chat` bundle's contract is not active, the gesture stays
// functional through the fallback the feature shipped first: the anchored
// intent event (the seam the stack subscribes to) plus a direct `comments/v1`
// write. Both paths live here; the element picks the stack whenever a composer
// answers.

import type { Services } from 'bundle/contracts';

import {
  type CommentAnchor,
  CommentsV1,
  type CommentTarget,
  PAPERCRAFT_COMMENT_CARD_TAG,
  PAPERCRAFT_COMMENT_KIND,
} from '../contracts/index.js';
import { targetOf } from './anchor.js';
import type { ChatComposer } from './chat-contract.js';

/** The intent a preview's comment gesture emits; the composer stack's seam. */
export const COMMENT_INTENT_EVENT = 'papercraft:comment';

export interface CommentIntentDetail {
  readonly target: CommentTarget;
  readonly anchor: CommentAnchor;
}

/** Dispatches the anchored comment as an intent the composer stack can take. */
export const dispatchCommentIntent = (
  from: EventTarget,
  detail: CommentIntentDetail,
): void => {
  from.dispatchEvent(
    new CustomEvent<CommentIntentDetail>(COMMENT_INTENT_EVENT, {
      detail,
      bubbles: true,
      composed: true,
    }),
  );
};

/* The composer, whenever chat provides it ----------------------------------- */

const state: { composer?: ChatComposer } = {};

/**
 * Binds the live `chat.composer/v1`. Called from the `whenAvailable`
 * registration in the client's activation, exactly as `threads` binds its
 * contracts; when chat is absent the gesture uses the fallback below.
 */
export const setComposer = (composer: ChatComposer | undefined): void => {
  state.composer = composer;
};

/** The bound composer, when chat's contract is active. */
export const composer = (): ChatComposer | undefined => state.composer;

/**
 * The Thread whose stack a comment joins. The node and the window both live
 * under a conversation route (`/projects/:projectId/threads/:threadId`), so
 * the path names the Thread; a papercraft window opened outside a
 * conversation has no stack to join and the gesture falls back.
 */
export const threadIdOfLocation = (): string | undefined => {
  const match =
    typeof location === 'undefined'
      ? undefined
      : /\/threads\/([^/?#]+)/.exec(location.pathname);

  return match === null || match === undefined ? undefined : match[1];
};

/* The draft the gesture produces -------------------------------------------- */

/** The data one stack item of this kind carries. */
export interface PendingCommentData {
  readonly artifactId: string;
  readonly revision: number;
  readonly anchor: CommentAnchor;
  /** The pin's number: `1`, `2`, … per artifact and revision. */
  readonly pin: number;
  /** Where the pin sits, in content coordinates. */
  readonly point: { readonly x: number; readonly y: number };
}

/** One draft ready to become a stack item. */
export interface PendingComment {
  readonly id: string;
  readonly data: PendingCommentData;
  readonly note: string;
}

export const commentStackItemId = (
  artifactId: string,
  revision: number,
  pin: number,
): string => `papercraft.comment:${artifactId}@${revision}#${pin}`;

export type CommentOutcome =
  | { readonly kind: 'stack'; readonly itemId: string }
  | { readonly kind: 'recorded' };

/**
 * What one commented click becomes. With a composer bound and a Thread at
 * hand, the draft joins the stack — nothing durable yet, and the note is
 * written there. Otherwise the gesture records through `comments/v1`
 * directly, after the intent event: the comment is commentable today.
 *
 * The intent bubbles from `origin` — the canvas the reader clicked — so the
 * seam crosses the shadow roots it must, never a bare runtime global.
 */
export const beginComment = async (
  services: Services,
  pending: PendingComment,
  origin: EventTarget,
): Promise<CommentOutcome> => {
  const api = composer();
  const threadId = threadIdOfLocation();

  if (api !== undefined && threadId !== undefined) {
    await api.addItem({
      threadId,
      kind: PAPERCRAFT_COMMENT_KIND,
      elementTag: PAPERCRAFT_COMMENT_CARD_TAG,
      data: pending.data,
      note: pending.note,
    });

    return { kind: 'stack', itemId: pending.id };
  }

  const target = targetOf(
    pending.data.artifactId,
    pending.data.revision,
    pending.data.anchor,
  );

  dispatchCommentIntent(origin, {
    target,
    anchor: pending.data.anchor,
  });
  await addComment(services, target, pending.note);

  return { kind: 'recorded' };
};

/** Writes the comment durably through `comments/v1`. */
export const addComment = async (
  services: Services,
  target: CommentTarget,
  text: string,
  author?: string,
): Promise<void> => {
  await services
    .use(CommentsV1)
    .add({ target, text, ...(author === undefined ? {} : { author }) });
};
