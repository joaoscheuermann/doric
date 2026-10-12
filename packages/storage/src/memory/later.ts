/**
 * Runs `work` now, synchronously, and hands its result or its exception back
 * as a promise. The memory backends answer asynchronously like any backend,
 * while each operation still runs whole before any other call starts.
 */
export const later = <T>(work: () => T): Promise<T> =>
  new Promise((resolve) => {
    resolve(work());
  });
