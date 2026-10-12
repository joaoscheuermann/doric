import { after } from 'node:test';

import { runStorageConformance } from 'storage/conformance';

import {
  createTestDatabase,
  skipWithoutDatabase,
  type TestDatabase,
} from './support/database.js';
import { type Instance, postgresHarness } from './support/harness.js';

// Stage-3 evidence on PostgreSQL: the whole conformance kit of
// `storage/conformance` against `storage.backend/v1` of this bundle, every
// instance with its own client over one migrated test schema. Skipped
// without DORIC_TEST_DATABASE_URL.

const database: TestDatabase | undefined =
  skipWithoutDatabase === false ? await createTestDatabase() : undefined;

after(() => database?.close());

const harness = database === undefined ? undefined : postgresHarness(database);

runStorageConformance<Instance>(
  {
    name: 'postgres',
    open: async (options) => {
      if (harness === undefined) {
        throw new Error(skipWithoutDatabase || 'No test database.');
      }

      return harness.open(options);
    },
    reset: async () => harness?.reset(),
    // The crash ends the client's pool without waiting for it.
    crash: async (instance) => harness?.crash(instance),
    // One schema serves every case, so a closed instance also releases
    // its connections instead of keeping them until the file ends.
    close: async (instance) => {
      await harness?.close(instance);
      await instance.client.database.$disconnect();
    },
  },
  { skip: skipWithoutDatabase },
);
