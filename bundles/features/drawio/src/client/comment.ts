// The comment seam of the `drawio-diagram` kind (spec "Tipo de comentário e
// flush"), in the mould of Papercraft's `comment.ts`: a confirmed note on a
// cell or on a free point of the page becomes one item of chat's composer
// stack (`chat.composer/v1`), drawn by chat's own line; nothing is durable
// until the send runs the flush the desktop part registered
// (`src/desktop/comment-flush.ts`), which answers the `comments/v1.add`
// writes. Every composer call carries the diagram's `(projectId, threadId)`.

import type { Services } from 'bundle/contracts';
import type {
  CanvasCommentData,
  CanvasDraft,
  CommentStore,
} from 'desktop/ui/canvas';

import {
  CHAT_COMMENT_LINE_TAG,
  type ChatComposer,
  ChatComposerV1,
  ChatSendV1,
  type ComposerItem,
  PROMPT_SEND_EVENT,
} from '../contracts/chat.js';
import {
  CommentsV1,
  callScopeOf,
  type DiagramAnchor,
  type DiagramScope,
  DRAWIO_COMMENT_KIND,
  diagramItemTargetOf,
} from '../contracts/index.js';
import { diagramAnchorOf } from './anchor.js';

/* Whether chat's composer is active, as a subscribable reading -------------- */

const state: { available: boolean } = { available: false };
const listeners = new Set<() => void>();

/**
 * Records whether `chat.composer/v1` is active; called by the
 * `whenAvailable` registration of `activate` (true on bind, false on its
 * release). Calls every subscribed listener synchronously, once, even when
 * the value did not change. Never throws.
 */
export const setComposerAvailable: (available: boolean) => void = (
  available,
) => {
  state.available = available;
  for (const listener of [...listeners]) listener();
};

/** Whether chat's composer is active right now; false until the first `setComposerAvailable(true)`. */
export const composerAvailable: () => boolean = () => state.available;

/**
 * Subscribes to `setComposerAvailable` calls. The returned release removes
 * the listener; releasing twice is harmless.
 */
export const subscribeComposer: (listener: () => void) => () => void = (
  listener,
) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

/**
 * The composer bound to a diagram's scope (`services.use(ChatComposerV1,
 * callScopeOf(scope))`) and the Thread it is keyed by — only while
 * `composerAvailable()` and the scope names a Thread; otherwise undefined
 * (no stack to join).
 */
export const composerFor: (
  services: Services,
  scope: DiagramScope | undefined,
) => { readonly api: ChatComposer; readonly threadId: string } | undefined = (
  services,
  scope,
) => {
  if (!state.available || scope?.threadId === undefined) return undefined;

  return {
    api: services.use(ChatComposerV1, callScopeOf(scope)),
    threadId: scope.threadId,
  };
};

/**
 * The Project and Thread the window's location names
 * (`/projects/:projectId/threads/:threadId`), for a block without its own
 * scope; undefined without a `location` or without a Project segment.
 */
