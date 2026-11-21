import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDatabaseHandle,
  unmigratedReason,
} from '../src/host/database.js';
import {
  createTestDatabase,
  skipWithoutDatabase,
  type TestDatabase,
} from './support/database.js';

// The drop migration removes the legacy `project`, `thread` and
// `thread_event` tables, with the function and the enums only they use, once
// stage 7 has emptied them. It refuses, and changes nothing, while one of
// them still holds a row; and the startup check refuses such a database with
// or without the stage-7 marker (T10.1 to T10.3).

const stage7 = '20261010000000_runtime_documents';
const drop = '20261117000000_drop_legacy_runtime_tables';
const legacyTables = ['project', 'thread', 'thread_event'];

const projectId = '00000000-0000-4000-8000-0000000000d1';
const credentialId = '00000000-0000-4000-8000-0000000000d2';

const dropTest = (
  name: string,
  until: string | undefined,
  body: (database: TestDatabase) => Promise<void>,
) => {
  void test(name, { skip: skipWithoutDatabase }, async () => {
    const database = await createTestDatabase(
      until === undefined ? {} : { until },
    );

    try {
      await body(database);
    } finally {
      await database.close();
    }
  });
};

const tables = async (database: TestDatabase): Promise<string[]> =>
  (
    await database.query<{ name: string }>(
      `SELECT "tablename" AS "name" FROM "pg_tables"
       WHERE "schemaname" = current_schema() ORDER BY "tablename"`,
    )
  ).map(({ name }) => name);

const presentLegacyTables = async (
  database: TestDatabase,
): Promise<string[]> => {
  const present: string[] = [];

  for (const table of legacyTables) {
    const [row] = await database.query<{ present: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS "present"',
      [table],
    );

    if (row?.present === true) {
      present.push(table);
    }
  }

  return present;
};

const legacyTypes = async (database: TestDatabase) =>
  database.query(
    `SELECT "typname" FROM "pg_type" t
     JOIN "pg_namespace" n ON n."oid" = t."typnamespace"
     WHERE n."nspname" = current_schema()
       AND t."typname" IN ('ProjectState', 'ThreadState')`,
  );

const legacyFunctions = async (database: TestDatabase) =>
  database.query(
    `SELECT "proname" FROM "pg_proc" p
     JOIN "pg_namespace" n ON n."oid" = p."pronamespace"
     WHERE n."nspname" = current_schema() AND p."proname" = 'guard_thread_tree'`,
  );

const hasMarker = async (database: TestDatabase): Promise<boolean> =>
  (
    await database.query(
      `SELECT 1 FROM "storage_document"
       WHERE "type" = 'runtime.migration/v1' AND "id" = 'legacy-prisma'`,
    )
  ).length === 1;

const insertProject = (database: TestDatabase) =>
  database.query(
    `INSERT INTO "project"
       ("id", "name", "config_revision", "config_snapshot", "updated_at")
     VALUES ($1, 'Left behind', 1, '{}'::jsonb, '2026-11-01T00:00:00.000Z')`,
    [projectId],
  );

const connect = (database: TestDatabase) => {
  const client = database.client();

  return createDatabaseHandle({
    environment: {},
    database: () => client.database,
  }).connect();
};

dropTest(
  'the migration drops the empty legacy tables, their function and enums, and nothing else',
  drop,
  async (database) => {
    assert.ok(await hasMarker(database));
    assert.deepEqual(await presentLegacyTables(database), legacyTables);

    await database.query(
      `INSERT INTO "credential" ("id", "kind", "name", "updated_at")
       VALUES ($1, 'test', 'kept', '2026-11-01T00:00:00.000Z')`,
      [credentialId],
    );
    await database.query(
      `INSERT INTO "storage_document" ("type", "id", "revision", "value")
       VALUES ('test.kept/v1', 'one', 3, '{"kept":true}'::jsonb)`,
    );

    const before = await tables(database);
    const credentials = await database.query(
      'SELECT * FROM "credential" ORDER BY "id"',
    );
    const documents = await database.query(
      'SELECT * FROM "storage_document" ORDER BY "type", "id"',
    );

    await database.migrate(drop);

    assert.deepEqual(await presentLegacyTables(database), []);
    assert.deepEqual(await legacyTypes(database), []);
    assert.deepEqual(await legacyFunctions(database), []);
    assert.deepEqual(
      await tables(database),
      before.filter((table) => !legacyTables.includes(table)),
    );
    assert.deepEqual(
      await database.query('SELECT * FROM "credential" ORDER BY "id"'),
      credentials,
    );
    assert.deepEqual(
      await database.query(
        'SELECT * FROM "storage_document" ORDER BY "type", "id"',
      ),
      documents,
    );
  },
);

dropTest(
  'applied again where the tables are already gone, the migration changes nothing',
  undefined,
  async (database) => {
    const before = await tables(database);

    await database.migrate(drop);

    assert.deepEqual(await tables(database), before);
    assert.deepEqual(await presentLegacyTables(database), []);
  },
);

dropTest(
  'one legacy row aborts the migration and leaves all three tables and the row',
  drop,
  async (database) => {
    await insertProject(database);

    await assert.rejects(database.migrate(drop), {
      message: /^Legacy table "project" holds 1 rows/u,
    });
    await database.query('ROLLBACK');

    assert.deepEqual(await presentLegacyTables(database), legacyTables);
    assert.deepEqual(
      await database.query<{ id: string }>('SELECT "id" FROM "project"'),
      [{ id: projectId }],
    );
  },
);

dropTest(
  'connecting refuses a legacy row before stage 7',
  stage7,
  async (database) => {
    await insertProject(database);

    await assert.rejects(connect(database), { message: unmigratedReason });
  },
);

dropTest(
  'connecting refuses a legacy row even with the stage-7 marker',
  drop,
  async (database) => {
    assert.ok(await hasMarker(database));
    await insertProject(database);

    await assert.rejects(connect(database), { message: unmigratedReason });
  },
);

dropTest('connecting accepts empty legacy tables', drop, async (database) => {
  assert.deepEqual(await presentLegacyTables(database), legacyTables);

  await assert.doesNotReject(connect(database));
});

dropTest(
  'connecting accepts a database without the legacy tables',
  undefined,
  async (database) => {
    assert.deepEqual(await presentLegacyTables(database), []);

    await assert.doesNotReject(connect(database));
  },
);
