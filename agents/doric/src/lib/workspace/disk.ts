import { statfs } from 'node:fs/promises';

import { type ThreadExecution, ThreadPersistenceError } from './runtime.js';

export const storageMessage =
  'Execution paused: storage is low or unavailable. Free disk space above 10% and resume the queue.';

export class StoragePressureError extends Error {
  constructor() {
    super(storageMessage);
    this.name = 'StoragePressureError';
  }
}

/** Read the filesystem holding persistence, not the sandbox's writable layer. */
export const checkDisk = async (
  path: string,
  read: (path: string) => Promise<{ blocks: bigint; bavail: bigint }> = (
    path,
  ) => statfs(path, { bigint: true }),
): Promise<void> => {
  try {
    const disk = await read(path);
    if (disk.blocks <= 0n || disk.bavail * 10n <= disk.blocks)
      throw new StoragePressureError();
  } catch {
    // An unreadable configured mount is not evidence that execution is safe.
    throw new StoragePressureError();
  }
};

/** Recognizes native and Prisma-wrapped disk exhaustion without retaining diagnostics. */
export const storageFull = (error: unknown): boolean => {
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (value instanceof StoragePressureError) return true;
    if (value === null || typeof value !== 'object' || seen.has(value))
      continue;
    seen.add(value);
    const fields = value as Record<string, unknown>;
    if (fields.code === 'ENOSPC' || fields.code === '53100') return true;
    if (
      typeof fields.message === 'string' &&
      /(?:\b53100\b|\bENOSPC\b|no space left on device)/i.test(fields.message)
    )
      return true;
    pending.push(fields.cause, fields.meta, fields.originalError);
  }
  return false;
};

/** Cancel a long provider/tool wait as soon as the storage check fails. */
export const guardStorage =
  (
    execute: ThreadExecution,
    check: () => Promise<void>,
    abort: () => void,
  ): ThreadExecution =>
  async (options) => {
    const controller = new AbortController();
    let pressure: unknown;
    let checking = false;
    const timer = setInterval(() => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      void check()
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          pressure = error;
          abort();
          controller.abort();
        })
        .finally(() => {
          checking = false;
        });
    }, 3000);
    timer.unref();
    try {
      const text = await execute({
        ...options,
        signal: AbortSignal.any([options.signal, controller.signal]),
      });
      if (pressure !== undefined) throw pressure;
      return text;
    } catch (error) {
      // A failed checkpoint carries its retry closure and must not be replaced.
      if (pressure !== undefined && error instanceof ThreadPersistenceError)
        throw new ThreadPersistenceError(pressure, error.retry);
      if (storageFull(error)) throw error;
      throw pressure ?? error;
    } finally {
      clearInterval(timer);
      controller.abort();
    }
  };
