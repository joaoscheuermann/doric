/**
 * Whether the prompt holds words, as something the shell can read.
 *
 * The editor owns that fact and the shell draws the control it drives, so it has
 * to cross between them — but not as state: a child that sets its parent's state
 * writes during the parent's commit, and a commit that runs the child's effects
 * again is what a render loop is made of. The fact travels as a value the shell
 * owns and subscribes to instead. The editor writes it, the shell reads it, and
 * the child's props never change because of it, so no effect of the child's can
 * run again because of it.
 *
 * Only a change tells anyone: a value written twice is one fact, which is what
 * keeps a write from turning into a second render, and a second render into a
 * write.
 */
export type PromptSignal = {
  /** Called while the value is wanted; the answer is the way to stop wanting it. */
  readonly subscribe: (notify: () => void) => () => void;
  /** The value as it stands, which is what a reader renders against. */
  readonly snapshot: () => boolean;
  /** The value the editor just read from its prompt. */
  readonly set: (hasWords: boolean) => void;
};

export const createPromptSignal = (): PromptSignal => {
  const listeners = new Set<() => void>();
  let hasWords = false;

  return {
    subscribe: (notify) => {
      listeners.add(notify);

      return () => {
        listeners.delete(notify);
      };
    },
    snapshot: () => hasWords,
    set: (next) => {
      if (next === hasWords) return;
      hasWords = next;
      for (const notify of listeners) notify();
    },
  };
};
