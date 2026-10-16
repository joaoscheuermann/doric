// A fake host for the papercraft stories: the `Services` a preview frame
// reads, answered in memory from the checkout story data — no bridge, no
// network. It is small but live: the composer stack takes, edits and removes
// drafts; the send flushes them into the Thread's log as durable comments;
// resolve writes `comments.resolved/v1`; the command bar's commands reach the
// mounted canvas through the canvas registry, as the desktop's commands do;
// `Autorizar` approves the revision on screen.

import type { Services } from 'bundle/contracts';
import { useEffect, useState } from 'react';

import { controllerFor } from '../../src/client/canvas-registry.js';
import { setComposerAvailable } from '../../src/client/comment.js';
import type {
  ComposerAddInput,
  ComposerItem,
  ComposerWatchItem,
} from '../../src/contracts/chat.js';
import {
  APPROVE_COMMAND,
  COMMENT_COMMAND,
  type Comment,
  ISOLATE_COMMAND,
  PAN_COMMAND,
  type PreviewItemData,
  SELECT_COMMAND,
  SELECT_REVISION_COMMAND,
  SHOW_ALL_COMMAND,
  type ThreadLogEvent,
  type ThreadWatchItem,
  ZOOM_FIT_COMMAND,
  ZOOM_IN_COMMAND,
  ZOOM_OUT_COMMAND,
  ZOOM_RESET_COMMAND,
} from '../../src/contracts/index.js';
import {
  checkoutComments,
  checkoutDrafts,
  checkoutLog,
  checkoutPreview,
  checkoutRecord,
} from './checkout.js';
import { THREAD_ID } from './preview.js';

export interface StoryHostOptions {
  /** How many revisions the preview has; the newest is on screen first. */
  readonly revisions?: number;
  readonly policy?: 'proceed' | 'request';
  /** The revisions already approved under `request`. */
  readonly approved?: readonly number[];
  /** Whether the preview carries the story's comment threads. */
  readonly comments?: boolean;
  /** Whether the Thread's composer stack holds the story's drafts. */
  readonly drafts?: boolean;
  /**
   * The entries each revision names. Naming `index.js` makes the surface try
   * path B's module, which this host cannot serve, so the markup stands in.
   */
  readonly entries?: readonly string[];
}

type Listener<T> = (item: T) => void;

const disposable = (dispose: () => void) => ({ dispose });

