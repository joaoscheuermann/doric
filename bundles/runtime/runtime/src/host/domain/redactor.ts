/*
 * The runtime's redaction list (design 57 §4.6): the secrets the store holds
 * (`secrets/v1.redactions()`, in its cache order) followed by every secret the
 * runtime itself wrote somewhere, such as a Git token applied to a sandbox.
 */
export interface Redactor {
  /** `[...stored, ...registered]`, read from the secrets store now. */
  current(): Promise<readonly string[]>;
  /**
   * The list as the store last answered it, for the synchronous terminal
   * stream. Each call also starts one background read, so a rotated secret
   * reaches the next chunk without awaiting the store in the stream.
   */
  latest(): readonly string[];
  /** Redacts a secret the runtime wrote elsewhere, for as long as it runs. */
  register(secret: string): void;
}

export const createRedactor = (
  stored: () => Promise<readonly string[]>,
): Redactor => {
  const registered: string[] = [];
  let cache: readonly string[] = [];
  let refreshing: Promise<void> | undefined;

  return {
    current: async () => {
      cache = await stored();

      return [...cache, ...registered];
    },
    latest: () => {
      if (refreshing === undefined)
        refreshing = stored()
          .then((value) => {
            cache = value;
          })
          .catch(() => undefined)
          .finally(() => {
            refreshing = undefined;
          });

      return [...cache, ...registered];
    },
    register: (secret) => {
      if (secret !== '') registered.push(secret);
    },
  };
};
