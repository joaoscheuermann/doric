import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import type { ConfigInput, DoricConfig } from 'host-config/testing';

import { legacyLoad, legacyReplace } from './helpers/legacy-config-load.js';
import {
  migrationDirectory,
  persistenceFixture,
} from './helpers/persistence-fixture.js';
import { kernelOver } from './helpers/platform.js';

// The configuration moved from its own tables into the `host-config` settings
// space. `GET /config` and `PUT /config` answer the stored configuration, so
// what the new store reads and writes must equal what the old one did, as
// strings: same values, same key order, same revision and update time.

const connectionString = process.env.DORIC_TEST_DATABASE_URL;
const generic = '20261009000000_generic_storage';

const migrationsBefore = async (): Promise<string> => {
  const names = (await readdir(migrationDirectory))
    .filter((name) => name !== 'migration_lock.toml' && name < generic)
    .sort();

  return (
    await Promise.all(
      names.map((name) =>
        readFile(`${migrationDirectory}/${name}/migration.sql`, 'utf8'),
      ),
    )
  ).join('\n');
};

const genericMigration = () =>
  readFile(`${migrationDirectory}/${generic}/migration.sql`, 'utf8');

const seeded = '00000000-0000-4000-8000-000000000002';
const proxyKey = '00000000-0000-4000-8000-0000000000a1';
const codexKey = '00000000-0000-4000-8000-0000000000a2';
const gitIdentity = '00000000-0000-4000-8000-0000000000a3';
const githubToken = '00000000-0000-4000-8000-0000000000a4';

/**
 * Credentials every case may reference (the old foreign keys need them), and
 * one update time, so the two schemas a case compares hold the same rows.
 */
const credentials = `
  UPDATE doric_configuration SET updated_at = '2026-09-30T08:00:00.123Z'
  WHERE id = 1;
  INSERT INTO credential (id, kind, name, username, email, secret, updated_at) VALUES
    ('${proxyKey}', 'API_TOKEN', 'proxy', NULL, NULL, '', CURRENT_TIMESTAMP),
    ('${codexKey}', 'API_TOKEN', 'codex', NULL, NULL, '', CURRENT_TIMESTAMP),
    ('${gitIdentity}', 'GIT', 'github', 'octocat', 'octocat@example.com', NULL, CURRENT_TIMESTAMP),
    ('${githubToken}', 'API_TOKEN', 'github', NULL, NULL, '', CURRENT_TIMESTAMP);`;

/** A replacement whose records arrive in neither jsonb nor ID order. */
const replacement: ConfigInput = {
  providers: [
    {
      id: 'zeta',
      kind: 'openai',
      configuration: { token: proxyKey, endpoint: 'https://z.example.test/v1' },
      models: [
        {
          name: 'z-model',
          reasonings: ['high', 'low'],
          defaultEffort: 'low',
          mandatory: true,
        },
      ],
    },
    {
      id: 'Zulu',
      kind: 'codex',
      configuration: {
        token: codexKey,
        fedramp: 'false',
        chatGptAccountId: 'account-1',
        endpoint: 'https://codex.example.test',
      },
    },
    {
      id: 'openrouter',
      kind: 'openrouter',
      configuration: {
        modelsUrl: 'https://openrouter.example.test/models',
        token: seeded,
        maxStructuredOutputRepairs: '2',
        endpoint: 'https://openrouter.example.test/api/v1',
      },
      models: [{ name: 'router/model', reasonings: [] }],
    },
    {
      id: 'alpha',
      kind: 'openai',
      configuration: {},
      models: [],
    },
  ],
  models: {
    execution: { providerId: 'zeta', model: 'z-model', effort: 'high' },
  },
  execution: { maxTurns: 12, maxToolResultChars: 9000 },
  tools: {
    'web-search': { timeoutSeconds: '30', mode: 'fast', a: 'x' },
    git: { token: githubToken, author: 'octocat' },
  },
  gitCredentialId: gitIdentity,
  githubCredentialId: githubToken,
};