export const locationScope: () => DiagramScope | undefined = () => {
  if (typeof location === 'undefined') return undefined;

  const threadId = /\/threads\/([^/?#]+)/.exec(location.pathname)?.[1];
  const projectId = /\/projects\/([^/?#]+)/.exec(location.pathname)?.[1];

  if (projectId === undefined) return undefined;

  return { projectId, ...(threadId === undefined ? {} : { threadId }) };
};

/* The drafts of the stack ---------------------------------------------------- */

/**
 * The draft a stack item is on diagram `artifactId`, or undefined when the
 * item is another kind's (not DRAWIO_COMMENT_KIND), names another artifact
 * (`diagramItemTargetOf`), or its anchor is not a diagram anchor
 * (`diagramAnchorOf`). The draft keeps the item's id, note and author, its
 * target (with the revision it was written on, anchor as `diagramAnchorOf`
 * reads it), and `pin`, `inReplyTo` (non-empty) and `point` when the item's
 * data carries them well-typed. Pure; never throws.
 */
export const draftOfItem: (
  item: ComposerItem,
  artifactId: string,
) => CanvasDraft<DiagramAnchor> | undefined = (item, artifactId) => {
  if (item.kind !== DRAWIO_COMMENT_KIND) return undefined;

  const target = diagramItemTargetOf(item.data);

  if (target?.id !== artifactId) return undefined;

  const anchor = diagramAnchorOf(target.anchor);

  if (anchor === undefined) return undefined;

  const data = item.data as {
    readonly pin?: unknown;
    readonly inReplyTo?: unknown;
    readonly point?: unknown;
  };
  const point = data.point as { readonly x?: unknown; readonly y?: unknown };

  return {
    id: item.id,
    note: item.note,
    ...(item.author === undefined ? {} : { author: item.author }),
    target: { ...target, anchor },
    ...(typeof data.pin === 'number' ? { pin: data.pin } : {}),
    ...(typeof data.inReplyTo === 'string' && data.inReplyTo !== ''
      ? { inReplyTo: data.inReplyTo }
      : {}),
    ...(typeof point?.x === 'number' && typeof point.y === 'number'
      ? { point: { x: point.x, y: point.y } }
      : {}),
  };
};

/**
 * This kind's stack for the comment flow, bound to `scope`. Every method
 * settles:
 * - `begin(data, note)`: adds one item `{ threadId, kind: DRAWIO_COMMENT_KIND,
 *   elementTag: CHAT_COMMENT_LINE_TAG, data, note }` (`data` as the flow
 *   built it: `target`, `pin`, `inReplyTo?`, `refs`, `point`) and answers
 *   `{ kind: 'stack', itemId }`; `{ kind: 'unavailable' }`, writing nothing,
 *   without the composer or a Thread;
 * - `edit` / `remove`: `updateNote` / `removeItem` of that item; a no-op
 *   without the composer or a Thread;
 * - `send`: the status of `chat.send/v1.send({ projectId, threadId })`;
 *   `'unavailable'` without a Thread or when the call fails;
 * - `resolve`: `comments/v1.resolve({ commentId, resolved })` under the
 *   scope plus the root's own `promptId`; `'unavailable'` without a Thread,
 *   without that prompt, or when the call fails;
 * - `promptSendEvent` is PROMPT_SEND_EVENT.
 */
export const drawioCommentStore: (
  services: Services,
  scope: DiagramScope | undefined,
) => CommentStore<CanvasCommentData<DiagramAnchor>> = (services, scope) => ({
  begin: async (data, note) => {
    const composer = composerFor(services, scope);

    if (composer === undefined) return { kind: 'unavailable' };

    const item = await composer.api.addItem({
      threadId: composer.threadId,
      kind: DRAWIO_COMMENT_KIND,
      elementTag: CHAT_COMMENT_LINE_TAG,
      data,
      note,
    });

    return { kind: 'stack', itemId: item.id };
  },
  edit: async (itemId, note) => {
    const composer = composerFor(services, scope);

    await composer?.api.updateNote({
      threadId: composer.threadId,
      id: itemId,
      note,
    });
  },
  remove: async (itemId) => {
    const composer = composerFor(services, scope);

    await composer?.api.removeItem({ threadId: composer.threadId, id: itemId });
  },
  send: async () => {
    if (scope?.threadId === undefined) return 'unavailable';

    try {
      const result = await services
        .use(ChatSendV1, callScopeOf(scope))
        .send({ projectId: scope.projectId, threadId: scope.threadId });

      return result.status;
    } catch {
      return 'unavailable';
    }
  },
  resolve: async ({ commentId, promptId, resolved }) => {
    if (scope?.threadId === undefined || promptId === undefined) {
      return 'unavailable';
    }

    try {
      await services
        .use(CommentsV1, {
          projectId: scope.projectId,
          threadId: scope.threadId,
          promptId,
        })
        .resolve({ commentId, resolved });

      return 'done';
    } catch {
      return 'unavailable';
    }
  },
  promptSendEvent: PROMPT_SEND_EVENT,
});
