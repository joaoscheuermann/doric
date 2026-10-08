import { createStore } from 'zustand/vanilla';

import { createPromptSignal, type PromptSignal } from '@/utility/prompt-signal';

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

export const composerStore = createStore<ComposerState>()((set) => ({
  promptSignal: createPromptSignal(),
  sendRequest: 0,
  send: () => set((state) => ({ sendRequest: state.sendRequest + 1 })),
}));
