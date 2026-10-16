// Finding a comment's thread in the conversation's DOM: the latest reply the
// agent wrote in it, the latest block that draws its target, and the event
// that asks the bundle owning the target to open the thread there
// (`COMMENT_THREAD_OPEN_EVENT`, with no revision: the latest).

import {
  COMMENT_THREAD_OPEN_EVENT,
  type CommentThreadOpenDetail,
} from '../../contracts/index.js';
import { targetKey } from '../domain/composer-stack.js';

/** The attribute a reply row of a reply block carries: its thread's root id. */
export const REPLY_ROOT_ATTRIBUTE = 'data-reply-root';

/** The attribute an external block's element carries: the block's id. */
export const CHAT_BLOCK_ID_ATTRIBUTE = 'data-chat-block-id';

/** The attribute a flashed element wears while it flashes. */
const FLASH_ATTRIBUTE = 'data-comment-flash';
const FLASH_MS = 1200;

/** The conversation an element stands in, else its document. */
const scopeOf = (from: Element): ParentNode =>
  from.closest('[data-lexical-editor]') ?? from.ownerDocument;

/** Scrolls one block into the middle of the view and flashes it. */
const reveal = (element: HTMLElement): void => {
  const view = element.ownerDocument.defaultView;
  const reduced =
    view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  element.scrollIntoView?.({
    block: 'center',
    behavior: reduced ? 'auto' : 'smooth',
  });
  element.setAttribute(FLASH_ATTRIBUTE, '');
  view?.setTimeout(() => element.removeAttribute(FLASH_ATTRIBUTE), FLASH_MS);
};

/** The elements under `scope` that carry `attribute`, in DOM order. */
const withAttribute = (scope: ParentNode, attribute: string): HTMLElement[] => [
  ...scope.querySelectorAll<HTMLElement>(`[${attribute}]`),
];

/**
 * Scrolls to the latest reply the agent wrote in a thread and flashes it;
 * `false` when the conversation draws none.
 */
export const revealLatestReply = (from: Element, rootId: string): boolean => {
  const replies = withAttribute(scopeOf(from), REPLY_ROOT_ATTRIBUTE).filter(
    (element) => element.getAttribute(REPLY_ROOT_ATTRIBUTE) === rootId,
  );
  const latest = replies.at(-1);
  if (latest === undefined) return false;
  reveal(latest);
  return true;
};

/**
 * Scrolls to the conversation block that draws a comment's target and flashes
 * it: the frame whose block id names the target's id — at its revision when
 * one does, else the latest. `false` when no block draws it.
 */
export const revealTarget = (from: Element, target: unknown): boolean => {
  const key = targetKey(target);
  if (key === undefined) return false;
  const named = withAttribute(scopeOf(from), CHAT_BLOCK_ID_ATTRIBUTE).filter(
    (element) => {
      const id = element.getAttribute(CHAT_BLOCK_ID_ATTRIBUTE) ?? '';
      return id.includes(`:${key.id}@`) || id.endsWith(`:${key.id}`);
    },
  );
  const exact =
    key.revision === undefined
      ? undefined
      : named.find((element) =>
          element
            .getAttribute(CHAT_BLOCK_ID_ATTRIBUTE)
            ?.endsWith(`:${key.id}@${key.revision}`),
        );
  const block = exact ?? named.at(-1);
  if (block === undefined) return false;
  reveal(block);
  return true;
};

/**
 * The target with its revision left out: the same target and anchor, which
 * `COMMENT_THREAD_OPEN_EVENT` and `revealTarget` read as its latest revision.
 * A target that is not an object stays as it is.
 */
export const latestTarget = (target: unknown): unknown => {
  if (typeof target !== 'object' || target === null) return target;
  const { revision: _revision, ...rest } = target as Record<string, unknown>;
  return rest;
};

/**
 * Asks for one comment's thread to be opened on the latest drawing of its
 * target: shows the conversation's latest block of that target, and
 * dispatches `COMMENT_THREAD_OPEN_EVENT` from `from`, bubbling and composed,
 * with the target's revision left out, for the bundle that owns the target to
 * open the thread there.
 */
export const openCommentThread = (
  from: Element,
  detail: CommentThreadOpenDetail,
): void => {
  const latest: CommentThreadOpenDetail = {
    commentId: detail.commentId,
    target: latestTarget(detail.target),
  };
  revealTarget(from, latest.target);
  from.dispatchEvent(
    new CustomEvent<CommentThreadOpenDetail>(COMMENT_THREAD_OPEN_EVENT, {
      bubbles: true,
      composed: true,
      detail: latest,
    }),
  );
};
