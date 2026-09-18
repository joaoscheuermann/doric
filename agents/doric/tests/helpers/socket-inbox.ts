import type { Socket } from 'socket.io-client';

/** Retains notices so fast live events cannot race installation of later barriers. */
export function inbox(socket: Socket) {
  const notices: { name: string; value: unknown }[] = [];
  const listeners = new Set<() => void>();
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure = error;
    listeners.forEach((notify) => notify());
  };
  socket.on('connect_error', fail);
  socket.on('workspace:error', (error) =>
    fail(new Error(JSON.stringify(error))),
  );
  socket.onAny((name: string, value: unknown) => {
    notices.push({ name, value });
    listeners.forEach((notify) => notify());
  });
  return {
    values: <T>(name: string) =>
      notices
        .filter((notice) => notice.name === name)
        .map(({ value }) => value as T),
    wait: <T = unknown>(
      name: string,
      predicate: (value: T) => boolean = () => true,
      timeoutMs = 30_000,
    ): Promise<T> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(
            new Error(
              `Timed out waiting for ${name}; notices: ${JSON.stringify(notices)}`,
            ),
          );
        }, timeoutMs);
        const check = () => {
          const match = notices.find(
            (notice) => notice.name === name && predicate(notice.value as T),
          );
          if (!match && !failure) return;
          clearTimeout(timer);
          listeners.delete(check);
          if (failure) reject(failure);
          else resolve(match!.value as T);
        };
        listeners.add(check);
        check();
      }),
  };
}
