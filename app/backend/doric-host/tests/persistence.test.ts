import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { type ConfigInput, defaultConfig } from 'host-config/testing';

import {
  migrationDirectory,
  persistenceFixture,
} from './helpers/persistence-fixture.js';
import { kernelOver } from './helpers/platform.js';

const connectionString = process.env.DORIC_TEST_DATABASE_URL;
const promptId = randomUUID();
const gitCredentialId = '00000000-0000-4000-8000-000000000003';
const githubCredentialId = '00000000-0000-4000-8000-000000000004';

void test('ships the baseline followed by every incremental migration', async () => {
  assert.deepEqual((await readdir(migrationDirectory)).sort(), [
    '20260825000000_initial',
    '20260826000000_add_project_thread_names',
    '20260827000000_add_thread_checkpoints',
    '20260923000000_add_project_color',
    '20260924000000_add_github_credentials',
    '20260925000000_add_credential_store',
    '20260926000000_add_provider_kinds',
    '20260927000000_provider_models_and_identity',
    '20260930000000_drop_upstream_model',
    '20260930010000_optional_execution_effort',
    '20260930020000_add_tool_config',
    '20260930030000_thread_result',
    '20260930040000_tool_output_limit',
    '20260930050000_thread_cwd',
    '20261005000000_thread_usage',
    '20261006000000_thread_queue_pause',
    '20261008000000_consolidate_providers',
    '20261009000000_generic_storage',
    '20261010000000_runtime_documents',
    '20261012000000_registered_credential_kinds',
    '20261021000000_coalesce_thread_deltas',
    '20261117000000_drop_legacy_runtime_tables',
    'migration_lock.toml',
  ]);
  assert.deepEqual(
    await readdir(`${migrationDirectory}/20260825000000_initial`),
    ['migration.sql'],
  );
  const sql = await readFile(
    `${migrationDirectory}/20260825000000_initial/migration.sql`,
    'utf8',
  );
  assert.doesNotMatch(sql, /session/iu);
  const naming = await readFile(
    `${migrationDirectory}/20260826000000_add_project_thread_names/migration.sql`,
    'utf8',
  );
  assert.match(naming, /ADD COLUMN "name" TEXT;/u);
  assert.match(naming, /UPDATE "project" SET "name"/u);
  assert.match(naming, /UPDATE "thread" SET "name"/u);
  assert.match(naming, /ALTER COLUMN "name" SET NOT NULL/u);
  const checkpoints = await readFile(
    `${migrationDirectory}/20260827000000_add_thread_checkpoints/migration.sql`,
    'utf8',
  );
  assert.match(
    checkpoints,
    /ADD COLUMN "checkpoints" JSONB NOT NULL DEFAULT '\{\}';/u,
  );
  const color = await readFile(
    `${migrationDirectory}/20260923000000_add_project_color/migration.sql`,
    'utf8',
  );
  assert.match(color, /ADD COLUMN "color" TEXT;/u);
  const github = await readFile(
    `${migrationDirectory}/20260924000000_add_github_credentials/migration.sql`,
    'utf8',
  );
  assert.match(github, /ADD COLUMN "github_email" TEXT,/u);
  assert.match(github, /ADD COLUMN "github_token" TEXT,/u);
  assert.match(github, /ADD COLUMN "github_username" TEXT;/u);
  const store = await readFile(
    `${migrationDirectory}/20260925000000_add_credential_store/migration.sql`,
    'utf8',
  );
  assert.match(
    store,
    /CREATE TYPE "CredentialKind" AS ENUM \('API_TOKEN', 'USERNAME_PASSWORD', 'GIT'\);/u,
  );
  assert.match(store, /CREATE TABLE "credential"/u);
  assert.match(store, /ADD COLUMN "git_credential_id" UUID,/u);
  assert.match(store, /ADD COLUMN "credential_id" UUID;/u);
  // Every legacy column is dropped only after its value is carried over.
  const drop = store.indexOf('DROP COLUMN "github_username"');
  assert.ok(drop > store.indexOf('INSERT INTO "credential"'));
  assert.match(store, /DROP COLUMN "api_key_env";/u);

  const kinds = await readFile(
    `${migrationDirectory}/20260926000000_add_provider_kinds/migration.sql`,
    'utf8',
  );
  assert.match(kinds, /ADD COLUMN "kind" TEXT,/u);
  assert.match(kinds, /ADD COLUMN "field_values" JSONB,/u);
  assert.match(kinds, /ADD COLUMN "model_ids" TEXT\[\],/u);
  assert.match(kinds, /ADD COLUMN "reasoning_efforts" TEXT\[\];/u);
  // Every existing provider row is described by the kind it was built as before
  // its base URL goes.
  assert.ok(
    kinds.indexOf("'openai-compatible'") <
      kinds.indexOf('DROP COLUMN "base_url"'),
  );
  assert.match(kinds, /ALTER COLUMN "credential_id" DROP NOT NULL/u);

  const models = await readFile(
    `${migrationDirectory}/20260927000000_provider_models_and_identity/migration.sql`,
    'utf8',
  );
  assert.match(models, /ADD COLUMN "models" JSONB NOT NULL DEFAULT '\[\]';/u);
  // Each model id becomes one object whose efforts are the old provider list,
  // and the identity keys leave `field_values` before the arrays go.
  assert.ok(
    models.indexOf('jsonb_agg') < models.indexOf('DROP COLUMN "model_ids"'),
  );
  assert.match(models, /- 'identityId' - 'identityName'/u);
  assert.match(models, /DROP COLUMN "reasoning_efforts";/u);

  const cwd = await readFile(
    `${migrationDirectory}/20260930050000_thread_cwd/migration.sql`,
    'utf8',
  );
  // Every Thread that predates the column keeps the workspace root it ran in.
  assert.match(cwd, /ADD COLUMN "cwd" TEXT NOT NULL DEFAULT '\/workspace',/u);
  assert.match(cwd, /ADD COLUMN "cwd_repo" TEXT;/u);

  const dropLegacy = await readFile(
    `${migrationDirectory}/20261117000000_drop_legacy_runtime_tables/migration.sql`,
    'utf8',
  );
  // The drop is irreversible, runs in its own transaction, and refuses any
  // legacy row before it drops a table.
  assert.match(dropLegacy, /cannot be reversed/u);
  assert.match(dropLegacy, /^BEGIN;$/mu);
  assert.ok(dropLegacy.indexOf('BEGIN;') < dropLegacy.indexOf('DO $$'));
  assert.match(dropLegacy, /^COMMIT;\s*$/mu);
  assert.ok(dropLegacy.trimEnd().endsWith('COMMIT;'));
  assert.ok(dropLegacy.includes('RAISE EXCEPTION'));
  assert.ok(
    dropLegacy.indexOf('RAISE EXCEPTION') < dropLegacy.indexOf('DROP TABLE'),
  );
});

