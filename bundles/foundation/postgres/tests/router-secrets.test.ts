import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import type { TestDatabase } from './support/database.js';
import { type RoutedContext, routedTest } from './support/router.js';
import { isCode } from './support/storage.js';

// `secrets.backend/v1` through the router as `main.ts` serves it (S38;
// T3.9): the behavior of `secrets.test.ts` holds over the wire, its error
// codes included. Skipped without DORIC_TEST_DATABASE_URL.

/** 32 zero bytes, base64. A fixed test key, never a deployed one. */
const key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const otherKey = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';

/** A test over an empty `credential` table (the migrations seed some). */
const secretsTest = (
  name: string,
  run: (context: RoutedContext) => Promise<void>,
) =>
  routedTest(name, async (context) => {
    await context.database.query('DELETE FROM "credential"');
    await run(context);
  });

const fields = (record: object | undefined) => {
  if (record === undefined) {
    return undefined;
  }

  const {
    createdAt: _created,
    updatedAt: _updated,
    ...rest
  } = record as Record<string, unknown>;

  return rest;
};

const storedSecret = async (database: TestDatabase, id: string) =>
  (
    await database.query<{ secret: string | null }>(
      'SELECT "secret" FROM "credential" WHERE "id" = $1',
      [id],
    )
  )[0]?.secret;

secretsTest(
  'a put is an upsert by ID, listed by name and read back in plaintext; an unknown ID is undefined',
  async ({ serve }) => {
    const { secrets } = await serve({ DORIC_CREDENTIAL_KEY: key });
    const id = randomUUID();

    await secrets.put({ id, kind: 'API_TOKEN', name: 'beta', secret: 'one' });
    await secrets.put({ id: randomUUID(), kind: 'API_TOKEN', name: 'alpha', secret: 'two' });
    await secrets.put({ id, kind: 'API_TOKEN', name: 'gamma', secret: 'three' });

    assert.deepEqual(
      (await secrets.list()).map(({ name, secret }) => [name, secret]),
      [
        ['alpha', 'two'],
        ['gamma', 'three'],
      ],
    );
    assert.deepEqual(fields(await secrets.get(id)), {
      id,
      kind: 'API_TOKEN',
      name: 'gamma',
      secret: 'three',
    });
    assert.equal(await secrets.get(randomUUID()), undefined);
  },
);

secretsTest(
  'an update drops the fields it leaves out: they come back absent, not undefined',
  async ({ serve }) => {
    const { secrets } = await serve({ DORIC_CREDENTIAL_KEY: key });
    const id = randomUUID();

    await secrets.put({
      id,
      kind: 'USERNAME_PASSWORD',
      name: 'registry',
      username: 'robot',
      secret: 'pw',
    });
    await secrets.put({ id, kind: 'USERNAME_PASSWORD', name: 'registry', secret: 'pw2' });

    const record = await secrets.get(id);

    assert.deepEqual(fields(record), {
      id,
      kind: 'USERNAME_PASSWORD',
      name: 'registry',
      secret: 'pw2',
    });
    assert.equal(Object.hasOwn(record ?? {}, 'username'), false);
  },
);

secretsTest(
  'a name taken within a kind crosses as credential_name_taken',
  async ({ serve }) => {
    const { secrets } = await serve({ DORIC_CREDENTIAL_KEY: key });

    await secrets.put({ id: randomUUID(), kind: 'API_TOKEN', name: 'shared', secret: 'a' });
    await assert.rejects(
      secrets.put({ id: randomUUID(), kind: 'API_TOKEN', name: 'shared', secret: 'b' }),
      isCode('credential_name_taken'),
    );
  },
);

secretsTest(
  'without a key, writing a secret is credential_storage_unavailable and reading a stored one credential_key_required',
  async ({ serve }) => {
    const sealed = await serve({ DORIC_CREDENTIAL_KEY: key });
    const id = randomUUID();

    await sealed.secrets.put({ id, kind: 'API_TOKEN', name: 'held', secret: 'x' });

    const keyless = await serve({});

    await assert.rejects(
      keyless.secrets.put({ id: randomUUID(), kind: 'API_TOKEN', name: 'new', secret: 'y' }),
      isCode('credential_storage_unavailable'),
    );
    await assert.rejects(keyless.secrets.list(), isCode('credential_key_required'));
    await assert.rejects(keyless.secrets.get(id), isCode('credential_key_required'));
  },
);

secretsTest(
  'a secret sealed under another key, or tampered with, crosses as credential_unreadable',
  async ({ database, serve }) => {
    const writer = await serve({ DORIC_CREDENTIAL_KEY: key });
    const id = randomUUID();

    await writer.secrets.put({ id, kind: 'API_TOKEN', name: 'sealed', secret: 'value' });

    const other = await serve({ DORIC_CREDENTIAL_KEY: otherKey });

    await assert.rejects(other.secrets.list(), isCode('credential_unreadable'));

    const [prefix, nonce, tag, ciphertext] = ((await storedSecret(database, id)) ?? '').split(':');
    const flipped = Buffer.from(tag ?? '', 'base64');

    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    await database.query('UPDATE "credential" SET "secret" = $1 WHERE "id" = $2', [
      [prefix, nonce, flipped.toString('base64'), ciphertext].join(':'),
      id,
    ]);

    await assert.rejects(writer.secrets.get(id), isCode('credential_unreadable'));
  },
);

secretsTest(
  'delete answers deleted once and missing afterwards',
  async ({ serve }) => {
    const { secrets } = await serve({ DORIC_CREDENTIAL_KEY: key });
    const id = randomUUID();

    await secrets.put({ id, kind: 'API_TOKEN', name: 'gone', secret: 'x' });

    assert.equal(await secrets.delete(id), 'deleted');
    assert.equal(await secrets.delete(id), 'missing');
    assert.equal(await secrets.get(id), undefined);
  },
);
