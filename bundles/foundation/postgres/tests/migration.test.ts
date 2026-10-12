import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestServices } from 'bundle';
import { StorageBackendV1 } from 'bundle/contracts';

import { createPostgres } from '../src/testing.js';
import {
  createTestDatabase,
  skipWithoutDatabase,
  type TestDatabase,
} from './support/database.js';

// The generic-storage migration converts the configuration rows into the
// `host-config.configuration/v1` settings document without loss (the SQL
// side of evidence K-1), refuses data it cannot convert, and leaves the
// generic tables ready for `storage.backend/v1`.

const generic = '20261009000000_generic_storage';
const settingsKey = {
  type: 'core.settings/v1',
  id: 'host-config.configuration/v1',
};
const generationKey = { type: 'core.settings-generation/v1', id: 'global' };

const gitId = '00000000-0000-4000-8000-0000000000a1';
const githubId = '00000000-0000-4000-8000-0000000000a2';
const openAiKey = '00000000-0000-4000-8000-0000000000a3';
const codexKey = '00000000-0000-4000-8000-0000000000a4';

// Frozen copy of what `agents/doric/src/lib/config/store.ts` (`fromStored`)
// read from these rows before this migration, up to the schema check, with
// the provider-kind facts of that day: every kind's secret field is `token`,
// and `openai` and `openrouter` keep a model list.
const listsModels = new Set(['openai', 'openrouter']);

interface LegacyConfiguration {
  readonly configuration: unknown;
  readonly revision: number;
  readonly updatedAt: string;
}

const legacyLoad = async (
  database: TestDatabase,
): Promise<LegacyConfiguration> => {
  const [stored] = await database.query<{
    revision: number;
    max_turns: number;
    max_tool_result_chars: number | null;
    tool_config: unknown;
    git_credential_id: string | null;
    github_credential_id: string | null;
    updated_at: Date;
  }>('SELECT * FROM "doric_configuration" WHERE "id" = 1');
  const providers = await database.query<{
    id: string;
    kind: string;
    field_values: Record<string, string>;
    credential_id: string | null;
    models: unknown;
  }>('SELECT * FROM "provider_configuration" WHERE "configuration_id" = 1');
  const models = await database.query<{
    role: string;
    provider_id: string;
    model: string;
    effort: string | null;
  }>('SELECT * FROM "model_configuration" WHERE "configuration_id" = 1');
  const execution = models.find(({ role }) => role === 'EXECUTION');

  assert.ok(stored !== undefined && execution !== undefined);

  return {
    configuration: {
      providers: providers
        .map((provider) => {
          const listed = Array.isArray(provider.models)
            ? provider.models
            : undefined;

          return {
            id: provider.id,
            kind: provider.kind,
            configuration: {
              ...provider.field_values,
              ...(provider.credential_id === null
                ? {}
                : { token: provider.credential_id }),
            },
            ...(listed !== undefined &&
            (listed.length > 0 || listsModels.has(provider.kind))
              ? { models: listed }
              : {}),
          };
        })
        .sort((left, right) => left.id.localeCompare(right.id)),
      models: {
        execution: {
          providerId: execution.provider_id,
          model: execution.model,
          ...(execution.effort === null ? {} : { effort: execution.effort }),
        },
      },
      execution: {
        maxTurns: stored.max_turns,
        ...(stored.max_tool_result_chars === null
          ? {}
          : { maxToolResultChars: stored.max_tool_result_chars }),
      },
      tools: stored.tool_config,
      ...(stored.git_credential_id === null
        ? {}
        : { gitCredentialId: stored.git_credential_id }),
      ...(stored.github_credential_id === null
        ? {}
        : { githubCredentialId: stored.github_credential_id }),
    },
    revision: stored.revision,
    updatedAt: stored.updated_at.toISOString(),
  };
};

/** The migrated document, its providers in the order the old load sorted them. */
const migrated = async (database: TestDatabase) => {
  const [settings] = await database.query<{
    revision: number;
    value: {
      version: string;
      updatedAt: string;
      generation: number;
      value: { providers: { id: string }[] };
    };
  }>(
    'SELECT "revision", "value" FROM "storage_document" WHERE "type" = $1 AND "id" = $2',
    [settingsKey.type, settingsKey.id],
  );

  assert.ok(settings !== undefined);

  const { value, ...entry } = settings.value;

  return {
    revision: settings.revision,
    entry,
    configuration: {
      ...value,
      providers: [...value.providers].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    },
  };
};

const migrationTest = (
  name: string,
  run: (database: TestDatabase) => Promise<void>,
) => {
  void test(name, { skip: skipWithoutDatabase }, async () => {
    const database = await createTestDatabase({ until: generic });

    try {
      await run(database);
    } finally {
      await database.close();
    }
  });
};

