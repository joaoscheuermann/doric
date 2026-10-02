import { composerStore } from '@/stores/composer';
import type { PromptSignal } from '@/utility/prompt-signal';
import { useSyncExternalStore } from 'react';
import { useStore } from 'zustand/react';

/**
 * What the conversation's composer offers the footer, and how the two talk.
 *
 * The prompt lives in the editor and the control lives in the shell, so the
 * fact that the prompt is empty has to cross between them. It crosses as a
 * value the shell owns: the editor writes it, the shell reads it through
 * `useSyncExternalStore`, and the child's props are the same object whatever it
 * writes. Nothing sets the shell's state from the child — that is a write
 * during the shell's commit, which is what a render loop is made of — and the
 * signal only speaks when the value changes, so a write cannot become a second
 * render and a render a second write.
 *
 * Sending goes the other way for the same reason: the shell counts requests and
 * the editor answers each new count once.
 */
export type Composer = {
  readonly promptSignal: PromptSignal;
  readonly sendRequest: number;
  readonly canSend: boolean;
  readonly send: () => void;
};

export const useComposer = (): Composer => {
  const promptSignal = useStore(composerStore, (state) => state.promptSignal);
  const sendRequest = useStore(composerStore, (state) => state.sendRequest);
  const send = useStore(composerStore, (state) => state.send);
  const canSend = useSyncExternalStore(
    promptSignal.subscribe,
    promptSignal.snapshot,
  );
  return { promptSignal, sendRequest, canSend, send };
};
