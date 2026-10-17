// The composer's state, keyed by `(projectId, threadId)`: the Thread's draft
// text and its comment stack, one state in the main process. Pure on purpose —
// the service around it (`composer-service.ts`) only reads the call's scope and
// hands it the watches, so the rules themselves are tested without the bridge.
//
// The stack's items are drafts: nothing here touches the log. The flush is the
// only way an item leaves the stack — the owner of the item's kind decides, in
// the flush it registered, what durable write the draft becomes, and the state
// collects those writes, takes the flushed items off the stack and hands each
// item back with its writes to the sender window, which puts an item back when
// its write fails (the main process cannot reach the host's contracts; see
// `docs/architecture/bundles/comments.md`, "Dois registros, um dono").

import { randomUUID } from 'node:crypto';

import { ContractError, type Disposable } from 'bundle/contracts';

import {
  COMPOSER_ITEM_ID_PREFIX,
  type ComposerAddInput,
  type ComposerFlush,
  type ComposerFlushContext,
  type ComposerFlushed,
  type ComposerItem,
  type ComposerSnapshot,
  type ComposerWatchItem,
  READER_NAME,
} from '../contracts/index.js';

/** One Thread's held draft. */
interface Draft {
  readonly key: string;
  text: string;
  items: ComposerItem[];
}

/** One watch: the listener, kept until it disposes. */
type Watcher = (item: ComposerWatchItem) => void;

/** The composer's state machine. */
export interface ComposerState {
  /** The Thread's portrait: its words and its stack, empty until written. */
  read(projectId: string | undefined, threadId: string): ComposerSnapshot;
  /**
   * The portrait first, then every delta — the shape of
   * `runtime.threads/v1.watchThread`. One watch per listener; `dispose` ends it.
   */
  watch(
    projectId: string | undefined,
    threadId: string,
    listener: Watcher,
  ): Disposable;
  /** Sets the Thread's words; every watch sees the delta. */
  setText(projectId: string | undefined, threadId: string, text: string): void;
  /**
   * Adds one item to the stack. The id is assigned here (`comment-<uuid>`),
   * unless the input brings back a `comment-` id the stack does not hold —
   * an item the sender puts back keeps the comment id it was sent with.
   */
  addItem(projectId: string | undefined, input: ComposerAddInput): ComposerItem;
  /** Edits one item's note — a draft is free to change. */
  updateNote(
    projectId: string | undefined,
    threadId: string,
    id: string,
    note: string,
  ): void;
  /** Removes one item from the stack. */
  removeItem(projectId: string | undefined, threadId: string, id: string): void;
  /**
   * Runs the flush each item's kind registered, takes the flushed items off
   * the stack and answers each with the comment writes the sender performs.
   * An item whose flush answers no write stays drafted, and so does an item
   * whose kind has no flush: only the owner says how a draft becomes durable.
   */
  flush(context: ComposerFlushContext): Promise<readonly ComposerFlushed[]>;
  /** The owner of a kind registers how its items flush; a second is a conflict. */
  registerFlush(kind: string, flush: ComposerFlush): Disposable;
}

const keyOf = (projectId: string | undefined, threadId: string): string =>
  `${projectId ?? ''}:${threadId}`;

/** The root comment a reply item continues, when its data names one. */
const rootOf = (item: ComposerItem): string | undefined => {
  const data = item.data;
  if (typeof data !== 'object' || data === null) return undefined;
  const root = (data as { inReplyTo?: unknown }).inReplyTo;

  return typeof root === 'string' && root.length > 0 ? root : undefined;
};

