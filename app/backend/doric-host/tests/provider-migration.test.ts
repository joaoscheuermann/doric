import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import type { Database } from 'postgres/prisma';

import { legacyLoad } from './helpers/legacy-config-load.js';
import {
  migrationDirectory,
  persistenceFixture,
} from './helpers/persistence-fixture.js';

const connectionString = process.env.DORIC_TEST_DATABASE_URL;
const consolidation = '20261008000000_consolidate_providers';
const migration = () =>
  readFile(`${migrationDirectory}/${consolidation}/migration.sql`, 'utf8');
interface ProviderRow {
  readonly id: string;
  readonly kind: string;
  readonly field_values: unknown;
  readonly credential_id: string | null;
  readonly models: unknown;
}

// The configuration tables left the generated client with the move to a
// settings space, so this migration, which predates it, is read with raw SQL.
const providerRows = (database: Database) =>
  database.$queryRaw<ProviderRow[]>`
    SELECT id, kind, field_values, credential_id::text AS credential_id, models
    FROM provider_configuration`;
const modelRows = (database: Database) =>
  database.$queryRaw<unknown[]>`
    SELECT configuration_id, role::text AS role, provider_id, model, effort
    FROM model_configuration`;

const previousMigrations = async () => {
  const directories = (await readdir(migrationDirectory))
    .filter((name) => name < consolidation)
    .sort();
  return (
    await Promise.all(
      directories.map((name) =>
        readFile(`${migrationDirectory}/${name}/migration.sql`, 'utf8'),
      ),
    )
  ).join('\n');
};

void test('migrates supported providers without changing identities, credentials or execution choices', {
  skip: connectionString === undefined,
}, async () => {
  assert.ok(connectionString);
  const resources = await persistenceFixture(connectionString, {
    migration: previousMigrations,
  });
  try {
    await resources.database.$executeRaw`
      INSERT INTO provider_configuration (configuration_id, id, kind, field_values, credential_id, models)
      SELECT configuration_id, 'router-custom', 'unified',
        '{"modelsUrl":"https://catalog.example.test/models","maxStructuredOutputRepairs":"1"}'::jsonb,
        credential_id, '[{"name":"my-model","reasonings":["low"]}]'::jsonb
      FROM provider_configuration WHERE id = 'openrouter'`;
    await resources.database.$executeRaw`
      INSERT INTO provider_configuration (configuration_id, id, kind, field_values, credential_id, models)
      SELECT configuration_id, 'responses-custom', 'openai-compatible',
        '{"endpoint":"https://responses.example.test/v1"}'::jsonb,
        credential_id, '[]'::jsonb
      FROM provider_configuration WHERE id = 'openrouter'`;
    const before = await providerRows(resources.database);
    const execution = await modelRows(resources.database);
    const credentials = await resources.database.credential.findMany();

    await resources.migrate(await migration());

    const after = await providerRows(resources.database);
    for (const old of before) {
      const updated = after.find(({ id }) => id === old.id);
      assert.ok(updated);
      assert.equal(updated.credential_id, old.credential_id);
      assert.deepEqual(updated.field_values, old.field_values);
      assert.deepEqual(updated.models, old.models);
      assert.equal(
        updated.kind,
        old.id === 'responses-custom' ? 'openai' : 'openrouter',
      );
    }
    assert.deepEqual(await modelRows(resources.database), execution);
    assert.deepEqual(
      await resources.database.credential.findMany(),
      credentials,
    );
    const loaded = await legacyLoad(resources.database);
    assert.equal(
      loaded.configuration.models.execution.providerId,
      'openrouter',
    );
    assert.deepEqual(
      loaded.configuration.providers.map(({ kind }) => kind),
      ['openrouter', 'openai', 'openrouter'],
    );
  } finally {
    await resources.close();
  }
});

for (const kind of ['lmstudio', 'lmstudio-openai']) {
  void test(`refuses to silently convert an existing ${kind} endpoint`, {
    skip: connectionString === undefined,
  }, async () => {
    assert.ok(connectionString);
    const resources = await persistenceFixture(connectionString, {
      migration: previousMigrations,
    });
    try {
      await resources.database.$executeRaw`
        UPDATE provider_configuration SET kind = ${kind} WHERE id = 'openrouter'`;
      await assert.rejects(
        resources.migrate(await migration()),
        /Replace LM Studio providers/,
      );
      await resources.migrate('ROLLBACK');
      assert.deepEqual(
        (await providerRows(resources.database)).map((row) => row.kind),
        [kind],
      );
    } finally {
      await resources.close();
    }
  });
}
