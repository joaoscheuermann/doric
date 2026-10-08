import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { createConfigStore } from '../src/lib/config/store.js';
import {
  migrationDirectory,
  persistenceFixture,
} from './helpers/persistence-fixture.js';

const connectionString = process.env.DORIC_TEST_DATABASE_URL;
const consolidation = '20261008000000_consolidate_providers';
const migration = () =>
  readFile(`${migrationDirectory}/${consolidation}/migration.sql`, 'utf8');
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
    const before = await resources.database.providerConfiguration.findMany();
    const execution = await resources.database.modelConfiguration.findMany();
    const credentials = await resources.database.credential.findMany();

    await resources.migrate(await migration());

    const after = await resources.database.providerConfiguration.findMany();
    for (const old of before) {
      const updated = after.find(({ id }) => id === old.id);
      assert.ok(updated);
      assert.equal(updated.credentialId, old.credentialId);
      assert.deepEqual(updated.fieldValues, old.fieldValues);
      assert.deepEqual(updated.models, old.models);
      assert.equal(
        updated.kind,
        old.id === 'responses-custom' ? 'openai' : 'openrouter',
      );
    }
    assert.deepEqual(
      await resources.database.modelConfiguration.findMany(),
      execution,
    );
    assert.deepEqual(
      await resources.database.credential.findMany(),
      credentials,
    );
    const loaded = await createConfigStore(resources.database).load();
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
      assert.equal(
        (await resources.database.providerConfiguration.findFirstOrThrow())
          .kind,
        kind,
      );
    } finally {
      await resources.close();
    }
  });
}
