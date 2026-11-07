/**
 * Awaits `pending` while a referenced timer keeps the event loop running.
 *
 * Call deadlines run on `unref`'d timers so they never hold a process open.
 * A test that awaits nothing but such a deadline would otherwise see the loop
 * drain first, and `node:test` cancels it as still pending.
 */
export const alive = async <T>(pending: Promise<T>): Promise<T> => {
  const keep = setInterval(() => undefined, 1000);

  try {
    return await pending;
  } finally {
    clearInterval(keep);
  }
};
