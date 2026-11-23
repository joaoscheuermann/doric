import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { TestDatabase } from './support/database.js';
import { postgresHarness } from './support/harness.js';
import { routedTest } from './support/router.js';

// T3.9: the host part "leaves every row it did not write byte for byte".
// Rows written before it (by today's kernel path and by raw SQL as 1.x and
// the previous credential store left them) are read through the router, new
// data is written beside them, and every seeded row is still text-equal;
// the only new rows are the ones the router's writes own. Skipped without
// DORIC_TEST_DATABASE_URL.

/** Each table with the key that orders its snapshot. */
const tables = {
  credential: '"id"',
  storage_meta: '"key"',
  storage_type: '"type"',
  storage_document: '"type", "id"',
  storage_index_entry: '"type", "index_name", "key", "document_id"',
  storage_stream: '"stream"',
  storage_stream_entry: '"stream", "sequence"',
  storage_commit: '"position"',
  storage_truncation: '"stream", "position"',
  storage_blob: '"hash"',
} as const;

type Table = keyof typeof tables;
type Snapshot = Record<Table, string[]>;

const snapshot = async (database: TestDatabase): Promise<Snapshot> => {
  const result = {} as Snapshot;

  for (const [table, order] of Object.entries(tables) as [Table, string][]) {
    result[table] = (
      await database.query<{ row: string }>(
        `SELECT row_to_json(t)::text AS "row" FROM "${table}" t ORDER BY ${order}`,
      )
    ).map(({ row }) => row);
  }

  return result;
};

interface Fixture {
  readonly key: string;
  readonly cases: readonly {
    readonly name: string;
    readonly plaintext: string;
    readonly envelope: string;
  }[];
}

const legacyEnvelopes = async (): Promise<Fixture> =>
  JSON.parse(
    await readFile(
      new URL('../../tests/fixtures/legacy-envelopes.json', import.meta.url),
      'utf8',
    ),
  ) as Fixture;

const note = 'test.note/v1';
const task = 'test.task/v1';
const third = 'test.third/v1';
const seededStream = 'test.log/seeded';
const newStream = 'test.log/new';
const identity = { hostId: '00000000-0000-4000-8000-0000000000b1', storageGeneration: 2 };

routedTest(
  'reading and writing through the router leaves every seeded row text-equal and adds only the rows of its writes',
  async ({ database, serve }) => {
    const { key, cases } = await legacyEnvelopes();

    // Seed through today's kernel path.
    const kernel = postgresHarness(database).open();
    let blob: string;

    try {
      await kernel.backend.declareType({
        type: note,
        indexes: [{ name: 'byTag', fields: ['tag'] }],
      });
      await kernel.backend.declareType({ type: task, indexes: [] });
      await kernel.backend.commit({
        put: [
          { type: note, id: 'n1', value: { tag: 'a', body: 'first' } },
          { type: note, id: 'n2', value: { tag: 'b', body: 'second' } },
          { type: task, id: 't1', value: { done: false, weight: 0.25 } },
        ],
        append: [{ stream: seededStream, events: [{ n: 1 }, { n: 2 }, { n: 3 }] }],
      });
      await kernel.backend.commit({
        truncate: { stream: seededStream, afterSequence: 1 },
      });
      blob = (await kernel.backend.putBlob(Buffer.from('seeded blob').toString('base64'))).hash;
    } finally {
      await kernel.dispose();
    }

    // Seed by raw SQL, as 1.x and the previous credential store wrote them.
    await database.query(
      `INSERT INTO "storage_document" ("type", "id", "revision", "value")
       VALUES ($1, 'legacy', 3, '{"z": 1, "a": 1.50, "n": 1e2, "nested": {"y": [2, 1.0]}}'::jsonb)`,
      [task],
    );
    await database.query('DELETE FROM "storage_meta" WHERE "key" = \'identity\'');
    await database.query(
      `INSERT INTO "storage_meta" ("key", "value") VALUES ('identity', $1::jsonb)`,
      [JSON.stringify(identity)],
    );

    // The migrations seed credentials of their own; only the legacy ones stay.
    await database.query('DELETE FROM "credential"');

    const legacy = cases.map((entry) => ({ ...entry, id: randomUUID() }));

    for (const row of legacy) {
      await database.query(
        'INSERT INTO "credential" ("id", "kind", "name", "secret", "updated_at") VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)',
        [row.id, 'API_TOKEN', `legacy-${row.name}`, row.envelope],
      );
    }

    const before = await snapshot(database);
    const { storage, secrets } = await serve({ DORIC_CREDENTIAL_KEY: key });

    // Read everything through the router.
    assert.deepEqual((await storage.get({ type: note, id: 'n1' }))?.value, {
      tag: 'a',
      body: 'first',
    });
    assert.deepEqual((await storage.get({ type: task, id: 'legacy' }))?.value, {
      z: 1,
      a: 1.5,
      n: 100,
      nested: { y: [2, 1] },
    });
    assert.deepEqual(
      (await storage.query({ type: note, index: 'byTag', equals: ['b'], limit: 10 })).items.map(
        ({ id }) => id,
      ),
      ['n2'],
    );
    assert.deepEqual(
      (await storage.read({ stream: seededStream, afterSequence: 0, limit: 10 })).entries.map(
        ({ value }) => value,
      ),
      [{ n: 1 }],
    );
    assert.equal(
      Buffer.from((await storage.getBlob(blob)) ?? '', 'base64').toString(),
      'seeded blob',
    );
    assert.ok(
      (await storage.feed({ after: 0, limit: 100 })).commits.some(({ truncated }) =>
        truncated.includes(seededStream),
      ),
      'the feed holds the seeded truncation commit',
    );
    assert.equal((await secrets.list()).length, legacy.length);

    for (const row of legacy) {
      assert.equal((await secrets.get(row.id))?.secret, row.plaintext);
    }

    // Write beside them: one commit with a new document and a new stream,
    // and one new credential.
    await storage.declareType({ type: third, indexes: [] });
    await storage.commit({
      put: [{ type: third, id: 'x', value: { fresh: true } }],
      append: [{ stream: newStream, events: [{ fresh: 1 }] }],
    });

    const credential = randomUUID();

    await secrets.put({ id: credential, kind: 'API_TOKEN', name: 'fresh', secret: 'new' });

    const after = await snapshot(database);
    const added: Partial<Record<Table, unknown[]>> = {};

    for (const table of Object.keys(tables) as Table[]) {
      const remaining = new Set(after[table]);

      for (const row of before[table]) {
        assert.ok(remaining.has(row), `${table}: a seeded row changed: ${row}`);
        remaining.delete(row);
      }

      if (remaining.size > 0) {
        added[table] = [...remaining].map((row) => JSON.parse(row) as unknown);
      }
    }

    const field = (table: Table, name: string) =>
      (added[table] ?? []).map((row) => (row as Record<string, unknown>)[name]);

    assert.deepEqual(Object.keys(added).sort(), [
      'credential',
      'storage_commit',
      'storage_document',
      'storage_stream',
      'storage_stream_entry',
      'storage_type',
    ]);
    assert.deepEqual(field('storage_type', 'type'), [third]);
    assert.deepEqual(
      (added.storage_document ?? []).map((row) => {
        const { type, id } = row as { type: string; id: string };

        return [type, id];
      }),
      [[third, 'x']],
    );
    assert.deepEqual(field('storage_stream', 'stream'), [newStream]);
    assert.deepEqual(field('storage_stream_entry', 'stream'), [newStream]);
    assert.equal(added.storage_commit?.length, 1);
    assert.deepEqual(field('credential', 'id'), [credential]);
  },
);
