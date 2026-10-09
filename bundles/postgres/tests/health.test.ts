import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createTestServices } from 'bundle';
import { StorageBackendV1 } from 'bundle/contracts';

import { createPostgres, type PostgresOptions } from '../src/testing.js';

// Evidence C-H: `health()` reports the measurement of the filesystem at
// DORIC_STORAGE_PATH for the caller's own policy, reports an unmeasurable
// disk as unavailable, and never touches the database.

/** One backend instance whose `health()` can be asked repeatedly. */
const backendOf = (options: PostgresOptions) => {
  const postgres = createPostgres({
    ...options,
    database: () => {
      throw new Error('health must not reach the database');
    },
  });

  return createTestServices({
    bundle: { id: 'health-test' },
    provide: [postgres.storage],
  });
};

const healthOf = async (options: PostgresOptions) => {
  const services = backendOf(options);

  try {
    return await services.services.use(StorageBackendV1).health();
  } finally {
    await services.dispose();
  }
};

void test('the measurement is reported as numbers, at every scale the policy compares', async () => {
  for (const [blocks, bavail] of [
    [0n, 0n],
    [100n, 10n],
    [100n, 11n],
    [2n ** 40n, 2n ** 36n],
  ] as const) {
    assert.deepEqual(
      await healthOf({
        environment: {},
        statfs: () => Promise.resolve({ blocks, bavail }),
      }),
      {
        status: 'ok',
        writable: true,
        disk: { blocks: Number(blocks), availableBlocks: Number(bavail) },
      },
    );
  }
});

void test('an unmeasurable filesystem is unavailable and not writable, with no disk', async () => {
  assert.deepEqual(
    await healthOf({
      environment: {},
      statfs: () => Promise.reject(new Error('EACCES')),
    }),
    { status: 'unavailable', writable: false, reason: 'storage_unmeasurable' },
  );
  assert.deepEqual(
    await healthOf({
      environment: { DORIC_STORAGE_PATH: join(tmpdir(), 'missing', 'path') },
    }),
    { status: 'unavailable', writable: false, reason: 'storage_unmeasurable' },
  );
});

void test('the path is DORIC_STORAGE_PATH, read when the check runs, or the current directory', async () => {
  const measured: string[] = [];
  const environment: Record<string, string | undefined> = {};
  const statfs = (path: string) => {
    measured.push(path);

    return Promise.resolve({ blocks: 10n, bavail: 5n });
  };

  const services = backendOf({ environment, statfs });

  try {
    const storage = services.services.use(StorageBackendV1);

    await storage.health();
    environment.DORIC_STORAGE_PATH = '/var/lib/postgresql';
    await storage.health();
    assert.deepEqual(measured, ['.', '/var/lib/postgresql']);
  } finally {
    await services.dispose();
  }
});

void test('a real directory is measured', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'postgres-health-'));

  try {
    const health = await healthOf({
      environment: { DORIC_STORAGE_PATH: directory },
    });

    assert.equal(health.status, 'ok');
    assert.ok((health.disk?.blocks ?? 0) > 0);
    assert.ok(
      (health.disk?.availableBlocks ?? -1) <= (health.disk?.blocks ?? 0),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
