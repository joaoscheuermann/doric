import { useSyncExternalStore } from 'react';
import { useStore } from 'zustand/react';

import type { Thread } from '../domain/workspace.js';
import { composerFor } from '../stores/composer.js';
import type { PromptSignal } from '../utility/prompt-signal.js';
import { useComposerStack } from './use-composer-stack.js';

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
 *
 * The stack counts too: a comment alone is something to send, so the control
 * stays enabled while the editor holds no words but the stack holds a line —
 * and a send with an empty editor carries the stack's own Markdown, one line
 * per comment with its anchor (`domain/composer-stack`).
 */
export type Composer = {
  readonly promptSignal: PromptSignal;
  readonly sendRequest: number;
  readonly canSend: boolean;
  readonly send: () => void;
};

export const useComposer = (thread: Thread | undefined): Composer => {
  const composerStore = composerFor(thread?.id);
  const promptSignal = useStore(composerStore, (state) => state.promptSignal);
  const sendRequest = useStore(composerStore, (state) => state.sendRequest);
  const send = useStore(composerStore, (state) => state.send);
  const hasWords = useSyncExternalStore(
    promptSignal.subscribe,
    promptSignal.snapshot,
  );
  const stack = useComposerStack(
    thread === undefined
      ? undefined
      : { id: thread.id, projectId: thread.projectId },
  );
  return {
    promptSignal,
    sendRequest,
    // Either the words or the stack: a comment alone is already something to
    // send, and its note rides the same prompt the words would.
    canSend: hasWords || stack.items.length > 0,
    send,
  };
};