/** A rich configuration: every optional column set one way or the other. */
const seedRich = async (database: TestDatabase) => {
  await database.query(`
    INSERT INTO "credential" ("id", "kind", "name", "username", "email", "secret", "updated_at") VALUES
      ('${gitId}', 'GIT', 'me', 'Ada', 'ada@example.test', NULL, CURRENT_TIMESTAMP),
      ('${githubId}', 'API_TOKEN', 'github', NULL, NULL, 'v1:a:b:c', CURRENT_TIMESTAMP),
      ('${openAiKey}', 'API_TOKEN', 'openai', NULL, NULL, '', CURRENT_TIMESTAMP),
      ('${codexKey}', 'API_TOKEN', 'codex', NULL, NULL, '', CURRENT_TIMESTAMP);

    INSERT INTO "provider_configuration" ("configuration_id", "id", "kind", "field_values", "credential_id", "models") VALUES
      (1, 'Zeta', 'openai', '{"endpoint":"https://zeta.example.test/v1"}', '${openAiKey}',
        '[{"name":"z-1","reasonings":["low","high"],"defaultEffort":"high","mandatory":true},{"name":"z-2"}]'),
      (1, 'anonymous', 'openai', '{"endpoint":"https://local.example.test/v1"}', NULL, '[]'),
      (1, 'codex', 'codex', '{"endpoint":"https://codex.example.test","chatGptAccountId":"acct","fedramp":"false"}', '${codexKey}', '[]'),
      (1, 'codex-listing', 'codex', '{"endpoint":"https://codex.example.test"}', '${codexKey}', '[{"name":"stray"}]');

    UPDATE "model_configuration" SET "provider_id" = 'Zeta', "model" = 'z-1', "effort" = NULL
    WHERE "configuration_id" = 1 AND "role" = 'EXECUTION';

    UPDATE "doric_configuration" SET
      "revision" = 41,
      "max_turns" = 7,
      "max_tool_result_chars" = 12000,
      "tool_config" = '{"web":{"timeoutMs":"9000","userAgent":"doric"},"grep":{}}',
      "git_credential_id" = '${gitId}',
      "github_credential_id" = '${githubId}',
      "updated_at" = '2026-10-08T21:45:12.345Z'
    WHERE "id" = 1;
  `);
};

migrationTest(
  'the seeded configuration converts into its settings space unchanged',
  async (database) => {
    const legacy = await legacyLoad(database);

    await database.migrate(generic);

    const document = await migrated(database);

    assert.deepEqual(document.configuration, legacy.configuration);
    assert.equal(document.revision, legacy.revision);
    assert.deepEqual(document.entry, {
      version: '1.0.0',
      updatedAt: legacy.updatedAt,
      generation: legacy.revision,
    });
  },
);

migrationTest(
  'every optional value converts exactly as the previous store read it',
  async (database) => {
    await seedRich(database);

    const legacy = await legacyLoad(database);

    await database.migrate(generic);

    const document = await migrated(database);

    assert.deepEqual(document.configuration, legacy.configuration);
    assert.equal(document.revision, 41);
    assert.deepEqual(document.entry, {
      version: '1.0.0',
      updatedAt: '2026-10-08T21:45:12.345Z',
      generation: 41,
    });
  },
);

migrationTest(
  'the global settings generation starts at the revision, and the conversion is the first commit',
  async (database) => {
    await seedRich(database);
    await database.migrate(generic);

    const client = database.client();
    const postgres = createPostgres({
      environment: {},
      database: () => client.database,
    });
    const services = createTestServices({
      bundle: { id: 'migration-test' },
      provide: [postgres.storage],
    });

    try {
      const storage = services.services.use(StorageBackendV1);

      assert.deepEqual(await storage.get(generationKey), {
        ...generationKey,
        revision: 1,
        value: { generation: 41 },
      });
      assert.equal((await storage.get(settingsKey))?.revision, 41);
      assert.deepEqual(await storage.feed({ after: 0, limit: 10 }), {
        commits: [
          {
            position: 1,
            documents: [settingsKey, generationKey],
            streams: [],
            truncated: [],
            dropped: [],
          },
        ],
      });

      // The next write continues the revision and the feed.
      const { position } = await storage.commit({
        expect: [{ ...settingsKey, revision: 41 }],
        put: [{ ...settingsKey, value: { replaced: true } }],
      });

      assert.equal(position, 2);
      assert.equal((await storage.get(settingsKey))?.revision, 42);
    } finally {
      await services.dispose();
    }
  },
);

migrationTest(
  'the configuration tables and their role type are gone, the other tables stay',
  async (database) => {
    await database.migrate(generic);

    const tables = (
      await database.query<{ name: string }>(
        `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = current_schema() ORDER BY table_name`,
      )
    ).map(({ name }) => name);

    assert.deepEqual(tables, [
      'credential',
      'project',
      'storage_blob',
      'storage_commit',
      'storage_document',
      'storage_index_entry',
      'storage_meta',
      'storage_stream',
      'storage_stream_entry',
      'storage_truncation',
      'storage_type',
      'thread',
      'thread_event',
    ]);
    assert.deepEqual(
      await database.query(
        `SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = current_schema() AND t.typname = 'ModelRole'`,
      ),
      [],
    );

    // A credential is no longer held by any configuration row.
    await database.query('DELETE FROM "credential"');
  },
);

migrationTest(
  'a provider of an unknown kind stops the migration and changes nothing',
  async (database) => {
    await database.query(`
    INSERT INTO "provider_configuration" ("configuration_id", "id", "kind", "field_values", "credential_id", "models")
    VALUES (1, 'studio', 'lmstudio', '{}', NULL, '[]')`);

    const legacy = await legacyLoad(database);

    await assert.rejects(database.migrate(generic), {
      message:
        'A stored provider kind is not supported; replace it in the previous Doric version before applying this migration.',
    });
    await database.query('ROLLBACK');
    assert.deepEqual(await legacyLoad(database), legacy);
    assert.deepEqual(
      await database.query(
        `SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name LIKE 'storage_%'`,
      ),
      [],
    );
  },
);

migrationTest(
  'a configuration without its execution model stops the migration',
  async (database) => {
    await database.query('DELETE FROM "model_configuration"');
    await assert.rejects(database.migrate(generic), {
      message: 'Stored Doric model role is missing: EXECUTION',
    });
    await database.query('ROLLBACK');
    assert.equal(
      (await database.query('SELECT 1 FROM "doric_configuration"')).length,
      1,
    );
  },
);
