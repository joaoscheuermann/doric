// What a surface reads of one Thread's composer stack: the lines it draws
// above the prompt and the retain that keeps their watch open.

import { useEffect } from 'react';
import { useStore } from 'zustand/react';

import type { ComposerItem } from '../../contracts/index.js';
import {
  composerStackStore,
  type StackThread,
} from '../stores/composer-stack.js';

export type { StackThread };

/** One Thread's comment stack, retained while the surface that reads it shows. */
const noItems: readonly ComposerItem[] = [];

export const useComposerStack = (thread: StackThread | undefined) => {
  // The empty stack is one frozen array: a fresh `[]` per read would read as a
  // change on every render, which is what a render loop is made of.
  const items = useStore(composerStackStore, (state) =>
    thread === undefined ? noItems : (state.stacks.get(thread.id) ?? noItems),
  );
  const focused = useStore(
    composerStackStore,
    (state) => items.find((item) => item.id === state.focused)?.id ?? undefined,
  );
  const focus = useStore(composerStackStore, (state) => state.focus);
  const add = useStore(composerStackStore, (state) => state.add);
  const note = useStore(composerStackStore, (state) => state.note);
  const remove = useStore(composerStackStore, (state) => state.remove);

  // The watch is retained, not owned: the transcript and the footer can both
  // show one Thread, so the last surface to stop showing it ends the watch.
  // The Thread record itself may be rebuilt every render; only the pair it
  // carries decides which stack is watched.
  const threadId = thread?.id;
  const projectId = thread?.projectId;
  useEffect(() => {
    if (threadId === undefined || projectId === undefined) return;
    composerStackStore.getState().retain({ id: threadId, projectId });

    return () => {
      composerStackStore.getState().release(threadId);
    };
  }, [threadId, projectId]);

  return {
    items,
    focused,
    focus,
    add: (input: Parameters<typeof add>[1]) =>
      thread === undefined ? Promise.resolve(undefined) : add(thread, input),
    note: (id: string, text: string) => {
      if (thread !== undefined) note(thread, id, text);
    },
    remove: (id: string) => {
      if (thread !== undefined) remove(thread, id);
    },
  };
};
