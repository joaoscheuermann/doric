// Small waiting helpers: the bundle connects in the background, so a test
// waits for the public state it expects, bounded so a missing behavior fails
// instead of hanging.

/** A promise with its settle functions in hand. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });

  return { promise, resolve, reject };
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** How long a test waits for a background effect before it fails. */
export const WAIT_MS = 10_000;

/**
 * Polls `check` until it answers true, or fails after `timeoutMs` with
 * `label` and the last thing `describe` reports.
 */
export const eventually = async (
  check: () => boolean | Promise<boolean>,
  label: string,
  describe: () => unknown = () => undefined,
  timeoutMs = WAIT_MS,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await check()) {
      return;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${label}; last seen: ${JSON.stringify(describe())}`,
      );
    }

    await sleep(25);
  }
};

/** The `code` a contract error carries, whatever process built it. */
export const codeOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null && 'code' in error
    ? (error as { readonly code: unknown }).code
    : undefined;
