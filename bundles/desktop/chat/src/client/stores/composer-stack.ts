// The surface's copy of every Thread's comment stack: the lines the composer
// draws above the prompt and the send flushes. The state itself lives in the
// main process (`chat.composer/v1`); this store only opens one watch per Thread
// a surface shows, applies the deltas it sees and hands the gestures (a new
// item, an edit, a removal) back through the same service. An edit and a
// removal also apply here at once, so a send right after a keystroke reads the
// note as written; the service's echo then states the same.
//
// A note's keystrokes reach the service together: the last one written within
// `NOTE_WRITE_DELAY` of the one before goes as one write. A write still held
// goes at once when anything reads the stack back from the service — the
// send's `prompt-send` (`flushNotes`), `sync`, the last release — and a
// removal drops it, the removal winning. An echo of an older write never
// overwrites a note written here after it, and a delta that changes nothing
// wakes no surface.
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
  /** Edits one item's note; the service is told within `NOTE_WRITE_DELAY`. */
  note(thread: StackThread, id: string, note: string): void;
  /**
   * Hands the service every note edit still held — one Thread's, or every
   * Thread's — so what reads it next (a send) finds the notes as written.
   */
  flushNotes(threadId?: string): void;
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

/** How long a note's edits gather before one write hands them to the service. */
export const NOTE_WRITE_DELAY = 150;

/** One item of one Thread, as the held writes are keyed. */
const noteKey = (threadId: string, id: string): string => `${threadId}\n${id}`;

/** Whether two items read the same: an echo of what this store holds. */
const sameItem = (held: ComposerItem, next: ComposerItem): boolean =>
  held.id === next.id &&
  held.note === next.note &&
  held.kind === next.kind &&
  held.elementTag === next.elementTag &&
  held.author === next.author &&
  (held.data === next.data ||
    JSON.stringify(held.data) === JSON.stringify(next.data));

/**
 * Applies one watch delta to the stacks a store holds: the same map when it
 * changes nothing.
 */
const applyDelta = (
  stacks: ReadonlyMap<string, readonly ComposerItem[]>,
  delta: ComposerWatchItem,
): ReadonlyMap<string, readonly ComposerItem[]> => {
  if (delta.kind === 'text') {
    // The prompt's words are the editor's, not this store's; a window that
    // opens the Thread reads them back from the service's portrait.
    return stacks;
  }

  const held = stacks.get(delta.threadId);
  let items: readonly ComposerItem[];

  if (delta.kind === 'snapshot') {
    items = [...delta.items];
  } else if (delta.kind === 'added') {
    items = [...(held ?? []), delta.item];
  } else if (delta.kind === 'updated') {
    const index = held?.findIndex((item) => item.id === delta.item.id) ?? -1;
    const current = index < 0 ? undefined : held?.[index];
    if (held === undefined || current === undefined) return stacks;
    if (sameItem(current, delta.item)) return stacks;
    items = held.map((item, at) => (at === index ? delta.item : item));
  } else {
    if (held === undefined || !held.some((item) => item.id === delta.id))
      return stacks;
    items = held.filter((item) => item.id !== delta.id);
  }

  return new Map(stacks).set(delta.threadId, items);
};

