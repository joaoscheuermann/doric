import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { recordActivation, stageBundles } from 'bundle';
import { SecretsBackendV1, StorageBackendV1 } from 'bundle/contracts';

import { PostgresDatabaseV1 } from '../src/contracts/index.js';
import { activate } from '../src/host/index.js';
import { postgresEmbedded } from '../src/testing.js';
import { createTestDatabase, skipWithoutDatabase } from './support/database.js';
import { bootHost } from './support/host.js';

// Evidence C-A: activation, including the build's dry activation, opens no
// database, so the host connects at its own startup stage; and C-I: the
// storage identity reaches the catalog.

const bundleRoot = fileURLToPath(new URL('../..', import.meta.url));
const variables = [
  'DORIC_DATABASE_URL',
  'DORIC_CREDENTIAL_KEY',
  'DORIC_STORAGE_PATH',
] as const;

/** Runs with the bundle's environment variables unset, then restores them. */
const withoutEnvironment = async (run: () => Promise<void>) => {
  const saved = variables.map((name) => [name, process.env[name]] as const);

  for (const name of variables) {
    delete process.env[name];
  }

  try {
    await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
};

void test('the dry activation records the three services without a database', async () => {
  await withoutEnvironment(async () => {
    const manifest = JSON.parse(
      await readFile(join(bundleRoot, 'manifest.json'), 'utf8'),
    );
    const recorded = await recordActivation({
      manifest,
      environment: 'host',
      activate,
    });

    assert.deepEqual(
      recorded.map(({ id, kind }) => [id, kind]),
      [
        ['storage.backend/v1', 'service'],
        ['secrets.backend/v1', 'service'],
        ['postgres.database/v1', 'service'],
      ],
    );
  });
});

void test('the installed bundle boots as the chosen foundation without a database URL and fails only when connected', async () => {
  await withoutEnvironment(async () => {
    // Staged inside the package, so the bundle resolves its dependencies.
    const staging = await mkdtemp(join(bundleRoot, 'dist-tests', 'staged-'));

    try {
      await stageBundles(staging, [bundleRoot]);

      const { platform, close } = await bootHost({
        foundation: 'postgres',
        bundlesPath: staging,
      });

      try {
        assert.equal(platform.mode, 'normal');
        assert.deepEqual(
          platform.catalog().bundles.find(({ id }) => id === 'postgres')?.state,
          'active',
        );

        const database = platform.services.use(PostgresDatabaseV1);

        await assert.rejects(database.connect(), {
          message: 'DORIC_DATABASE_URL is required.',
        });
        await assert.rejects(platform.storageIdentity(), {
          message: 'DORIC_DATABASE_URL is required.',
        });
        assert.equal(platform.catalog().storage, undefined);

        // Health measures the filesystem only, so it answers without one.
        assert.equal(
          (await platform.services.use(StorageBackendV1).health()).status,
          'ok',
        );
      } finally {
        await close();
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
});

void test('over a database, the identity is published in the catalog and stays the same across boots', {
  skip: skipWithoutDatabase,
}, async () => {
  const database = await createTestDatabase();
  const client = database.client();

  try {
    const boot = () =>
      bootHost({
        foundation: 'postgres',
        embedded: [
          postgresEmbedded({
            environment: {},
            database: () => client.database,
          }),
        ],
      });
    const first = await boot();
    let identity: unknown;

    try {
      await first.platform.services.use(PostgresDatabaseV1).connect();
      identity = await first.platform.storageIdentity();
      assert.deepEqual(first.platform.catalog().storage, identity);
      assert.deepEqual(
        await first.platform.services.use(StorageBackendV1).identity(),
        identity,
      );
      // The secrets backend shares the client: the migrations' credentials
      // read back (their secrets are empty, so no key is needed).
      assert.ok(
        (await first.platform.services.use(SecretsBackendV1).list()).length > 0,
      );
    } finally {
      await first.close();
    }

    const second = await boot();

    try {
      assert.deepEqual(await second.platform.storageIdentity(), identity);
    } finally {
      await second.close();
    }
  } finally {
    await database.close();
  }
});
