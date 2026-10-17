import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createTestServices } from 'bundle';
import { SecretsBackendV1 } from 'bundle/contracts';

import { createPostgres } from '../src/testing.js';
import { createTestDatabase, skipWithoutDatabase } from './support/database.js';

// Stage-2 evidence C-S1: credentials written by the previous store stay
// readable through `secrets.backend/v1`. The fixture's envelopes were sealed
// by the pre-move `agents/doric/src/lib/credentials/secret.ts` and are
// inserted exactly as that store left them, after every migration ran.

interface Fixture {
  readonly key: string;
  readonly cases: readonly {
    readonly name: string;
    readonly plaintext: string;
    readonly envelope: string;
  }[];
}

const fixture = async (): Promise<Fixture> =>
  JSON.parse(
    await readFile(
      new URL('../../tests/fixtures/legacy-envelopes.json', import.meta.url),
      'utf8',
    ),
  ) as Fixture;

void test('envelopes sealed by the previous store read back unchanged, and reading never rewrites them', {
  skip: skipWithoutDatabase,
}, async () => {
  const { key, cases } = await fixture();
  const database = await createTestDatabase();

  try {
    await database.query('DELETE FROM "credential"');

    const rows = cases.map((entry) => ({ ...entry, id: randomUUID() }));

    for (const row of rows) {
      await database.query(
        'INSERT INTO "credential" ("id", "kind", "name", "secret", "updated_at") VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)',
        [row.id, 'API_TOKEN', `legacy-${row.name}`, row.envelope],
      );
    }

    const postgres = createPostgres({
      environment: { DORIC_CREDENTIAL_KEY: key },
      database: () => database.client().database,
    });
    const services = createTestServices({
      bundle: { id: 'legacy-test' },
      provide: [postgres.secrets],
    });

    try {
      const secrets = services.services.use(SecretsBackendV1);
      const listed = await secrets.list();

      assert.deepEqual(
        listed.map(({ name, secret }) => [name, secret]),
        rows
          .map(({ name, plaintext }) => [`legacy-${name}`, plaintext])
          .sort(([left], [right]) => ((left ?? '') < (right ?? '') ? -1 : 1)),
      );

      for (const row of rows) {
        assert.equal((await secrets.get(row.id))?.secret, row.plaintext);
      }

      const stored = await database.query<{ id: string; secret: string }>(
        'SELECT "id", "secret" FROM "credential"',
      );

      assert.deepEqual(
        new Map(stored.map(({ id, secret }) => [id, secret])),
        new Map(rows.map(({ id, envelope }) => [id, envelope])),
      );
    } finally {
      await services.dispose();
    }
  } finally {
    await database.close();
  }
});
