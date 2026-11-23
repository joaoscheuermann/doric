import { after } from 'node:test';

import { runStorageConformance } from 'storage/conformance';

import {
  createTestDatabase,
  skipWithoutDatabase,
  type TestDatabase,
} from './support/database.js';
import { postgresRouterHarness, type RouterInstance } from './support/router.js';

// T3.9, AC3.11: the whole conformance kit of `storage/conformance` against
// this bundle's `storage.backend/v1` served through the router as `main.ts`
// serves it, every instance with its own client over one migrated test
// schema. Skipped without DORIC_TEST_DATABASE_URL.

const database: TestDatabase | undefined =
  skipWithoutDatabase === false ? await createTestDatabase() : undefined;

after(() => database?.close());

const harness =
  database === undefined ? undefined : postgresRouterHarness(database);

runStorageConformance<RouterInstance>(
  {
    name: 'postgres over router',
    open: async (options) => {
      if (harness === undefined) {
        throw new Error(skipWithoutDatabase || 'No test database.');
      }

      return harness.open(options);
    },
    reset: async () => harness?.reset(),
    crash: async (instance) => harness?.crash(instance),
    close: async (instance) => harness?.close(instance),
  },
  { skip: skipWithoutDatabase },
);
