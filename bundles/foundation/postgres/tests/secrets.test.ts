import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { createTestServices } from 'bundle';
import { type SecretsBackend, SecretsBackendV1 } from 'bundle/contracts';

import { createPostgres } from '../src/testing.js';
import {
  createTestDatabase,
  skipWithoutDatabase,
  type TestDatabase,
} from './support/database.js';
import { isCode } from './support/storage.js';

// `secrets.backend/v1` on the `credential` table: what the previous
// credential store and cipher did, now behind the contract (stage-2
// evidence: credentials stay readable and keep their behavior; C-S2, C-S3).

/** 32 zero bytes, base64. A fixed test key, never a deployed one. */
const key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const otherKey = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';

const backendOver = (
  database: TestDatabase | undefined,
  environment: Record<string, string | undefined>,
): { secrets: SecretsBackend; dispose(): Promise<void> } => {
  const postgres = createPostgres({
    environment,
    database: () => {
      if (database === undefined) {
        throw new Error('This case must not reach the database.');
      }

      return database.client().database;
    },
  });
  const services = createTestServices({
    bundle: { id: 'secrets-test' },
    provide: [postgres.secrets],
  });

  return {
    secrets: services.services.use(SecretsBackendV1),
    dispose: () => services.dispose(),
  };
};

const databaseTest = (
  name: string,
  run: (database: TestDatabase) => Promise<void>,
) => {
  void test(name, { skip: skipWithoutDatabase }, async () => {
    const database = await createTestDatabase();

    try {
      // The migrations seed credentials of their own; these cases start empty.
      await database.query('DELETE FROM "credential"');
      await run(database);
    } finally {
      await database.close();
    }
  });
};

const storedSecret = async (database: TestDatabase, id: string) =>
  (
    await database.query<{ secret: string | null }>(
      'SELECT "secret" FROM "credential" WHERE "id" = $1',
      [id],
    )
  )[0]?.secret;

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

databaseTest(
  'stores an independently registered kind without a backend release',
  async (database) => {
    const { secrets, dispose } = backendOver(database, {
      DORIC_CREDENTIAL_KEY: key,
    });
    const record = {
      id: randomUUID(),
      kind: 'CUSTOM_LOGIN',
      name: 'custom',
      username: 'reader',
      secret: 'custom-private-value',
    };
    try {
      await secrets.put(record);
      assert.deepEqual(fields(await secrets.get(record.id)), record);
      assert.ok(
        !(await storedSecret(database, record.id))?.includes(record.secret),
      );
    } finally {
      await dispose();
    }
  },
);

void test('opening credential kinds preserves existing identifiers and encrypted bytes', {
  skip: skipWithoutDatabase,
}, async () => {
  const migration = '20261012000000_registered_credential_kinds';
  const database = await createTestDatabase({ until: migration });
  const { secrets, dispose } = backendOver(database, {
    DORIC_CREDENTIAL_KEY: key,
  });
  const record = {
    id: randomUUID(),
    kind: 'API_TOKEN',
    name: 'before-open-kinds',
    secret: 'migration-private-value',
  };
  try {
    await secrets.put(record);
    const encrypted = await storedSecret(database, record.id);
    await database.migrate(migration);
    assert.equal(await storedSecret(database, record.id), encrypted);
    assert.deepEqual(fields(await secrets.get(record.id)), record);
  } finally {
    await dispose();
    await database.close();
  }
});

databaseTest(
  'a credential written through the contract reads back in plaintext and is sealed at rest',
  async (database) => {
    const { secrets, dispose } = backendOver(database, {
      DORIC_CREDENTIAL_KEY: key,
    });

    try {
      const id = randomUUID();

      await secrets.put({
        id,
        kind: 'API_TOKEN',
        name: 'openrouter',
        secret: 'sk-live-value',
      });
      assert.deepEqual(fields(await secrets.get(id)), {
        id,
        kind: 'API_TOKEN',
        name: 'openrouter',
        secret: 'sk-live-value',
      });

      const sealed = await storedSecret(database, id);

      assert.match(sealed ?? '', /^v1:[^:]+:[^:]+:[^:]+$/);
      assert.ok(!(sealed ?? '').includes('sk-live-value'));

      // Each write seals with a fresh nonce.
      await secrets.put({
        id,
        kind: 'API_TOKEN',
        name: 'openrouter',
        secret: 'sk-live-value',
      });
      assert.notEqual(await storedSecret(database, id), sealed);

      const record = await secrets.get(id);

      assert.match(record?.createdAt ?? '', /Z$/);
      assert.equal(await secrets.get(randomUUID()), undefined);
    } finally {
      await dispose();
    }
  },
);

