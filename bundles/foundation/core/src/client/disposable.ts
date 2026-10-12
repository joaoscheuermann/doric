import type { Disposable } from 'bundle/contracts';

/** A `Disposable` whose `dispose` runs `dispose` once. */
export const once = (dispose: () => void): Disposable => {
  let done = false;

  return {
    dispose: () => {
      if (!done) {
        done = true;
        dispose();
      }
    },
  };
};
