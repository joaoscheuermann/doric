import assert from 'node:assert/strict';

import { isContractError } from 'bundle/contracts';

import { unmigratedReason } from '../src/host/database.js';
import { routedTest } from './support/router.js';

// `Connect` through the router (S38; decision G2): it logs its two startup
// lines through the instance's context, records no startup stage, and a
// database still holding legacy rows refuses it as `internal` with the
// unmigrated message. Skipped without DORIC_TEST_DATABASE_URL.

const drop = '20261117000000_drop_legacy_runtime_tables';

const lines = (logs: readonly { readonly level: string; readonly message: string }[]) =>
  logs.map(({ level, message }) => [level, message]);

routedTest(
  'on a migrated schema Connect resolves and logs both startup lines in order',
  async ({ serve }) => {
    const served = await serve();

    await served.storage.connect();

    assert.deepEqual(lines(served.logs), [
      ['info', 'Initializing PostgreSQL client'],
      ['info', 'PostgreSQL client initialized'],
    ]);
  },
);

routedTest(
  'a schema holding a legacy project row refuses Connect as internal, after only the first line',
  async ({ database, serve }) => {
    await database.query(
      `INSERT INTO "project"
         ("id", "name", "config_revision", "config_snapshot", "updated_at")
       VALUES ('00000000-0000-4000-8000-0000000000c1', 'Left behind', 1,
               '{}'::jsonb, '2026-11-01T00:00:00.000Z')`,
    );

    const served = await serve();

    await assert.rejects(served.storage.connect(), (error: unknown) => {
      assert.ok(isContractError(error), `expected a ContractError: ${error}`);
      assert.equal(error.code, 'internal', error.message);
      assert.equal(error.message, unmigratedReason);

      return true;
    });
    assert.deepEqual(lines(served.logs), [
      ['info', 'Initializing PostgreSQL client'],
    ]);
  },
  { until: drop },
);