databaseTest(
  'absent fields stay absent, an empty secret stays empty, and a GIT identity holds none',
  async (database) => {
    const { secrets, dispose } = backendOver(database, {
      DORIC_CREDENTIAL_KEY: key,
    });

    try {
      const git = randomUUID();
      const empty = randomUUID();

      await secrets.put({
        id: git,
        kind: 'GIT',
        name: 'me',
        username: 'Ada',
        email: 'ada@example.test',
      });
      await secrets.put({
        id: empty,
        kind: 'API_TOKEN',
        name: 'unset',
        secret: '',
      });

      assert.deepEqual(fields(await secrets.get(git)), {
        id: git,
        kind: 'GIT',
        name: 'me',
        username: 'Ada',
        email: 'ada@example.test',
      });
      assert.deepEqual(fields(await secrets.get(empty)), {
        id: empty,
        kind: 'API_TOKEN',
        name: 'unset',
        secret: '',
      });
      assert.equal(await storedSecret(database, git), null);
      assert.equal(await storedSecret(database, empty), '');
    } finally {
      await dispose();
    }
  },
);

databaseTest(
  'a put is an upsert by ID that keeps the stored kind and clears removed fields',
  async (database) => {
    const { secrets, dispose } = backendOver(database, {
      DORIC_CREDENTIAL_KEY: key,
    });

    try {
      const id = randomUUID();

      await secrets.put({
        id,
        kind: 'USERNAME_PASSWORD',
        name: 'registry',
        username: 'robot',
        secret: 'pw',
      });
      await secrets.put({
        id,
        kind: 'API_TOKEN',
        name: 'renamed',
        secret: 'pw2',
      });
      assert.deepEqual(fields(await secrets.get(id)), {
        id,
        kind: 'USERNAME_PASSWORD',
        name: 'renamed',
        secret: 'pw2',
      });
    } finally {
      await dispose();
    }
  },
);

databaseTest(
  'names are unique per kind: a taken one is credential_name_taken',
  async (database) => {
    const { secrets, dispose } = backendOver(database, {
      DORIC_CREDENTIAL_KEY: key,
    });

    try {
      const first = randomUUID();
      const second = randomUUID();

      await secrets.put({
        id: first,
        kind: 'API_TOKEN',
        name: 'shared',
        secret: 'a',
      });
      await assert.rejects(
        secrets.put({
          id: second,
          kind: 'API_TOKEN',
          name: 'shared',
          secret: 'b',
        }),
        isCode('credential_name_taken'),
      );
      // Another kind may use the same name.
      await secrets.put({
        id: second,
        kind: 'GIT',
        name: 'shared',
        username: 'u',
        email: 'u@example.test',
      });

      // Renaming onto a taken name is refused too, and changes nothing.
      const third = randomUUID();

      await secrets.put({
        id: third,
        kind: 'API_TOKEN',
        name: 'third',
        secret: 'c',
      });
      await assert.rejects(
        secrets.put({
          id: third,
          kind: 'API_TOKEN',
          name: 'shared',
          secret: 'c',
        }),
        isCode('credential_name_taken'),
      );
      assert.equal((await secrets.get(third))?.name, 'third');
    } finally {
      await dispose();
    }
  },
);

databaseTest(
  'list returns every credential ordered by name, decrypted',
  async (database) => {
    const { secrets, dispose } = backendOver(database, {
      DORIC_CREDENTIAL_KEY: key,
    });

    try {
      for (const name of ['beta', 'alpha', 'gamma']) {
        await secrets.put({
          id: randomUUID(),
          kind: 'API_TOKEN',
          name,
          secret: `${name}-secret`,
        });
      }

      assert.deepEqual(
        (await secrets.list()).map(({ name, secret }) => [name, secret]),
        [
          ['alpha', 'alpha-secret'],
          ['beta', 'beta-secret'],
          ['gamma', 'gamma-secret'],
        ],
      );
    } finally {
      await dispose();
    }
  },
);

databaseTest(
  'delete answers deleted once and missing afterwards',
  async (database) => {
    const { secrets, dispose } = backendOver(database, {
      DORIC_CREDENTIAL_KEY: key,
    });

    try {
      const id = randomUUID();

      await secrets.put({ id, kind: 'API_TOKEN', name: 'gone', secret: 'x' });
      assert.equal(await secrets.delete(id), 'deleted');
      assert.equal(await secrets.delete(id), 'missing');
      assert.equal(await secrets.get(id), undefined);
    } finally {
      await dispose();
    }
  },
);

