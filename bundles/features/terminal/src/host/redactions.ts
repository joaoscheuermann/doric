import type { Disposable, Secrets } from 'bundle/contracts';

/*
 * The redaction list the terminal stream applies synchronously, chunk by
 * chunk (R-2.1 revised): the last list `secrets/v1.watchRedactions`
 * delivered, kept current by its change notices, and read again from the
 * store right before a terminal starts, as the runtime's `redactor.current()`
 * did ("the terminal stream redacts with the list read here").
 */
export interface Redactions {
  /** The list as the store last answered it. */
  latest(): readonly string[];
  /** Reads the list from the store now. */
  refresh(): Promise<void>;
  dispose(): void;
}

export const createRedactions = (
  secrets: Pick<Secrets, 'redactions' | 'watchRedactions'>,
): Redactions => {
  let cache: readonly string[] = [];
  let watching: Disposable | undefined;

  try {
    watching = secrets.watchRedactions((list) => {
      cache = list;
    });
  } catch {
    // Without change notices the list is still read before every start.
  }

  return {
    latest: () => cache,
    refresh: async () => {
      cache = await secrets.redactions();
    },
    dispose: () => {
      watching?.dispose();
      watching = undefined;
    },
  };
};
