import assert from 'node:assert/strict';

import { routedTest } from './support/router.js';

// `storage.backend/v1.Identity` through the router (S38; spec section 17,
// "Storage until phase 4"): the first call creates the reserved record, every
// later call and every other process over the same database answers it, and
// a stored identity is answered as it is. Skipped without
// DORIC_TEST_DATABASE_URL.

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const identityRow = async (
  query: (text: string) => Promise<{ value: string }[]>,
) =>
  (
    await query(
      `SELECT "value"::text AS "value" FROM "storage_meta" WHERE "key" = 'identity'`,
    )
  ).map(({ value }) => value);

routedTest(
  'on an empty storage_meta the first Identity creates generation 1 with a UUID, and every later call and process answers the same pair',
  async ({ database, serve }) => {
    await database.query('DELETE FROM "storage_meta"');

    const first = await serve();
    const response = await first.raw.storage.identity({});
    const answered = {
      hostId: response.storageIdentity?.hostId,
      storageGeneration: response.storageIdentity?.storageGeneration,
    };

    assert.equal(answered.storageGeneration, 1);
    assert.match(answered.hostId ?? '', uuid);

    const again = await first.raw.storage.identity({});

    assert.deepEqual(
      {
        hostId: again.storageIdentity?.hostId,
        storageGeneration: again.storageIdentity?.storageGeneration,
      },
      answered,
    );

    const second = await serve();

    assert.deepEqual(await second.storage.identity(), answered);
  },
);

routedTest(
  'a stored identity is answered unchanged and its row stays byte-identical',
  async ({ database, serve }) => {
    // `host_id` is a UUID on the wire, so the seeded one is too.
    await database.query('DELETE FROM "storage_meta"');
    await database.query(
      `INSERT INTO "storage_meta" ("key", "value")
       VALUES ('identity', '{"hostId": "00000000-0000-4000-8000-0000000000a1", "storageGeneration": 3}'::jsonb)`,
    );

    const before = await identityRow((text) => database.query(text));
    const { storage } = await serve();

    assert.deepEqual(await storage.identity(), {
      hostId: '00000000-0000-4000-8000-0000000000a1',
      storageGeneration: 3,
    });
    assert.deepEqual(await identityRow((text) => database.query(text)), before);
  },
);
