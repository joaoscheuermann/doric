import assert from 'node:assert/strict';
import test from 'node:test';

import { isContractError } from 'bundle/contracts';

import { unmigratedReason } from '../src/host/database.js';
import { routedTest, servePostgres } from './support/router.js';

// `Connect` through the router (S38; decision G2; S61b): it records the
// startup stage `database_client` and logs its two startup lines through
// `doric.startup/v1` (`hostStartup(context)`), both `info` with empty fields.
// A database still holding legacy rows, or a missing `DORIC_DATABASE_URL`,
// refuses it as `internal` with the bundle's message, after the stage and the
// first line only. The database cases skip without DORIC_TEST_DATABASE_URL.

const drop = '20261117000000_drop_legacy_runtime_tables';

const stage = ['stage', 'database_client'] as const;
const initializing = [
  'log',
  'info',
  'Initializing PostgreSQL client',
  {},
] as const;
const initialized = [
  'log',
  'info',
  'PostgreSQL client initialized',
  {},
] as const;

routedTest(
  'Connect records database_client, then logs Initializing PostgreSQL client before connecting and PostgreSQL client initialized after, both info with empty fields',
  async ({ serve }) => {
    const served = await serve();

    await served.storage.connect();

    assert.deepEqual(served.startup, [stage, initializing, initialized]);
  },
);

routedTest(
  'a database with legacy Project rows fails Connect as internal with unmigratedReason, after the stage and the first line only',
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
    assert.deepEqual(served.startup, [stage, initializing]);
  },
  { until: drop },
);

void test('with no DORIC_DATABASE_URL, Connect fails as internal DORIC_DATABASE_URL is required. after database_client and the first line', async (t) => {
  const served = await servePostgres({ environment: {} });

  t.after(() => served.dispose());

  await assert.rejects(served.storage.connect(), (error: unknown) => {
    assert.ok(isContractError(error), `expected a ContractError: ${error}`);
    assert.equal(error.code, 'internal', error.message);
    assert.equal(error.message, 'DORIC_DATABASE_URL is required.');

    return true;
  });
  assert.deepEqual(served.startup, [stage, initializing]);
});