const cases: readonly {
  readonly name: string;
  /** Raw SQL over the configuration tables as the previous release left them. */
  readonly seed: string;
}[] = [
  { name: 'the default seed', seed: '' },
  {
    name: 'providers of every kind, models of every shape, and no optional values',
    seed: `
      UPDATE provider_configuration SET
        field_values = '{"modelsUrl":"https://openrouter.example.test/models","maxStructuredOutputRepairs":"3","endpoint":"https://openrouter.example.test/api/v1"}',
        models = '[{"name":"router/a","reasonings":["low","medium"],"defaultEffort":"medium"},{"name":"router/b","reasonings":["high"],"mandatory":true},{"name":"router/c","reasonings":[]}]'
      WHERE id = 'openrouter';
      INSERT INTO provider_configuration (configuration_id, id, kind, field_values, credential_id, models) VALUES
        (1, 'zeta', 'openai', '{"endpoint":"https://z.example.test/v1"}', '${proxyKey}', '[{"name":"z-model","reasonings":["low"]}]'),
        (1, 'Zulu', 'codex', '{"fedramp":"true","endpoint":"https://codex.example.test","chatGptAccountId":"account-1"}', '${codexKey}', '[]'),
        (1, 'alpha', 'openai', '{}', NULL, '[]');
      UPDATE model_configuration SET provider_id = 'Zulu', model = 'gpt-codex', effort = NULL
      WHERE configuration_id = 1;
      UPDATE doric_configuration SET max_tool_result_chars = NULL, tool_config = '{}'
      WHERE id = 1;`,
  },
  {
    name: 'every optional choice set, a tool configuration and a later revision',
    seed: `
      UPDATE doric_configuration SET
        revision = 41,
        max_turns = 77,
        max_tool_result_chars = 5000,
        tool_config = '{"web-search":{"timeoutSeconds":"30","mode":"fast"},"a":{"zz":"1","b":"2"},"git":{"token":"${githubToken}"}}',
        git_credential_id = '${gitIdentity}',
        github_credential_id = '${githubToken}',
        updated_at = '2026-10-01T12:34:56.789Z'
      WHERE id = 1;
      UPDATE model_configuration SET model = 'router/model', effort = 'high'
      WHERE configuration_id = 1;`,
  },
];

/** The update time differs between two writes; everything else must not. */
const timeless = ({ updatedAt, ...rest }: DoricConfig) => {
  assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  return JSON.stringify({ ...rest, updatedAt: '<written>' });
};

/** A schema at the previous release with the case's rows. */
const previousRelease = async (seed: string) => {
  assert.ok(connectionString);
  const resources = await persistenceFixture(connectionString, {
    migration: migrationsBefore,
  });
  try {
    await resources.migrate(`${credentials}\n${seed}`);
    return resources;
  } catch (error) {
    await resources.close();
    throw error;
  }
};

for (const { name, seed } of cases)
  void test(`reads and replaces ${name} exactly as the previous store did`, {
    skip: connectionString === undefined,
  }, async () => {
    const old = await previousRelease(seed);
    const migrated = await previousRelease(seed);
    try {
      const legacy = await legacyLoad(old.database);
      const legacyReplaced = await legacyReplace(old.database, replacement);

      await migrated.migrate(await genericMigration());
      const kernel = await kernelOver(migrated.database);
      try {
        // GET /config after the upgrade, byte for byte.
        assert.equal(
          JSON.stringify(await kernel.configs.load()),
          JSON.stringify(legacy),
        );

        // PUT /config: the same body and the next revision.
        const replaced = await kernel.configs.replace(replacement);
        assert.equal(timeless(replaced), timeless(legacyReplaced));
        assert.equal(replaced.revision, legacy.revision + 1);
      } finally {
        await kernel.close();
      }

      // And the replacement reads back the same after a restart.
      const restarted = await kernelOver(migrated.database);
      try {
        assert.equal(
          timeless(await restarted.configs.load()),
          timeless(await legacyLoad(old.database)),
        );
      } finally {
        await restarted.close();
      }
    } finally {
      await migrated.close();
      await old.close();
    }
  });

void test('refuses to convert a provider kind it does not know', {
  skip: connectionString === undefined,
}, async () => {
  const resources = await previousRelease(`
    INSERT INTO provider_configuration (configuration_id, id, kind, field_values, credential_id, models)
    VALUES (1, 'studio', 'lmstudio', '{}', NULL, '[]');`);
  try {
    await assert.rejects(
      resources.migrate(await genericMigration()),
      /A stored provider kind is not supported/u,
    );
    await resources.migrate('ROLLBACK');
    // Nothing was converted or dropped: the rows are still the operator's.
    assert.deepEqual(
      await resources.database.$queryRaw`
        SELECT id, kind FROM provider_configuration ORDER BY id COLLATE "C"`,
      [
        { id: 'openrouter', kind: 'openrouter' },
        { id: 'studio', kind: 'lmstudio' },
      ],
    );
    assert.deepEqual(
      await resources.database.$queryRaw`
        SELECT count(*)::int AS documents FROM storage_document`.catch(
        () => 'no generic tables',
      ),
      'no generic tables',
    );
  } finally {
    await resources.close();
  }
});