void test('upgrades existing related Project and Thread rows with names and data intact', {
  skip: connectionString === undefined,
}, async () => {
  assert.ok(connectionString);
  const baseline = await readFile(
    `${migrationDirectory}/20260825000000_initial/migration.sql`,
    'utf8',
  );
  const naming = await readFile(
    `${migrationDirectory}/20260826000000_add_project_thread_names/migration.sql`,
    'utf8',
  );
  const resources = await persistenceFixture(connectionString, {
    migration: async () => baseline,
  });
  const projectId = randomUUID();
  const rootId = randomUUID();
  const childId = randomUUID();
  try {
    await resources.database.$executeRaw`
        INSERT INTO project (
          id, state, config_revision, config_snapshot, updated_at, started_at
        ) VALUES (
          ${projectId}::uuid, 'READY', 7, '{"revision":7}'::jsonb,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )`;
    await resources.database.$executeRaw`
        INSERT INTO thread (
          id, project_id, state, messages, updated_at
        ) VALUES (
          ${rootId}::uuid, ${projectId}::uuid, 'READY',
          '[{"role":"user","content":"root history"}]'::jsonb,
          CURRENT_TIMESTAMP
        )`;
    await resources.database.$executeRaw`
        INSERT INTO thread (
          id, project_id, parent_thread_id, state, messages, active_prompt_id,
          last_sequence, updated_at, started_at
        ) VALUES (
          ${childId}::uuid, ${projectId}::uuid, ${rootId}::uuid, 'RUNNING',
          '[{"role":"user","content":"child history"}]'::jsonb,
          ${promptId}::uuid, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )`;
    await resources.database.$executeRaw`
        INSERT INTO thread_event (
          project_id, thread_id, prompt_id, sequence, type, event
        ) VALUES (
          ${projectId}::uuid, ${childId}::uuid, ${promptId}::uuid, 1,
          'prompt.accepted', '{"type":"prompt.accepted"}'::jsonb
        )`;

    await resources.migrate(naming);

    const projects = await resources.database.$queryRaw<
      {
        id: string;
        name: string;
        state: string;
        config_revision: number;
        config_snapshot: unknown;
      }[]
    >`SELECT id, name, state, config_revision, config_snapshot FROM project`;
    assert.deepEqual(projects, [
      {
        id: projectId,
        name: `Project ${projectId}`,
        state: 'READY',
        config_revision: 7,
        config_snapshot: { revision: 7 },
      },
    ]);
    const threads = await resources.database.$queryRaw<
      {
        id: string;
        project_id: string;
        parent_thread_id: string | null;
        name: string;
        state: string;
        messages: unknown;
        active_prompt_id: string | null;
        last_sequence: number;
      }[]
    >`SELECT id, project_id, parent_thread_id, name, state, messages,
          active_prompt_id, last_sequence
        FROM thread ORDER BY parent_thread_id NULLS FIRST`;
    assert.deepEqual(threads, [
      {
        id: rootId,
        project_id: projectId,
        parent_thread_id: null,
        name: `Thread ${rootId}`,
        state: 'READY',
        messages: [{ role: 'user', content: 'root history' }],
        active_prompt_id: null,
        last_sequence: 0,
      },
      {
        id: childId,
        project_id: projectId,
        parent_thread_id: rootId,
        name: `Thread ${childId}`,
        state: 'RUNNING',
        messages: [{ role: 'user', content: 'child history' }],
        active_prompt_id: promptId,
        last_sequence: 1,
      },
    ]);
    const [events] = await resources.database.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM thread_event`;
    assert.equal(events?.count, 1n);
    const columns = await resources.database.$queryRaw<
      { table_name: string; is_nullable: string }[]
    >`SELECT table_name, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND column_name = 'name'
          AND table_name IN ('project', 'thread')
        ORDER BY table_name`;
    assert.deepEqual(columns, [
      { table_name: 'project', is_nullable: 'NO' },
      { table_name: 'thread', is_nullable: 'NO' },
    ]);
    await assert.rejects(
      resources.database.$executeRaw`
          UPDATE project SET name = NULL WHERE id = ${projectId}::uuid`,
    );
  } finally {
    await resources.close();
  }
});

for (const failure of [
  'admin connect',
  'schema create',
  'sql connect',
  'migration read',
  'migration query',
] as const) {
  void test(`releases acquired database resources after ${failure} failure even if one close fails`, async () => {
    const open = new Set<string>();
    const schemas = new Set<string>();
    let clients = 0;
    const setupError = new Error(failure);
    await assert.rejects(
      persistenceFixture('postgresql://localhost/fixture', {
        connect: () => {
          const name = clients++ === 0 ? 'admin' : 'sql';
          open.add(name);
          return {
            connect: async () => {
              if (failure === `${name} connect`) throw setupError;
            },
            query: async (query: string) => {
              if (query.startsWith('CREATE SCHEMA')) {
                if (failure === 'schema create') throw setupError;
                schemas.add('owned');
              } else if (query.startsWith('DROP SCHEMA')) {
                schemas.delete('owned');
              } else if (failure === 'migration query') throw setupError;
              return { rows: [], command: '', rowCount: 0, oid: 0, fields: [] };
            },
            end: async () => {
              open.delete(name);
              if (name === 'sql')
                throw new Error(
                  'Close reported a failure after releasing connection',
                );
            },
          };
        },
        migration: async () => {
          if (failure === 'migration read') throw setupError;
          return 'baseline';
        },
      }),
    );
    assert.deepEqual(open, new Set());
    assert.deepEqual(schemas, new Set());
  });
}

void test('carries configured GitHub data and every provider into the credential store', {
  skip: connectionString === undefined,
}, async () => {
  assert.ok(connectionString);
  const baseline = await readFile(
    `${migrationDirectory}/20260825000000_initial/migration.sql`,
    'utf8',
  );
  const github = await readFile(
    `${migrationDirectory}/20260924000000_add_github_credentials/migration.sql`,
    'utf8',
  );
  const store = await readFile(
    `${migrationDirectory}/20260925000000_add_credential_store/migration.sql`,
    'utf8',
  );
  const resources = await persistenceFixture(connectionString, {
    migration: async () => `${baseline}\n${github}`,
  });
  try {
    await resources.database.$executeRaw`
        UPDATE doric_configuration SET
          github_username = 'octocat',
          github_email = 'octocat@example.com',
          github_token = 'ghp_legacy_plaintext'
        WHERE id = 1`;

    await resources.migrate(store);

    // The identity is carried value for value, the token keeps its row but not
    // its plaintext, and the provider keeps its own row under the old name.
    const credentials = await resources.database.$queryRaw<
      {
        kind: string;
        name: string;
        username: string | null;
        email: string | null;
        secret: string | null;
      }[]
    >`SELECT kind, name, username, email, secret FROM credential
        ORDER BY kind, name COLLATE "C"`;
    assert.deepEqual(credentials, [
      {
        kind: 'API_TOKEN',
        name: 'OPENROUTER_API_KEY',
        username: null,
        email: null,
        secret: '',
      },
      {
        kind: 'API_TOKEN',
        name: 'github',
        username: null,
        email: null,
        secret: '',
      },
      {
        kind: 'GIT',
        name: 'github',
        username: 'octocat',
        email: 'octocat@example.com',
        secret: null,
      },
    ]);
    assert.equal(
      JSON.stringify(credentials).includes('ghp_legacy_plaintext'),
      false,
    );

    const providers = await resources.database.$queryRaw<
      { id: string; credential_id: string }[]
    >`SELECT id, credential_id FROM provider_configuration`;
    assert.deepEqual(providers, [
      {
        id: 'openrouter',
        credential_id: '00000000-0000-4000-8000-000000000002',
      },
    ]);

    const configuration = await resources.database.$queryRaw<
      { git_credential_id: string; github_credential_id: string }[]
    >`SELECT git_credential_id, github_credential_id FROM doric_configuration`;
    assert.deepEqual(configuration, [
      {
        git_credential_id: '00000000-0000-4000-8000-000000000003',
        github_credential_id: '00000000-0000-4000-8000-000000000004',
      },
    ]);

    // The legacy columns are gone, and a referenced credential cannot go.
    await assert.rejects(
      resources.database
        .$queryRaw`SELECT api_key_env FROM provider_configuration`,
    );
    await assert.rejects(
      resources.database.$executeRaw`DELETE FROM credential
          WHERE id = '00000000-0000-4000-8000-000000000002'::uuid`,
    );
  } finally {
    await resources.close();
  }
});

void test('leaves an unconfigured GitHub block unconfigured', {
  skip: connectionString === undefined,
}, async () => {
  assert.ok(connectionString);
  const baseline = await readFile(
    `${migrationDirectory}/20260825000000_initial/migration.sql`,
    'utf8',
  );
  const github = await readFile(
    `${migrationDirectory}/20260924000000_add_github_credentials/migration.sql`,
    'utf8',
  );
  const store = await readFile(
    `${migrationDirectory}/20260925000000_add_credential_store/migration.sql`,
    'utf8',
  );
  const resources = await persistenceFixture(connectionString, {
    migration: async () => `${baseline}\n${github}`,
  });
  try {
    await resources.migrate(store);

    const credentials = await resources.database.credential.findMany({
      orderBy: { name: 'asc' },
    });
    assert.deepEqual(
      credentials.map(({ kind, name, secret }) => ({ kind, name, secret })),
      [{ kind: 'API_TOKEN', name: 'OPENROUTER_API_KEY', secret: '' }],
    );
    const [configuration] = await resources.database.$queryRaw<
      {
        git_credential_id: string | null;
        github_credential_id: string | null;
      }[]
    >`SELECT git_credential_id, github_credential_id FROM doric_configuration
        WHERE id = 1`;
    assert.equal(configuration?.git_credential_id, null);
    assert.equal(configuration?.github_credential_id, null);
  } finally {
    await resources.close();
  }
});

integrationTest(
  'installs a clean Project and Thread baseline without legacy tables or data',
  async ({ database, configs }) => {
    const tables = await database.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = current_schema() ORDER BY tablename`;
    assert.deepEqual(
      tables.map(({ tablename }) => tablename),
      [
        'credential',
        'storage_blob',
        'storage_commit',
        'storage_document',
        'storage_index_entry',
        'storage_meta',
        'storage_stream',
        'storage_stream_entry',
        'storage_truncation',
        'storage_type',
      ],
    );
    // The legacy tables' enums and trigger function leave with them.
    assert.deepEqual(
      await database.$queryRaw`
        SELECT t.typname FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = current_schema()
          AND t.typname IN ('ProjectState', 'ThreadState')`,
      [],
    );
    assert.deepEqual(
      await database.$queryRaw`
        SELECT p.proname FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = current_schema()
          AND p.proname = 'guard_thread_tree'`,
      [],
    );
    assert.deepEqual((await configs.load()).configuration, defaultConfig);
    // The configuration is still one singleton: its settings space.
    await assert.rejects(database.$executeRaw`
      INSERT INTO storage_document (type, id, revision, value)
      SELECT type, id, revision, value FROM storage_document
      WHERE type = 'core.settings/v1' AND id = 'host-config.configuration/v1'`);
  },
);

integrationTest(
  'encrypts a credential secret at rest and answers only whether it exists',
  async ({ credentials, database }) => {
    const created = await credentials.create({
      kind: 'API_TOKEN',
      name: 'openrouter',
      secret: 'sk_live_value',
    });
    assert.equal(created.status, 'saved');
    if (created.status !== 'saved') return;

    const row = await database.credential.findUniqueOrThrow({
      where: { id: created.credential.id },
    });
    assert.match(row.secret ?? '', /^v1:/u);
    assert.equal(row.secret?.includes('sk_live_value'), false);
    assert.deepEqual(credentials.secrets(), ['sk_live_value']);
  },
);

integrationTest(
  'refuses to serve a stored secret without the key that wrote it',
  async ({ credentials, database }) => {
    await credentials.create({
      kind: 'API_TOKEN',
      name: 'openrouter',
      secret: 'sk_live_value',
    });

    await assert.rejects(kernelOver(database, {}), {
      code: 'credential_key_required',
    });
  },
);

integrationTest(
  'keeps a credential a provider or the configuration references',
  async ({ credentials, configs }) => {
    // The seeded provider credential is referenced by the seeded provider.
    assert.equal(
      await credentials.remove(defaultConfig.providers[0].configuration.token),
      'referenced',
    );
    // A name a kind already uses is a conflict, not a second credential.
    assert.deepEqual(
      await credentials.create({
        kind: 'API_TOKEN',
        name: 'OPENROUTER_API_KEY',
        secret: 'sk_other',
      }),
      { status: 'conflict' },
    );

    const created = await credentials.create({
      kind: 'GIT',
      name: 'github',
      username: 'octocat',
      email: 'octocat@example.com',
    });
    assert.equal(created.status, 'saved');
    if (created.status !== 'saved') return;

    await configs.replace({
      ...defaultConfig,
      gitCredentialId: created.credential.id,
    });
    assert.equal(await credentials.remove(created.credential.id), 'referenced');

    // Clearing the choice releases it, so it can be deleted exactly once.
    await configs.replace(defaultConfig);
    assert.equal(await credentials.remove(created.credential.id), 'deleted');
    assert.equal(await credentials.remove(created.credential.id), 'missing');
  },
);

integrationTest(
  'round-trips the configured credential choices',
  async ({ credentials, configs }) => {
    const created = await credentials.create({
      kind: 'GIT',
      name: 'github',
      username: 'octocat',
      email: 'octocat@example.com',
    });
    assert.equal(created.status, 'saved');
    if (created.status !== 'saved') return;

    const configured = await configs.replace({
      ...defaultConfig,
      gitCredentialId: created.credential.id,
    });
    assert.equal(
      configured.configuration.gitCredentialId,
      created.credential.id,
    );
    assert.equal(
      (await configs.load()).configuration.gitCredentialId,
      created.credential.id,
    );

    const cleared = await configs.replace(defaultConfig);
    assert.equal(cleared.configuration.gitCredentialId, undefined);
  },
);

integrationTest(
  'round-trips configured providers of different kinds',
  async ({ credentials, configs }) => {
    const local = await credentials.create({
      kind: 'API_TOKEN',
      name: 'local',
      secret: 'sk_local',
    });
    assert.equal(local.status, 'saved');
    if (local.status !== 'saved') return;

    const configuration: ConfigInput = {
      ...structuredClone(defaultConfig),
      // The store answers providers in id order, so this one is written in it.
      providers: [
        {
          id: 'codex',
          kind: 'codex',
          configuration: {
            token: defaultConfig.providers[0].configuration.token,
            fedramp: 'true',
          },
        },
        {
          id: 'local',
          kind: 'openai',
          // A kind's list comes back even when this provider names no model yet.
          configuration: {},
          models: [],
        },
        {
          id: 'proxy',
          kind: 'openai',
          configuration: {
            token: local.credential.id,
          },
          models: [{ name: 'proxy-model', reasonings: ['low', 'high'] }],
        },
      ],
      models: {
        // A model a kind's list does not name is still a model the operator may
        // type, which is what an empty list leaves the execution section doing.
        execution: {
          providerId: 'local',
          model: 'local-model',
          effort: 'low',
        },
      },
    };

    const saved = await configs.replace(configuration);
    assert.deepEqual(saved.configuration.providers, configuration.providers);
    assert.deepEqual(
      (await configs.load()).configuration.providers,
      configuration.providers,
    );

    // A credential a provider names cannot go, and the one it does not can.
    assert.equal(await credentials.remove(local.credential.id), 'referenced');
    await configs.replace({
      ...configuration,
      providers: configuration.providers.filter(({ id }) => id !== 'proxy'),
    });
    assert.equal(await credentials.remove(local.credential.id), 'deleted');
  },
);

integrationTest(
  'carries a provider row the old host built into its kind',
  async ({ database, configs }) => {
    const [stored] = await database.$queryRaw<{ providers: unknown }[]>`
      SELECT value->'value'->'providers' AS providers FROM storage_document
      WHERE type = 'core.settings/v1' AND id = 'host-config.configuration/v1'`;

    assert.deepEqual(stored?.providers, [
      {
        id: 'openrouter',
        kind: 'openrouter',
        configuration: {
          endpoint: 'https://openrouter.ai/api/v1',
          // The credential reference is the row's own, untouched.
          token: '00000000-0000-4000-8000-000000000002',
        },
        models: [],
      },
    ]);
    assert.deepEqual((await configs.load()).configuration, defaultConfig);
  },
);

void test('converts a configured provider of the old shape without losing its data', {
  skip: connectionString === undefined,
}, async () => {
  assert.ok(connectionString);
  const baseline = await readFile(
    `${migrationDirectory}/20260825000000_initial/migration.sql`,
    'utf8',
  );
  const github = await readFile(
    `${migrationDirectory}/20260924000000_add_github_credentials/migration.sql`,
    'utf8',
  );
  const store = await readFile(
    `${migrationDirectory}/20260925000000_add_credential_store/migration.sql`,
    'utf8',
  );
  const kinds = await readFile(
    `${migrationDirectory}/20260926000000_add_provider_kinds/migration.sql`,
    'utf8',
  );
  const models = await readFile(
    `${migrationDirectory}/20260927000000_provider_models_and_identity/migration.sql`,
    'utf8',
  );
  const resources = await persistenceFixture(connectionString, {
    migration: async () => `${baseline}\n${github}\n${store}`,
  });
  try {
    // A host an operator has already used: a Git identity, a GitHub token, and
    // an execution model of their own.
    await resources.database.$executeRaw`
        INSERT INTO credential (id, kind, name, updated_at) VALUES
          ('00000000-0000-4000-8000-000000000003', 'GIT', 'github', CURRENT_TIMESTAMP),
          ('00000000-0000-4000-8000-000000000004', 'API_TOKEN', 'github', CURRENT_TIMESTAMP)`;
    await resources.database.$executeRaw`
        UPDATE doric_configuration SET
          git_credential_id = '00000000-0000-4000-8000-000000000003',
          github_credential_id = '00000000-0000-4000-8000-000000000004',
          max_turns = 100
        WHERE id = 1`;
    await resources.database.$executeRaw`
        UPDATE model_configuration SET model = 'stealth/space-bunny-alpha', effort = 'medium'
        WHERE configuration_id = 1 AND role = 'EXECUTION'`;

    // The provider-kind migration maps the old row; an operator has since named
    // two models that share one effort menu, which the next migration back-fills
    // onto each model.
    await resources.migrate(kinds);
    await resources.database.$executeRaw`
        UPDATE provider_configuration
        SET model_ids = ARRAY['stealth/space-bunny-alpha', 'other-model'],
            reasoning_efforts = ARRAY['low', 'high']
        WHERE configuration_id = 1 AND id = 'openrouter'`;
    await resources.migrate(models);

    const providers = await resources.database.$queryRaw<
      {
        id: string;
        kind: string;
        field_values: Record<string, string>;
        credential_id: string | null;
        models: { name: string; reasonings?: string[] }[];
      }[]
    >`SELECT id, kind, field_values, credential_id, models
        FROM provider_configuration`;
    assert.deepEqual(providers, [
      {
        id: 'openrouter',
        kind: 'openai-compatible',
        field_values: {
          endpoint: 'https://openrouter.ai/api/v1',
        },
        credential_id: '00000000-0000-4000-8000-000000000002',
        models: [
          { name: 'stealth/space-bunny-alpha', reasonings: ['low', 'high'] },
          { name: 'other-model', reasonings: ['low', 'high'] },
        ],
      },
    ]);

    // The current store reads today's schema. Finish the remaining migrations
    // before using it to verify that the converted data is still readable;
    // the configuration tables are checked before the generic storage one
    // replaces them. This schema skips the Project and Thread name columns, so
    // the stage-7 move of Projects and Threads, which needs them, is not applied.
    const generic = '20261009000000_generic_storage';
    const migrate = async (migration: string) =>
      resources.migrate(
        await readFile(
          `${migrationDirectory}/${migration}/migration.sql`,
          'utf8',
        ),
      );
    for (const migration of (await readdir(migrationDirectory)).sort()) {
      if (
        migration <= '20260927000000_provider_models_and_identity' ||
        migration >= generic
      )
        continue;
      await migrate(migration);
    }
    const [configuration] = await resources.database.$queryRaw<
      {
        git_credential_id: string;
        github_credential_id: string;
        max_turns: number;
        model: string;
      }[]
    >`SELECT c.git_credential_id::text AS git_credential_id,
             c.github_credential_id::text AS github_credential_id,
             c.max_turns, m.model
        FROM doric_configuration c
        JOIN model_configuration m ON m.configuration_id = c.id`;
    assert.equal(configuration?.git_credential_id, gitCredentialId);
    assert.equal(configuration?.github_credential_id, githubCredentialId);
    assert.equal(configuration?.max_turns, 100);
    assert.equal(configuration?.model, 'stealth/space-bunny-alpha');
    await assert.rejects(
      resources.database.$queryRaw`SELECT base_url FROM provider_configuration`,
    );
    await migrate(generic);

    // What `GET /config` answers afterwards: the mapped provider, and the
    // execution model, choices, and turn limit the operator had.
    const kernel = await kernelOver(resources.database);
    const loaded = await kernel.configs.load().finally(() => kernel.close());
    assert.deepEqual(loaded.configuration.providers, [
      {
        id: 'openrouter',
        kind: 'openrouter',
        configuration: {
          endpoint: 'https://openrouter.ai/api/v1',
          token: '00000000-0000-4000-8000-000000000002',
        },
        models: [
          { name: 'stealth/space-bunny-alpha', reasonings: ['low', 'high'] },
          { name: 'other-model', reasonings: ['low', 'high'] },
        ],
      },
    ]);
    assert.deepEqual(loaded.configuration.models.execution, {
      providerId: 'openrouter',
      model: 'stealth/space-bunny-alpha',
      effort: 'medium',
    });
    assert.equal(loaded.configuration.execution.maxTurns, 100);
    assert.equal(loaded.configuration.gitCredentialId, gitCredentialId);
    assert.equal(loaded.configuration.githubCredentialId, githubCredentialId);
  } finally {
    await resources.close();
  }
});

type Stores = Awaited<ReturnType<typeof fixture>>;

function integrationTest(name: string, run: (stores: Stores) => Promise<void>) {
  void test(name, { skip: connectionString === undefined }, async () => {
    const stores = await fixture();
    try {
      await run(stores);
    } finally {
      await stores.close();
    }
  });
}

async function fixture() {
  assert.ok(connectionString);
  const resources = await persistenceFixture(connectionString);
  const { database } = resources;
  try {
    const kernel = await kernelOver(database);
    return {
      ...resources,
      configs: kernel.configs,
      credentials: kernel.credentials,
      close: async () => {
        try {
          await kernel.close();
        } finally {
          await resources.close();
        }
      },
    };
  } catch (error) {
    await resources.close();
    throw error;
  }
}