/** Creates the stack store over the composer feed. */
export const createComposerStackStore = (feed: ComposerFeed = composerFeed) => {
  /** One watch per Thread, shared by every surface that shows it. */
  const watches = new Map<
    string,
    { thread: StackThread; release: () => void; held: number }
  >();

  /** Note edits written here that the service has not been handed yet. */
  const edits = new Map<
    string,
    {
      thread: StackThread;
      id: string;
      note: string;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** Writes handed to the service whose echo has not come back yet. */
  const unanswered = new Map<string, number>();

  /** Hands one held note edit to the service now. */
  const write = (key: string): void => {
    const edit = edits.get(key);
    if (edit === undefined) return;
    clearTimeout(edit.timer);
    edits.delete(key);
    unanswered.set(key, (unanswered.get(key) ?? 0) + 1);
    feed.note(edit.thread, edit.id, edit.note);
  };

  /** Lets go of one item's writes: it left the stack. */
  const drop = (key: string): void => {
    const edit = edits.get(key);
    if (edit !== undefined) clearTimeout(edit.timer);
    edits.delete(key);
    unanswered.delete(key);
  };

  /** Whether the note this store holds for an item is newer than the service's. */
  const ahead = (key: string): boolean =>
    edits.has(key) || (unanswered.get(key) ?? 0) > 0;

  /**
   * The delta as this store applies it: an echo of an older write of a note
   * written here since leaves that note alone, and so does a portrait read
   * while a write is out.
   */
  const settle = (
    stacks: ReadonlyMap<string, readonly ComposerItem[]>,
    delta: ComposerWatchItem,
  ): ComposerWatchItem | undefined => {
    if (delta.kind === 'updated') {
      const key = noteKey(delta.threadId, delta.item.id);
      const out = unanswered.get(key);
      if (out !== undefined) {
        if (out > 1) unanswered.set(key, out - 1);
        else unanswered.delete(key);
      }
      return ahead(key) ? undefined : delta;
    }
    if (delta.kind === 'removed') {
      drop(noteKey(delta.threadId, delta.id));
      return delta;
    }
    if (delta.kind !== 'snapshot') return delta;
    const local = stacks.get(delta.threadId) ?? [];
    return {
      ...delta,
      items: delta.items.map((item) => {
        if (!ahead(noteKey(delta.threadId, item.id))) return item;
        const mine = local.find((candidate) => candidate.id === item.id);
        return mine === undefined || mine.note === item.note
          ? item
          : { ...item, note: mine.note };
      }),
    };
  };

  /** Applies one delta, waking the surfaces only when it changed something. */
  const apply = (delta: ComposerWatchItem): void => {
    const state = composerStackStore.getState();
    const settled = settle(state.stacks, delta);
    if (settled === undefined) return;
    const stacks = applyDelta(state.stacks, settled);
    const focused =
      settled.kind === 'removed' && state.focused === settled.id
        ? undefined
        : state.focused;
    if (stacks === state.stacks && focused === state.focused) return;
    composerStackStore.setState({ stacks, focused });
  };

  // A delta only arrives while a watch is open, and the stack it changes is
  // the one this store holds.
  const listen = (): ComposerWatchListener => apply;

  /** Hands the service the held note edits of one Thread, or of every one. */
  const flushNotes = (threadId?: string): void => {
    for (const [key, edit] of [...edits]) {
      if (threadId === undefined || edit.thread.id === threadId) write(key);
    }
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
        const watch = watches.get(threadId);
        if (watch === undefined) return;
        watch.held -= 1;
        if (watch.held > 0) return;
        // The notes written here reach the service before the watch ends, so
        // the draft keeps them.
        flushNotes(threadId);
        for (const key of [...unanswered.keys()]) {
          if (key.startsWith(noteKey(threadId, ''))) unanswered.delete(key);
        }
        watches.delete(threadId);
        watch.release();
        const stacks = new Map(get().stacks);
        stacks.delete(threadId);
        set({ stacks });
      },
      add: (thread, input) => feed.add(thread, input),
      note: (thread, id, note) => {
        const items = get().stacks.get(thread.id) ?? [];
        const item = items.find((candidate) => candidate.id === id);
        if (item !== undefined && item.note !== note) {
          // The item is the stack's own: the surface drawing it, and the send a
          // keystroke later, read the note as written before the echo states it.
          Object.assign(item, { note });
          set({ stacks: new Map(get().stacks).set(thread.id, [...items]) });
        }
        // The service hears the last edit of a burst, once.
        const key = noteKey(thread.id, id);
        const before = edits.get(key);
        if (before !== undefined) clearTimeout(before.timer);
        edits.set(key, {
          thread,
          id,
          note,
          timer: setTimeout(() => write(key), NOTE_WRITE_DELAY),
        });
      },
      flushNotes,
      remove: (thread, id) => {
        // The removal wins over a note edit still held for the item.
        drop(noteKey(thread.id, id));
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
        const watch = watches.get(threadId);
        if (watch === undefined) return;
        // The read answers every note written here so far.
        flushNotes(threadId);
        const snapshot = await feed.read(watch.thread);
        // Released while the read was out: the stack is no longer held here.
        if (snapshot === undefined || !watches.has(threadId)) return;
        apply({
          kind: 'snapshot',
          threadId,
          text: snapshot.text,
          items: [...snapshot.items],
        });
      },
    };
  });

  return composerStackStore;
};

/** The composer's stack, over the chat's activation services. */
export const composerStackStore = createComposerStackStore();

/** Clears every held watch; the chat part is deactivating. */
export const resetComposerStack = (): void => {
  const { stacks, release, flushNotes } = composerStackStore.getState();
  flushNotes();
  for (const [threadId] of stacks) release(threadId);
  composerStackStore.setState({ stacks: emptyStacks, focused: undefined });
};
