// The surface's copy of every Thread's comment stack: the lines the composer
// draws above the prompt and the send flushes. The state itself lives in the
// main process (`chat.composer/v1`); this store only opens one watch per Thread
// a surface shows, applies the deltas it sees and hands the gestures (a new
// item, an edit, a removal) back through the same service. An edit and a
// removal also apply here at once, so a send right after a keystroke reads the
// note as written; the service's echo then states the same.
//
// The watch is retained: several surfaces can show one Thread (the transcript
// and the footer controls both do), so the last release ends the watch and the
// first retain opens it again, with the portrait it starts from.

import { createStore } from 'zustand/vanilla';

import type {
  ComposerAddInput,
  ComposerItem,
  ComposerWatchItem,
} from '../../contracts/index.js';
import {
  type ComposerFeed,
  type ComposerWatchListener,
  composerFeed,
} from '../api/composer.js';

/** One Thread the composer's stack is held for. */
export interface StackThread {
  readonly id: string;
  readonly projectId: string;
}

/** The composer's stack as a surface reads it. */
export interface ComposerStackState {
  /** Each held Thread's stack, in the order the items were added. */
  readonly stacks: ReadonlyMap<string, readonly ComposerItem[]>;
  /**
   * The item whose note should take the caret — a comment that just joined
   * the stack — until its line has put it there.
   */
  readonly focused: string | undefined;
  /** Shows one Thread: opens its watch, or keeps the one already open. */
  retain(thread: StackThread): void;
  /** Stops showing one Thread; the last release ends its watch. */
  release(threadId: string): void;
  /** Adds one item to the Thread's stack; the service assigns its identity. */
  add(
    thread: StackThread,
    input: Omit<ComposerAddInput, 'threadId'>,
  ): Promise<ComposerItem | undefined>;
  /** Edits one item's note. */
  note(thread: StackThread, id: string, note: string): void;
  /** Removes one item from the Thread's stack. */
  remove(thread: StackThread, id: string): void;
  /** Asks for one item's note to take the caret; `undefined` drops the ask. */
  focus(id: string | undefined): void;
  /** One Thread's stack, empty while no watch has answered yet. */
  stack(threadId: string): readonly ComposerItem[];
  /**
   * Reads a held Thread's stack back from the service, for a send that must
   * see an item another surface added a moment ago, before its echo arrives.
   */
  sync(threadId: string): Promise<void>;
}

const emptyStacks: ReadonlyMap<string, readonly ComposerItem[]> = new Map();

/** Applies one watch delta to the stacks a store holds. */
const applyDelta = (
  stacks: ReadonlyMap<string, readonly ComposerItem[]>,
  delta: ComposerWatchItem,
): ReadonlyMap<string, readonly ComposerItem[]> => {
  if (delta.kind === 'text') {
    // The prompt's words are the editor's, not this store's; a window that
    // opens the Thread reads them back from the service's portrait.
    return stacks;
  }

  const next = new Map(stacks);
  const held = next.get(delta.threadId) ?? [];

  if (delta.kind === 'snapshot') {
    next.set(delta.threadId, [...delta.items]);
  } else if (delta.kind === 'added') {
    next.set(delta.threadId, [...held, delta.item]);
  } else if (delta.kind === 'updated') {
    next.set(
      delta.threadId,
      held.map((item) => (item.id === delta.item.id ? delta.item : item)),
    );
  } else {
    next.set(
      delta.threadId,
      held.filter((item) => item.id !== delta.id),
    );
  }

  return next;
};

/** Creates the stack store over the composer feed. */
export const createComposerStackStore = (feed: ComposerFeed = composerFeed) => {
  /** One watch per Thread, shared by every surface that shows it. */
  const watches = new Map<
    string,
    { thread: StackThread; release: () => void; held: number }
  >();

  const listen = (): ComposerWatchListener => (delta) => {
    // A delta only arrives while a watch is open, and the stack it changes is
    // the one this store holds.
    composerStackStore.setState((state) => ({
      stacks: applyDelta(state.stacks, delta),
      focused:
        delta.kind === 'removed' && state.focused === delta.id
          ? undefined
          : state.focused,
    }));
  };
  const composerStackStore = createStore<ComposerStackState>()((set, get) => {
    const open = (thread: StackThread): void => {
      const release = feed.watch(thread, listen());
      watches.set(thread.id, { thread, release, held: 1 });
    };

    return {
      stacks: emptyStacks,
      focused: undefined,
      retain: (thread) => {
        const held = watches.get(thread.id);
        if (held !== undefined) {
          held.held += 1;
          return;
        }
        open(thread);
      },
      release: (threadId) => {
        const held = watches.get(threadId);
        if (held === undefined) return;
        held.held -= 1;
        if (held.held > 0) return;
        watches.delete(threadId);
        held.release();
        const stacks = new Map(get().stacks);
        stacks.delete(threadId);
        set({ stacks });
      },
      add: (thread, input) => feed.add(thread, input),
      note: (thread, id, note) => {
        const held = get().stacks.get(thread.id) ?? [];
        if (held.some((item) => item.id === id && item.note !== note)) {
          const stacks = new Map(get().stacks);
          stacks.set(
            thread.id,
            held.map((item) => (item.id === id ? { ...item, note } : item)),
          );
          set({ stacks });
        }
        void feed.note(thread, id, note);
      },
      remove: (thread, id) => {
        set((state) => ({
          stacks: applyDelta(state.stacks, {
            kind: 'removed',
            threadId: thread.id,
            id,
          }),
          focused: state.focused === id ? undefined : state.focused,
        }));
        void feed.remove(thread, id);
      },
      focus: (id) => set({ focused: id }),
      stack: (threadId) => get().stacks.get(threadId) ?? [],
      sync: async (threadId) => {
        const held = watches.get(threadId);
        if (held === undefined) return;
        const snapshot = await feed.read(held.thread);
        // Released while the read was out: the stack is no longer held here.
        if (snapshot === undefined || !watches.has(threadId)) return;
        set((state) => ({
          stacks: applyDelta(state.stacks, {
            kind: 'snapshot',
            threadId,
            text: snapshot.text,
            items: [...snapshot.items],
          }),
        }));
      },
    };
  });

  return composerStackStore;
};

/** The composer's stack, over the chat's activation services. */
export const composerStackStore = createComposerStackStore();

/** Clears every held watch; the chat part is deactivating. */
export const resetComposerStack = (): void => {
  const { stacks, release } = composerStackStore.getState();
  for (const [threadId] of stacks) release(threadId);
  composerStackStore.setState({ stacks: emptyStacks, focused: undefined });
};
