import { createStore } from 'zustand/vanilla';

import {
  createPromptSignal,
  type PromptSignal,
} from '../utility/prompt-signal.js';

/**
 * What the composer offers the footer, and how the two talk. The prompt's
 * emptiness travels as the shell-owned `promptSignal`, and sending goes the
 * other way as a count the editor answers once.
 */
export type ComposerState = {
  readonly promptSignal: PromptSignal;
  readonly sendRequest: number;
  readonly send: () => void;
};

const createComposer = () =>
  createStore<ComposerState>()((set) => ({
    promptSignal: createPromptSignal(),
    sendRequest: 0,
    send: () => set((state) => ({ sendRequest: state.sendRequest + 1 })),
  }));

const composers = new Map<
  string | undefined,
  ReturnType<typeof createComposer>
>();

/** Separate editor/footer signals for each simultaneously open conversation. */
export const composerFor = (threadId: string | undefined) => {
  let store = composers.get(threadId);
  if (store === undefined) {
    store = createComposer();
    composers.set(threadId, store);
  }
  return store;
};

export const resetComposers = (): void => composers.clear();