databaseTest(
  'without a key, a stored secret refuses every read but empty or absent secrets stay readable',
  async (database) => {
    const sealed = backendOver(database, { DORIC_CREDENTIAL_KEY: key });
    const id = randomUUID();
    const identity = randomUUID();

    try {
      await sealed.secrets.put({
        id: identity,
        kind: 'GIT',
        name: 'me',
        username: 'u',
        email: 'u@example.test',
      });
      await sealed.secrets.put({
        id: randomUUID(),
        kind: 'API_TOKEN',
        name: 'blank',
        secret: '',
      });
    } finally {
      await sealed.dispose();
    }

    const keyless = backendOver(database, {});

    try {
      assert.deepEqual(
        (await keyless.secrets.list()).map(({ name, secret }) => [
          name,
          secret,
        ]),
        [
          ['blank', ''],
          ['me', undefined],
        ],
      );

      // Any secret, even an empty one, needs the key to be stored.
      await assert.rejects(
        keyless.secrets.put({ id, kind: 'API_TOKEN', name: 'new', secret: '' }),
        isCode('credential_storage_unavailable'),
      );
      await assert.rejects(
        keyless.secrets.put({
          id,
          kind: 'API_TOKEN',
          name: 'new',
          secret: 'x',
        }),
        (error: Error) =>
          error.message ===
          'DORIC_CREDENTIAL_KEY is required to store a credential secret.',
      );
      // A credential without a secret is still writable.
      await keyless.secrets.put({
        id: identity,
        kind: 'GIT',
        name: 'me2',
        username: 'u',
        email: 'u@example.test',
      });
    } finally {
      await keyless.dispose();
    }

    const writer = backendOver(database, { DORIC_CREDENTIAL_KEY: key });

    try {
      await writer.secrets.put({
        id,
        kind: 'API_TOKEN',
        name: 'held',
        secret: 'x',
      });
    } finally {
      await writer.dispose();
    }

    const refused = backendOver(database, { DORIC_CREDENTIAL_KEY: '  ' });

    try {
      for (const read of [
        () => refused.secrets.list(),
        () => refused.secrets.get(id),
      ]) {
        await assert.rejects(read(), (error: Error) => {
          isCode('credential_key_required')(error);
          assert.equal(
            error.message,
            'DORIC_CREDENTIAL_KEY is required while a stored credential holds a secret.',
          );

          return true;
        });
      }

      // The identity without a secret still reads alone.
      assert.equal((await refused.secrets.get(identity))?.name, 'me2');
    } finally {
      await refused.dispose();
    }
  },
);

databaseTest(
  'a secret sealed under another key or tampered with is credential_unreadable',
  async (database) => {
    const id = randomUUID();
    const writer = backendOver(database, { DORIC_CREDENTIAL_KEY: key });

    try {
      await writer.secrets.put({
        id,
        kind: 'API_TOKEN',
        name: 'sealed',
        secret: 'value',
      });
    } finally {
      await writer.dispose();
    }

    const other = backendOver(database, { DORIC_CREDENTIAL_KEY: otherKey });

    try {
      await assert.rejects(
        other.secrets.list(),
        isCode('credential_unreadable'),
      );
    } finally {
      await other.dispose();
    }

    const envelope = (await storedSecret(database, id)) ?? '';
    const [prefix, nonce, tag, ciphertext] = envelope.split(':');
    const flipped = Buffer.from(tag ?? '', 'base64');

    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    await database.query(
      'UPDATE "credential" SET "secret" = $1 WHERE "id" = $2',
      [[prefix, nonce, flipped.toString('base64'), ciphertext].join(':'), id],
    );

    const reader = backendOver(database, { DORIC_CREDENTIAL_KEY: key });

    try {
      await assert.rejects(
        reader.secrets.get(id),
        isCode('credential_unreadable'),
      );
      await database.query(
        'UPDATE "credential" SET "secret" = $1 WHERE "id" = $2',
        ['v2:not-an-envelope', id],
      );
      await assert.rejects(reader.secrets.list(), (error: Error) => {
        isCode('credential_unreadable')(error);
        assert.equal(
          error.message,
          'A stored credential secret is not a supported envelope.',
        );

        return true;
      });
    } finally {
      await reader.dispose();
    }
  },
);

void test('a malformed key refuses every call before the database is reached', async () => {
  for (const malformed of ['short', 'AAAA', `${key}A`]) {
    const { secrets, dispose } = backendOver(undefined, {
      DORIC_CREDENTIAL_KEY: malformed,
    });

    try {
      for (const call of [
        () => secrets.list(),
        () => secrets.get(randomUUID()),
        () =>
          secrets.put({
            id: randomUUID(),
            kind: 'API_TOKEN',
            name: 'x',
            secret: 'y',
          }),
      ]) {
        await assert.rejects(call(), {
          message: 'DORIC_CREDENTIAL_KEY must be 32 base64-encoded bytes.',
        });
      }
    } finally {
      await dispose();
    }
  }
});