/** A `Services` whose `use` answers each contract the frame calls by its ID. */
export const storyHost = (options: StoryHostOptions = {}): Services => {
  const total = options.revisions ?? 1;
  const policy = options.policy ?? 'proceed';
  const approved = new Set(options.approved ?? []);
  const entries = options.entries ?? ['index.html'];

  /* The Thread's log and the comments registry ------------------------------- */

  let log: ThreadLogEvent[] = options.comments === false ? [] : checkoutLog();
  let comments: Comment[] =
    options.comments === false ? [] : checkoutComments();
  const logListeners = new Set<Listener<ThreadWatchItem>>();
  let prompt = 2;

  const append = (event: ThreadLogEvent): void => {
    log = [...log, { ...event, sequence: log.length + 1 }];
    for (const listener of [...logListeners])
      listener({ kind: 'event', event });
  };

  /* The composer stack -------------------------------------------------------- */

  let items: ComposerItem[] = options.drafts === false ? [] : checkoutDrafts();
  const composerListeners = new Set<Listener<ComposerWatchItem>>();
  let nextDraft = 1;

  const emit = (item: ComposerWatchItem): void => {
    for (const listener of [...composerListeners]) listener(item);
  };

  const composer = {
    read: async () => ({ threadId: THREAD_ID, text: '', items }),
    watch: (threadId: string, listener: Listener<ComposerWatchItem>) => {
      composerListeners.add(listener);
      listener({ kind: 'snapshot', threadId, text: '', items });

      return disposable(() => composerListeners.delete(listener));
    },
    setText: async () => undefined,
    addItem: (input: ComposerAddInput): Promise<ComposerItem> => {
      const item: ComposerItem = {
        id: input.id ?? `draft-${String(nextDraft++)}`,
        kind: input.kind,
        elementTag: input.elementTag,
        data: input.data,
        note: input.note ?? '',
        ...(input.author === undefined ? {} : { author: input.author }),
      };

      items = [...items, item];
      emit({ kind: 'added', threadId: input.threadId, item });

      return Promise.resolve(item);
    },
    updateNote: (input: {
      readonly threadId: string;
      readonly id: string;
      readonly note: string;
    }): Promise<void> => {
      items = items.map((item) =>
        item.id === input.id ? { ...item, note: input.note } : item,
      );
      const item = items.find((candidate) => candidate.id === input.id);

      if (item !== undefined)
        emit({ kind: 'updated', threadId: input.threadId, item });

      return Promise.resolve();
    },
    removeItem: (input: {
      readonly threadId: string;
      readonly id: string;
    }): Promise<void> => {
      items = items.filter((item) => item.id !== input.id);
      emit({ kind: 'removed', threadId: input.threadId, id: input.id });

      return Promise.resolve();
    },
    flush: async () => [],
    registerFlush: () => disposable(() => undefined),
  };

  /** The send: every draft becomes a durable comment under a new prompt. */
  const send = async () => {
    if (items.length === 0) return { status: 'empty' as const };

    prompt += 1;
    const promptId = `prompt-${String(prompt)}`;
    const sent = items;

    for (const item of sent) {
      const data = item.data as PreviewItemData;
      const comment: Comment = {
        commentId: item.id,
        target: data.target,
        text: item.note,
        resolved: false,
        createdAt: new Date().toISOString(),
        ...(data.inReplyTo === undefined ? {} : { inReplyTo: data.inReplyTo }),
      };

      comments = [...comments, { ...comment, promptId }];
      append({
        promptId,
        type: 'comments.added/v1',
        createdAt: comment.createdAt,
        event: comment,
      });
      await composer.removeItem({ threadId: THREAD_ID, id: item.id });
    }

    return { status: 'accepted' as const };
  };

  /* The artifacts registry ---------------------------------------------------- */

  const recordOf = (revision: number) =>
    checkoutRecord(revision, total, approved.has(revision));

  const artifacts = {
    read: (input: {
      readonly artifactId: string;
      readonly revision?: number;
    }) => {
      const revision = input.revision ?? total;

      // The work copy no longer serves the bytes: a named module cannot
      // reach the cache, and the markup stands in.
      return Promise.resolve(
        revision < 1 || revision > total
          ? undefined
          : { ...recordOf(revision), entries: [] },
      );
    },
    revisions: async () =>
      Array.from({ length: total }, (_, index) => recordOf(index + 1)),
    policy: async () => ({ policy }),
    approve: (input: { readonly revision: number }) => {
      approved.add(input.revision);
      append({
        type: 'artifacts.approved/v1',
        event: { artifactId: recordOf(input.revision).artifactId, ...input },
      });

      return Promise.resolve(recordOf(input.revision));
    },
  };

  /* The commands of the window's bar, as the desktop routes them ------------ */

  const execute = async (command: unknown, input?: unknown) => {
    const { artifactId, revision } = (input ?? {}) as {
      readonly artifactId?: string;
      readonly revision?: number;
    };
    const canvas = controllerFor(artifactId);

    switch (command) {
      case SELECT_COMMAND:
        return canvas?.setTool('select');
      case COMMENT_COMMAND:
        return canvas?.setTool('comment');
      case PAN_COMMAND:
        return canvas?.setTool('pan');
      case ISOLATE_COMMAND:
        return canvas?.isolate();
      case SHOW_ALL_COMMAND:
        return canvas?.showAll();
      case ZOOM_OUT_COMMAND:
        return canvas?.zoomOut();
      case ZOOM_RESET_COMMAND:
        return canvas?.zoomReset();
      case ZOOM_IN_COMMAND:
        return canvas?.zoomIn();
      case ZOOM_FIT_COMMAND:
        return canvas?.zoomFit();
      case SELECT_REVISION_COMMAND:
        if (revision !== undefined) canvas?.selectRevision(revision);
        return;
      case APPROVE_COMMAND: {
        const current = canvas?.currentRevision();

        if (current !== undefined)
          await artifacts.approve({ revision: current });
        return canvas?.reload();
      }
      default:
        // `abrir` opens the canvas window: a story has no window to open.
        return;
    }
  };

  const apis: Record<string, unknown> = {
    'artifacts/v1': artifacts,
    'artifacts.cache/v1': {
      ensure: () =>
        Promise.reject(new Error('the story host has no verified cache')),
    },
    'papercraft.previews/v1': {
      build: async () => ({ files: [] }),
      read: async (input: { readonly revision: number }) =>
        input.revision > total
          ? undefined
          : checkoutPreview(input.revision, entries),
    },
    'comments/v1': {
      list: async () => comments,
      add: () =>
        Promise.reject(
          new Error('a comment is written by the send, never directly'),
        ),
      resolve: (input: {
        readonly commentId: string;
        readonly resolved: boolean;
      }) => {
        comments = comments.map((comment) =>
          comment.commentId === input.commentId
            ? { ...comment, resolved: input.resolved }
            : comment,
        );
        append({
          promptId: `prompt-${String(prompt)}`,
          type: 'comments.resolved/v1',
          event: input,
        });

        return Promise.resolve(
          comments.find((comment) => comment.commentId === input.commentId),
        );
      },
    },
    'runtime.threads/v1': {
      watchThread: (
        _input: { readonly threadId: string },
        listener: Listener<ThreadWatchItem>,
      ) => {
        logListeners.add(listener);
        listener({ kind: 'snapshot', events: log });

        return disposable(() => logListeners.delete(listener));
      },
    },
    'chat.composer/v1': composer,
    'chat.send/v1': { send },
    'commands/v1': {
      execute,
      register: () => disposable(() => undefined),
    },
  };

  return {
    provide: () => disposable(() => undefined),
    use: (contract: unknown) => {
      const id = (contract as { readonly id?: string }).id ?? '';
      const api = apis[id];

      if (api === undefined) throw new Error(`${id} is not in the story host`);

      return api;
    },
    whenAvailable: () => disposable(() => undefined),
  } as unknown as Services;
};

/**
 * The fake host of one story, made once per mount, with chat's composer
 * marked active the way the client's activation marks it. `composer: false`
 * is a window where chat's composer never activated: there is no stack to
 * join.
 */
export const useStoryHost = (
  options: StoryHostOptions & { readonly composer?: boolean } = {},
): Services => {
  const [services] = useState(() => storyHost(options));
  const composer = options.composer !== false;

  useEffect(() => {
    setComposerAvailable(composer);
  }, [composer]);

  return services;
};