/** Creates the composer's state, with the flushes given already registered. */
export const createComposerState = (
  flushes: ReadonlyMap<string, ComposerFlush> = new Map(),
): ComposerState => {
  const drafts = new Map<string, Draft>();
  const watchers = new Map<string, Set<Watcher>>();
  const registered = new Map(flushes);

  const draftOf = (projectId: string | undefined, threadId: string): Draft => {
    const key = keyOf(projectId, threadId);
    const held = drafts.get(key);

    if (held !== undefined) return held;

    const draft: Draft = { key, text: '', items: [] };
    drafts.set(key, draft);

    return draft;
  };

  const emit = (key: string, item: ComposerWatchItem): void => {
    for (const listener of watchers.get(key) ?? []) {
      try {
        listener(item);
      } catch (error) {
        // One failing watch never stops the others, nor the write itself.
        console.error('Doric: a composer watch failed:', error);
      }
    }
  };

  return {
    read(projectId, threadId) {
      const draft = drafts.get(keyOf(projectId, threadId)) ?? {
        key: keyOf(projectId, threadId),
        text: '',
        items: [] as ComposerItem[],
      };

      return {
        threadId,
        text: draft.text,
        items: [...draft.items],
      };
    },

    watch(projectId, threadId, listener) {
      const draft = draftOf(projectId, threadId);
      const watchersOfKey = watchers.get(draft.key) ?? new Set<Watcher>();
      watchers.set(draft.key, watchersOfKey);
      watchersOfKey.add(listener);

      // The portrait first: a watcher never waits for the next change to see
      // the draft as it stands.
      listener({
        kind: 'snapshot',
        threadId,
        text: draft.text,
        items: [...draft.items],
      });

      let done = false;

      return {
        dispose: () => {
          if (done) return;
          done = true;
          watchersOfKey.delete(listener);
          if (watchersOfKey.size === 0) watchers.delete(draft.key);
        },
      };
    },

    setText(projectId, threadId, text) {
      const draft = draftOf(projectId, threadId);
      draft.text = text;
      emit(draft.key, { kind: 'text', threadId, text });
    },

    addItem(projectId, input) {
      const draft = draftOf(projectId, input.threadId);
      const wanted = input.id ?? '';
      const kept =
        wanted.startsWith(COMPOSER_ITEM_ID_PREFIX) &&
        wanted.length > COMPOSER_ITEM_ID_PREFIX.length &&
        !draft.items.some((held) => held.id === wanted);
      const item: ComposerItem = {
        id: kept ? wanted : `${COMPOSER_ITEM_ID_PREFIX}${randomUUID()}`,
        kind: input.kind,
        elementTag: input.elementTag,
        data: input.data,
        // An item nobody signed is the reader's own, as their prompt is.
        author: input.author ?? READER_NAME,
        note: input.note ?? '',
      };
      draft.items.push(item);
      emit(draft.key, { kind: 'added', threadId: input.threadId, item });

      return item;
    },

    updateNote(projectId, threadId, id, note) {
      const draft = drafts.get(keyOf(projectId, threadId));
      const index = draft?.items.findIndex((item) => item.id === id) ?? -1;
      const current = index < 0 ? undefined : draft?.items[index];
      if (draft === undefined || current === undefined) return;
      const next: ComposerItem = { ...current, note };
      draft.items[index] = next;
      emit(draft.key, { kind: 'updated', threadId, item: next });
    },

    removeItem(projectId, threadId, id) {
      const draft = drafts.get(keyOf(projectId, threadId));
      const index = draft?.items.findIndex((item) => item.id === id) ?? -1;
      if (draft === undefined || index < 0) return;
      draft.items.splice(index, 1);
      emit(draft.key, { kind: 'removed', threadId, id });
    },

    async flush(context) {
      const draft = drafts.get(keyOf(context.projectId, context.threadId));
      if (draft === undefined || draft.items.length === 0) return [];

      const flushed: ComposerFlushed[] = [];
      const held: ComposerItem[] = [];

      // Stack order is flush order, so a root is written before its replies;
      // a reply whose root stays drafted stays drafted with it, because the
      // log never holds a reply to a comment it has not recorded.
      for (const item of draft.items) {
        const root = rootOf(item);
        if (root !== undefined && held.some((other) => other.id === root)) {
          held.push(item);
          continue;
        }
        const flush = registered.get(item.kind);
        // A kind whose owner has registered no flush keeps its items: nothing
        // has said how they become durable, so they stay drafted.
        if (flush === undefined) {
          held.push(item);
          continue;
        }
        // The flush answers the writes the sender performs. An item leaves
        // only when its flush answered a write; a flush that throws leaves
        // the whole stack where it was, so the sender can try again.
        const answered = await flush(item, context);
        if (answered.length === 0) {
          held.push(item);
          continue;
        }
        flushed.push({ item, writes: answered });
      }

      draft.items = held;
      for (const { item } of [...flushed].reverse()) {
        emit(draft.key, {
          kind: 'removed',
          threadId: context.threadId,
          id: item.id,
        });
      }

      return flushed;
    },

    registerFlush(kind, flush) {
      if (registered.has(kind)) {
        throw new ContractError(
          'registration_conflict',
          `The ${kind} comment kind already has a flush.`,
          { kind },
        );
      }
      registered.set(kind, flush);

      let done = false;

      return {
        dispose: () => {
          if (done) return;
          done = true;
          if (registered.get(kind) === flush) registered.delete(kind);
        },
      };
    },
  };
};
