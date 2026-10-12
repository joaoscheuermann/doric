import type { Storage } from 'bundle/contracts';

import { storageMessage } from '../../contracts/model.js';
import { ThreadPersistenceError } from './runtime.js';

/*
 * Moved from agents/doric (workspace/disk.ts, design 57 §4.7 as revised): the
 * 10 % rule over `storage/v1.health()`, the disk-exhaustion classification and
 * the guard that cancels a long run when storage fails. `checkDisk` itself
 * moved into `postgres`'s health measurement in stage 2.
 */

export class StoragePressureError extends Error {
  constructor() {
    super(storageMessage);
    this.name = 'StoragePressureError';
  }
}

/**
 * The same 10% rule over the storage backend's own measurement of the
 * filesystem holding persistence (`storage/v1.health`). A store that cannot
 * measure it, or a failed check, is not evidence that execution is safe.
 */
export const checkStorageHealth = async (
  storage: Pick<Storage, 'health'>,
): Promise<void> => {
  try {
    const { disk } = await storage.health();
    if (
      disk === undefined ||
      disk.blocks <= 0 ||
      disk.availableBlocks * 10 <= disk.blocks
    )
      throw new StoragePressureError();
  } catch {
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

/** One run as the guard sees it: it is cancelled through `signal`. */
export type GuardedRun<Value> = (signal: AbortSignal) => Promise<Value>;

/** Cancel a long provider/tool wait as soon as the storage check fails. */
export const guardStorage = async <Value>(
  execute: GuardedRun<Value>,
  signal: AbortSignal,
  check: () => Promise<void>,
  abort: () => void,
): Promise<Value> => {
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
    const value = await execute(AbortSignal.any([signal, controller.signal]));
    if (pressure !== undefined) throw pressure;
    return value;
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
