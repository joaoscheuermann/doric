// The items of one open server stream of a routed service, queued by the
// writes it hears and read by the stream's generator.

/** A queue of items for one open stream; `next` ends once `signal` aborted. */
export const createInbox = <T>(signal: AbortSignal) => {
  const items: T[] = [];
  let wake: (() => void) | undefined;

  signal.addEventListener('abort', () => wake?.(), { once: true });

  return {
    push: (item: T) => {
      items.push(item);
      wake?.();
    },
    /** The next item, or `undefined` once `signal` aborted. */
    next: async (): Promise<T | undefined> => {
      while (items.length === 0 && !signal.aborted) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }

      return signal.aborted ? undefined : items.shift();
    },
  };
};
