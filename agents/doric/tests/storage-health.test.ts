import assert from 'node:assert/strict';
import test from 'node:test';

import { StorageV1 } from 'bundle/contracts';
import { postgresEmbedded } from 'postgres/testing';

import {
  checkDisk,
  checkStorageHealth,
  StoragePressureError,
} from '../src/lib/workspace/disk.js';
import { startPlatform, testFoundationId } from './helpers/platform.js';

// The low-storage gate now reads the `postgres` backend's measurement through
// `storage/v1.health`, and must refuse exactly where the direct `statfs` check
// always did.

type Measure = (path: string) => Promise<{ blocks: bigint; bavail: bigint }>;

const outcome = async (check: () => Promise<void>) => {
  try {
    await check();
    return 'ok';
  } catch (error) {
    assert.ok(error instanceof StoragePressureError);
    return 'pressure';
  }
};

const measurements: readonly {
  readonly name: string;
  readonly measure: Measure;
  readonly expected: 'ok' | 'pressure';
}[] = [
  {
    name: 'an empty filesystem',
    measure: async () => ({ blocks: 0n, bavail: 0n }),
    expected: 'pressure',
  },
  {
    name: 'exactly 10% free',
    measure: async () => ({ blocks: 100n, bavail: 10n }),
    expected: 'pressure',
  },
  {
    name: 'just above 10% free',
    measure: async () => ({ blocks: 100n, bavail: 11n }),
    expected: 'ok',
  },
  {
    name: 'a large volume with 1/16 free',
    measure: async () => ({ blocks: 2n ** 40n, bavail: 2n ** 36n }),
    expected: 'pressure',
  },
  {
    name: 'a large volume with half free',
    measure: async () => ({ blocks: 2n ** 40n, bavail: 2n ** 39n }),
    expected: 'ok',
  },
  {
    name: 'an unreadable mount',
    measure: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    expected: 'pressure',
  },
];

for (const { name, measure, expected } of measurements)
  void test(`refuses execution on ${name} exactly as the direct check does`, async () => {
    const paths: string[] = [];
    const booted = await startPlatform({
      foundation: postgresEmbedded({
        id: testFoundationId,
        environment: { DORIC_STORAGE_PATH: '/var/lib/doric' },
        // A database outage must never read as low storage, so no query runs.
        database: () => {
          throw new Error('The storage check reached the database.');
        },
        statfs: (path) => {
          paths.push(path);
          return measure(path);
        },
      }),
    });
    try {
      const storage = booted.platform.services.use(StorageV1);

      assert.equal(
        await outcome(() => checkDisk('/var/lib/doric', measure)),
        expected,
      );
      assert.equal(await outcome(() => checkStorageHealth(storage)), expected);
      assert.deepEqual(paths, ['/var/lib/doric']);
    } finally {
      await booted.close();
    }
  });

void test('a failing storage health call is pressure, not a crash', async () => {
  assert.equal(
    await outcome(() =>
      checkStorageHealth({
        health: async () => {
          throw new Error('storage provider is gone');
        },
      }),
    ),
    'pressure',
  );
  assert.equal(
    await outcome(() =>
      checkStorageHealth({
        health: async () => ({ status: 'ok', writable: true }),
      }),
    ),
    'pressure',
  );
});
