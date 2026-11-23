import assert from 'node:assert/strict';

import type { StorageBackend } from 'bundle/contracts';

import { postgresHarness } from './support/harness.js';
import { routedTest } from './support/router.js';

// Values above one message cross the router in chunks and land in PostgreSQL
// as `createPostgres` writes them today (S38; T3.9). Skipped without
// DORIC_TEST_DATABASE_URL.

const MiB = 1_048_576;
const thread = 'test.thread/v1';
const utf8 = new TextEncoder();

/** A string of exactly `bytes` UTF-8 bytes with 1-, 2-, 3- and 4-byte characters. */
const multiByteText = (bytes: number): string => {
  const unit = 'aé€😀'; // 1 + 2 + 3 + 4 = 10 bytes

  return unit.repeat(Math.floor(bytes / 10)) + 'a'.repeat(bytes % 10);
};

const collect = async <T>(stream: AsyncIterable<T>): Promise<T[]> => {
  const items: T[] = [];

  for await (const item of stream) {
    items.push(item);
  }

  return items;
};

const declareThreads = (backend: StorageBackend) =>
  backend.declareType({
    type: thread,
    indexes: [{ name: 'byProject', fields: ['projectId', 'createdAt'] }],
  });

routedTest(
  'a 5 MiB document is committed in chunks, reads back whole and is stored as today',
  async ({ database, serve }) => {
    await postgresHarness(database).reset();

    const { storage, raw } = await serve();
    const body = multiByteText(5 * MiB + 17);

    assert.equal(utf8.encode(body).length, 5 * MiB + 17);

    const value = { projectId: 'p', createdAt: '1', body };

    await declareThreads(storage);
    await storage.commit({ put: [{ type: thread, id: 'big', value }] });

    assert.deepEqual(await storage.get({ type: thread, id: 'big' }), {
      type: thread,
      id: 'big',
      revision: 1,
      value,
    });
    assert.deepEqual(
      (
        await storage.query({
          type: thread,
          index: 'byProject',
          equals: ['p'],
          limit: 10,
        })
      ).items,
      [{ type: thread, id: 'big', revision: 1, value }],
    );

    const [first, ...rest] = await collect(
      raw.storage.get({ type: thread, id: 'big' }),
    );

    assert.equal(first?.item.case, 'document');
    assert.ok(rest.length >= 6, `expected at least 6 chunks, got ${rest.length}`);

    for (const { item } of rest) {
      assert.equal(item.case, 'chunk');
      assert.ok(
        item.case === 'chunk' &&
          item.value.length > 0 &&
          item.value.length <= MiB,
      );
    }

    // The same value written through today's kernel path stores the same JSONB.
    const kernel = postgresHarness(database).open();

    try {
      await kernel.backend.commit({
        put: [{ type: thread, id: 'kernel', value }],
      });
    } finally {
      await kernel.dispose();
    }

    const rows = await database.query<{ id: string; value: string }>(
      `SELECT "id", "value"::text AS "value" FROM "storage_document"
       WHERE "type" = $1 ORDER BY "id"`,
      [thread],
    );

    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.value, rows[1]?.value);
  },
);

routedTest(
  'a 2 MiB event is appended in chunks and reads back whole',
  async ({ serve }) => {
    const { storage } = await serve();
    const event = { text: multiByteText(2 * MiB + 5) };
    const stream = 'test.thread.events/t1';

    await storage.commit({ append: [{ stream, events: [event] }] });

    const page = await storage.read({ stream, afterSequence: 0, limit: 10 });

    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0]?.sequence, 1);
    assert.deepEqual(page.entries[0]?.value, event);
  },
);
