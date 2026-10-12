import type { Disposable } from 'bundle/contracts';

/**
 * One listener over several stores: each `watch` returns its unsubscribe,
 * and the Disposable releases them all once.
 */
export const watchAll = (
  listener: () => void,
  watches: readonly ((listener: () => void) => () => void)[],
): Disposable => {
  const notify = () => listener();
  const stops = watches.map((watch) => watch(notify));
  let active = true;
  return {
    dispose: () => {
      if (!active) return;
      active = false;
      for (const stop of stops) stop();
    },
  };
};
