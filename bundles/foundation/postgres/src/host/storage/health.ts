import { statfs } from 'node:fs/promises';

import type { StorageHealth } from 'bundle/contracts';

import type { DiskMeasurement, Environment } from '../options.js';

const measure = (path: string): Promise<DiskMeasurement> =>
  statfs(path, { bigint: true });

/**
 * Measures the filesystem at `DORIC_STORAGE_PATH` (the current directory by
 * default), read when the check runs. It makes no database round trip, so a
 * database outage is never reported as low storage. The 10 % policy belongs
 * to the caller (decision S-4).
 */
export const health = async (
  environment: Environment,
  read: (path: string) => Promise<DiskMeasurement> = measure,
): Promise<StorageHealth> => {
  try {
    const disk = await read(environment.DORIC_STORAGE_PATH ?? '.');

    return {
      status: 'ok',
      writable: true,
      disk: {
        blocks: Number(disk.blocks),
        availableBlocks: Number(disk.bavail),
      },
    };
  } catch {
    return {
      status: 'unavailable',
      writable: false,
      reason: 'storage_unmeasurable',
    };
  }
};
