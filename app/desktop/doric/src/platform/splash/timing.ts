/** The splash stays visible at least this long, even once the backend answers. */
export const splashMinimumMs = 5_000;

/** How long main waits for a window's `ready()` after `onAppReadyHook` [S8-10]. */
export const WINDOW_READY_DEADLINE_MS = 30_000;

export const remainingSplashMs = (elapsedMs: number): number =>
  Math.max(0, splashMinimumMs - elapsedMs);

/** The clock the startup waits on; tests pass a fake one. */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const sleep = (clock: Clock, ms: number): Promise<void> =>
  new Promise((resolve) => {
    clock.setTimeout(resolve, ms);
  });
