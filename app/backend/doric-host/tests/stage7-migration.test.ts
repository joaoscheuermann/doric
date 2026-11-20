import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { createTestServices } from 'bundle';
import { type StorageBackend, StorageBackendV1 } from 'bundle/contracts';
import { createPostgres, type Database } from 'postgres/testing';
import {
  historyType,
  migrationType,
  projectType,
  threadType,
} from 'runtime/contracts';

import {
  migrationDirectory,
  persistenceFixture,
} from './helpers/persistence-fixture.js';

// Stage 7 (design 57 §10): `prisma migrate deploy` moves the legacy Project,
// Thread, history and event rows into the runtime's storage/v1 documents and
// streams without loss, once. The legacy rows are inserted with SQL, and
// every expectation below is written from that seed.

const connectionString = process.env.DORIC_TEST_DATABASE_URL;
const stage7 = '20261010000000_runtime_documents';

const migrationsBefore = async (name: string): Promise<string> => {
  const entries = (await readdir(migrationDirectory))
    .filter((entry) => entry !== 'migration_lock.toml' && entry < name)
    .sort();
  const sql = await Promise.all(
    entries.map((entry) =>
      readFile(`${migrationDirectory}/${entry}/migration.sql`, 'utf8'),
    ),
  );
  return sql.join('\n');
};

const stage7Sql = () =>
  readFile(`${migrationDirectory}/${stage7}/migration.sql`, 'utf8');

/** A schema migrated up to, but not including, the stage-7 migration. */
const legacyFixture = async () => {
  assert.ok(connectionString);
  const before = await migrationsBefore(stage7);
  return persistenceFixture(connectionString, {
    migration: async () => before,
  });
};

const backendOver = (database: Database) => {
  const postgres = createPostgres({
    environment: {},
    database: () => database,
  });
  const services = createTestServices({
    bundle: { id: 'stage7-test' },
    provide: [postgres.storage],
  });
  return {
    storage: services.services.use(StorageBackendV1),
    dispose: () => services.dispose(),
  };
};

/** What the runtime's first boot does: declare its four types. */
const declareRuntimeTypes = async (storage: StorageBackend) => {
  for (const type of [projectType, threadType, historyType, migrationType]) {
    await storage.declareType({
      type: type.type,
      indexes: type.indexes.map((index) => ({
        name: index.name,
        fields: [...index.fields],
        ...(index.unique === undefined ? {} : { unique: index.unique }),
      })),
    });
  }
};

/** Every id of a query, page by page, as a list would walk it. */
const walk = async (
  storage: StorageBackend,
  query: { type: string; index: string; equals: (string | boolean)[] },
  limit: number,
): Promise<string[][]> => {
  const pages: string[][] = [];
  let cursor: string | undefined;
  do {
    const page = await storage.query({
      ...query,
      order: 'desc',
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (page.items.length > 0) pages.push(page.items.map(({ id }) => id));
    cursor = page.cursor;
  } while (cursor !== undefined);
  return pages;
};

const count = async (database: Database, table: string): Promise<number> => {
  const [row] = await database.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*) AS count FROM "${table}"`,
  );
  return Number(row?.count);
};

// The seed: four Projects (one without a color, one cancelled, one failed,
// two created at the same instant), four Threads (a tree of three and one
// alone), and five events, the root's with a gap where a rewind removed
// sequence 4.
const openProject = '00000000-0000-4000-8000-000000000a01';
const goneProject = '00000000-0000-4000-8000-000000000a02';
const brokenProject = '00000000-0000-4000-8000-000000000a03';
const queuedProject = '00000000-0000-4000-8000-000000000a04';
const laterProject = '00000000-0000-4000-8000-000000000a05';
const root = '00000000-0000-4000-8000-000000000b01';
const child = '00000000-0000-4000-8000-000000000b02';
const sibling = '00000000-0000-4000-8000-000000000b03';
const alone = '00000000-0000-4000-8000-000000000b04';
const promptA = '00000000-0000-4000-8000-000000000c01';
const promptB = '00000000-0000-4000-8000-000000000c02';
const promptC = '00000000-0000-4000-8000-000000000c03';

const seedSql = `
  INSERT INTO "project" (
    "id", "name", "color", "state", "config_revision", "config_snapshot",
    "error_code", "created_at", "updated_at", "started_at", "finished_at"
  ) VALUES
    ('${openProject}', 'Open', 'blue', 'READY', 2,
     '{"revision": 2, "providers": [{"id": "openrouter", "models": []}]}',
     NULL, '2026-10-01T10:00:00.000Z', '2026-10-01T10:05:00.000Z',
     '2026-10-01T10:00:30.000Z', NULL),
    ('${goneProject}', 'Gone', NULL, 'CANCELLED', 1, '{"revision": 1}',
     NULL, '2026-10-02T09:00:00.000Z', '2026-10-02T09:30:00.000Z',
     '2026-10-02T09:00:30.000Z', '2026-10-02T09:30:00.000Z'),
    ('${brokenProject}', 'Broken', 'red', 'FAILED', 3, '{"revision": 3}',
     'sandbox_unavailable', '2026-10-03T08:00:00.000Z',
     '2026-10-03T08:01:00.000Z', NULL, '2026-10-03T08:01:00.000Z'),
    ('${queuedProject}', 'Queued', 'green', 'QUEUED', 3, '{"revision": 3}',
     NULL, '2026-10-03T08:00:00.000Z', '2026-10-03T08:00:00.000Z',
     NULL, NULL);

  INSERT INTO "thread" (
    "id", "project_id", "parent_thread_id", "name", "state", "cwd",
    "cwd_repo", "messages", "checkpoints", "usage", "queue_paused",
    "active_prompt_id", "error_code", "last_sequence", "result_text",
    "result_status", "result_prompt_id", "result_at", "created_at",
    "updated_at", "started_at", "finished_at"
  ) VALUES
    ('${root}', '${openProject}', NULL, 'Root', 'READY', '/workspace', NULL,
     '[{"role": "user", "content": "first"}, {"role": "assistant", "content": "answer"}]',
     '{"${promptA}": 0, "${promptB}": 2}', '{"costUsd": 0.25}', false,
     NULL, NULL, 5, 'answer', 'completed', '${promptA}',
     '2026-10-01T10:03:00.000Z', '2026-10-01T10:00:01.000Z',
     '2026-10-01T10:04:30.000Z', '2026-10-01T10:01:00.000Z', NULL),
    ('${child}', '${openProject}', '${root}', 'Child', 'RUNNING',
     '/workspace/repo', 'github', '[{"role": "user", "content": "go"}]',
     '{"${promptC}": 0}', '{"costUsd": 0.5, "prompts": {"a": 1}}', true,
     '${promptC}', NULL, 1, NULL, NULL, NULL, NULL,
     '2026-10-01T10:00:02.000Z', '2026-10-01T10:06:00.000Z',
     '2026-10-01T10:06:00.000Z', NULL),
    ('${sibling}', '${openProject}', '${root}', 'Sibling', 'FAILED',
     '/workspace', 'git', '[]', '{}', NULL, false, NULL, 'boom', 0,
     NULL, NULL, NULL, NULL, '2026-10-01T10:00:03.000Z',
     '2026-10-01T10:07:00.000Z', NULL, '2026-10-01T10:07:00.000Z'),
    ('${alone}', '${goneProject}', NULL, 'Alone', 'CANCELLED', '/workspace',
     NULL, '[]', '{}', NULL, false, NULL, NULL, 0, NULL, NULL, NULL, NULL,
     '2026-10-02T09:00:01.000Z', '2026-10-02T09:30:00.000Z', NULL,
     '2026-10-02T09:30:00.000Z');

  INSERT INTO "thread_event" (
    "project_id", "thread_id", "prompt_id", "sequence", "type", "event",
    "created_at"
  ) VALUES
    ('${openProject}', '${root}', '${promptA}', 1, 'prompt.started',
     '{"type": "prompt.started"}', '2026-10-01T10:01:00.000Z'),
    ('${openProject}', '${root}', '${promptA}', 2, 'message.delta',
     '{"type": "message.delta", "text": "héllo – ✓", "meta": {"n": 1, "ok": true, "none": null}}',
     '2026-10-01T10:02:00.000Z'),
    ('${openProject}', '${root}', '${promptA}', 3, 'prompt.finished',
     '{"type": "prompt.finished", "status": "completed"}',
     '2026-10-01T10:03:00.000Z'),
    ('${openProject}', '${root}', '${promptB}', 5, 'prompt.started',
     '{"type": "prompt.started"}', '2026-10-01T10:04:00.000Z'),
    ('${openProject}', '${child}', '${promptC}', 1, 'prompt.started',
     '{"type": "prompt.started"}', '2026-10-01T10:06:00.000Z');
`;

const document = (type: string, id: string, value: unknown) => ({
  type,
  id,
  revision: 1,
  value,
});

/** Every runtime document stage 7 writes from the seed, but the marker. */
const expectedDocuments = [
  document('runtime.project/v1', openProject, {
    id: openProject,
    name: 'Open',
    color: 'blue',
    state: 'ready',
    open: true,
    configRevision: 2,
    configSnapshot: {
      revision: 2,
      providers: [{ id: 'openrouter', models: [] }],
    },
    errorCode: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:05:00.000Z',
    startedAt: '2026-10-01T10:00:30.000Z',
    finishedAt: null,
    createdKey: `2026-10-01T10:00:00.000Z|${openProject}`,
  }),
  document('runtime.project/v1', goneProject, {
    id: goneProject,
    name: 'Gone',
    color: null,
    state: 'cancelled',
    open: false,
    configRevision: 1,
    configSnapshot: { revision: 1 },
    errorCode: null,
    createdAt: '2026-10-02T09:00:00.000Z',
    updatedAt: '2026-10-02T09:30:00.000Z',
    startedAt: '2026-10-02T09:00:30.000Z',
    finishedAt: '2026-10-02T09:30:00.000Z',
    createdKey: `2026-10-02T09:00:00.000Z|${goneProject}`,
  }),
  document('runtime.project/v1', brokenProject, {
    id: brokenProject,
    name: 'Broken',
    color: 'red',
    state: 'failed',
    open: false,
    configRevision: 3,
    configSnapshot: { revision: 3 },
    errorCode: 'sandbox_unavailable',
    createdAt: '2026-10-03T08:00:00.000Z',
    updatedAt: '2026-10-03T08:01:00.000Z',
    startedAt: null,
    finishedAt: '2026-10-03T08:01:00.000Z',
    createdKey: `2026-10-03T08:00:00.000Z|${brokenProject}`,
  }),
  document('runtime.project/v1', queuedProject, {
    id: queuedProject,
    name: 'Queued',
    color: 'green',
    state: 'queued',
    open: true,
    configRevision: 3,
    configSnapshot: { revision: 3 },
    errorCode: null,
    createdAt: '2026-10-03T08:00:00.000Z',
    updatedAt: '2026-10-03T08:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    createdKey: `2026-10-03T08:00:00.000Z|${queuedProject}`,
  }),
  document('runtime.thread/v1', root, {
    id: root,
    projectId: openProject,
    parentThreadId: null,
    name: 'Root',
    state: 'ready',
    open: true,
    cwd: '/workspace',
    cwdRepo: null,
    queuePaused: false,
    activePromptId: null,
    errorCode: null,
    lastSequence: 5,
    result: {
      status: 'completed',
      text: 'answer',
      promptId: promptA,
      at: '2026-10-01T10:03:00.000Z',
    },
    // The latest prompt.started, the one after the gap.
    lastStarted: { promptId: promptB, at: '2026-10-01T10:04:00.000Z' },
    usage: { costUsd: 0.25 },
    pending: null,
    createdAt: '2026-10-01T10:00:01.000Z',
    updatedAt: '2026-10-01T10:04:30.000Z',
    startedAt: '2026-10-01T10:01:00.000Z',
    finishedAt: null,
    createdKey: `2026-10-01T10:00:01.000Z|${root}`,
  }),
  document('runtime.thread/v1', child, {
    id: child,
    projectId: openProject,
    parentThreadId: root,
    name: 'Child',
    state: 'running',
    open: true,
    cwd: '/workspace/repo',
    cwdRepo: 'github',
    queuePaused: true,
    activePromptId: promptC,
    errorCode: null,
    lastSequence: 1,
    result: null,
    lastStarted: { promptId: promptC, at: '2026-10-01T10:06:00.000Z' },
    usage: { costUsd: 0.5, prompts: { a: 1 } },
    pending: null,
    createdAt: '2026-10-01T10:00:02.000Z',
    updatedAt: '2026-10-01T10:06:00.000Z',
    startedAt: '2026-10-01T10:06:00.000Z',
    finishedAt: null,
    createdKey: `2026-10-01T10:00:02.000Z|${child}`,
  }),
  document('runtime.thread/v1', sibling, {
    id: sibling,
    projectId: openProject,
    parentThreadId: root,
    name: 'Sibling',
    state: 'failed',
    open: false,
    cwd: '/workspace',
    cwdRepo: 'git',
    queuePaused: false,
    activePromptId: null,
    errorCode: 'boom',
    lastSequence: 0,
    result: null,
    lastStarted: null,
    usage: null,
    pending: null,
    createdAt: '2026-10-01T10:00:03.000Z',
    updatedAt: '2026-10-01T10:07:00.000Z',
    startedAt: null,
    finishedAt: '2026-10-01T10:07:00.000Z',
    createdKey: `2026-10-01T10:00:03.000Z|${sibling}`,
  }),
  document('runtime.thread/v1', alone, {
    id: alone,
    projectId: goneProject,
    parentThreadId: null,
    name: 'Alone',
    state: 'cancelled',
    open: false,
    cwd: '/workspace',
    cwdRepo: null,
    queuePaused: false,
    activePromptId: null,
    errorCode: null,
    lastSequence: 0,
    result: null,
    lastStarted: null,
    usage: null,
    pending: null,
    createdAt: '2026-10-02T09:00:01.000Z',
    updatedAt: '2026-10-02T09:30:00.000Z',
    startedAt: null,
    finishedAt: '2026-10-02T09:30:00.000Z',
    createdKey: `2026-10-02T09:00:01.000Z|${alone}`,
  }),
  document('runtime.history/v1', `${root}:messages`, {
    threadId: root,
    projectId: openProject,
    format: 'direct.history/v1',
    part: 'messages',
    value: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
    ],
  }),
  document('runtime.history/v1', `${root}:meta`, {
    threadId: root,
    projectId: openProject,
    format: 'direct.history/v1',
    part: 'meta',
    value: { checkpoints: { [promptA]: 0, [promptB]: 2 }, messageCount: 2 },
  }),
  document('runtime.history/v1', `${child}:messages`, {
    threadId: child,
    projectId: openProject,
    format: 'direct.history/v1',
    part: 'messages',
    value: [{ role: 'user', content: 'go' }],
  }),
  document('runtime.history/v1', `${child}:meta`, {
    threadId: child,
    projectId: openProject,
    format: 'direct.history/v1',
    part: 'meta',
    value: { checkpoints: { [promptC]: 0 }, messageCount: 1 },
  }),
  document('runtime.history/v1', `${sibling}:messages`, {
    threadId: sibling,
    projectId: openProject,
    format: 'direct.history/v1',
    part: 'messages',
    value: [],
  }),
  document('runtime.history/v1', `${sibling}:meta`, {
    threadId: sibling,
    projectId: openProject,
    format: 'direct.history/v1',
    part: 'meta',
    value: { checkpoints: {}, messageCount: 0 },
  }),
  document('runtime.history/v1', `${alone}:messages`, {
    threadId: alone,
    projectId: goneProject,
    format: 'direct.history/v1',
    part: 'messages',
    value: [],
  }),
  document('runtime.history/v1', `${alone}:meta`, {
    threadId: alone,
    projectId: goneProject,
    format: 'direct.history/v1',
    part: 'meta',
    value: { checkpoints: {}, messageCount: 0 },
  }),
];

const entry = (
  sequence: number,
  thread: string,
  promptId: string,
  event: { readonly type: string } & Record<string, unknown>,
  createdAt: string,
) => ({
  sequence,
  value: {
    projectId: openProject,
    threadId: thread,
    promptId,
    type: event.type,
    event,
  },
  createdAt,
});

/** Every Thread's event stream: its counter and entries, gaps kept. */
const expectedStreams = new Map([
  [
    root,
    {
      lastSequence: 5,
      entries: [
        entry(
          1,
          root,
          promptA,
          { type: 'prompt.started' },
          '2026-10-01T10:01:00.000Z',
        ),
        entry(
          2,
          root,
          promptA,
          {
            type: 'message.delta',
            text: 'héllo – ✓',
            meta: { n: 1, ok: true, none: null },
          },
          '2026-10-01T10:02:00.000Z',
        ),
        entry(
          3,
          root,
          promptA,
          { type: 'prompt.finished', status: 'completed' },
          '2026-10-01T10:03:00.000Z',
        ),
        entry(
          5,
          root,
          promptB,
          { type: 'prompt.started' },
          '2026-10-01T10:04:00.000Z',
        ),
      ],
    },
  ],
  [
    child,
    {
      lastSequence: 1,
      entries: [
        entry(
          1,
          child,
          promptC,
          { type: 'prompt.started' },
          '2026-10-01T10:06:00.000Z',
        ),
      ],
    },
  ],
  [sibling, { lastSequence: 0, entries: [] }],
  [alone, { lastSequence: 0, entries: [] }],
]);

const marker = { type: 'runtime.migration/v1', id: 'legacy-prisma' };

void test('the stage-7 migration moves Projects, Threads, histories and events without loss', {
  skip: connectionString === undefined,
}, async () => {
  const resources = await legacyFixture();
  try {
    const { database } = resources;
    await resources.migrate(seedSql);
    const [{ position: before } = { position: 0n }] = await database.$queryRaw<
      { position: bigint }[]
    >`
        SELECT COALESCE(max("position"), 0) AS position FROM "storage_commit"`;

    await resources.migrate(await stage7Sql());

    // The switch: the legacy tables are empty and no index was computed in SQL.
    for (const table of ['project', 'thread', 'thread_event']) {
      assert.equal(await count(database, table), 0, table);
    }
    assert.equal(
      await count(database, 'storage_index_entry'),
      0,
      'index entries are left to the first declareType',
    );
    assert.deepEqual(
      await database.$queryRaw<{ type: string; id: string }[]>`
        SELECT "type", "id" FROM "storage_document"
        WHERE "type" LIKE 'runtime.%' ORDER BY "type", "id"`,
      [...expectedDocuments.map(({ type, id }) => ({ type, id })), marker].sort(
        (left, right) =>
          `${left.type} ${left.id}` < `${right.type} ${right.id}` ? -1 : 1,
      ),
    );

    const { storage, dispose } = backendOver(database);
    try {
      const stored = await storage.get(marker);
      assert.ok(stored);
      const { completedAt, ...rest } = stored.value as {
        completedAt: unknown;
      };
      assert.match(
        String(completedAt),
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
      );
      assert.deepEqual(rest, {
        source: 'prisma-legacy',
        counts: { projects: 4, threads: 4, events: 5, histories: 8 },
      });
      const feed = await storage.feed({ after: Number(before), limit: 10 });
      assert.deepEqual(
        feed.commits.map(({ documents }) => documents),
        [[marker]],
      );

      await declareRuntimeTypes(storage);

      // Paged reads answer in the legacy order, page boundaries included:
      // newest first, and the id breaks a tie of creation times.
      assert.deepEqual(
        await walk(
          storage,
          { type: 'runtime.project/v1', index: 'byCreated', equals: [] },
          2,
        ),
        [
          [queuedProject, brokenProject],
          [goneProject, openProject],
        ],
      );
      assert.deepEqual(
        await walk(
          storage,
          { type: 'runtime.project/v1', index: 'byOpen', equals: [true] },
          2,
        ),
        [[queuedProject, openProject]],
      );
      for (const [projectId, pages] of [
        [openProject, [[sibling, child], [root]]],
        [goneProject, [[alone]]],
        [brokenProject, []],
        [queuedProject, []],
      ] as const) {
        assert.deepEqual(
          await walk(
            storage,
            {
              type: 'runtime.thread/v1',
              index: 'byProject',
              equals: [projectId],
            },
            2,
          ),
          pages,
          projectId,
        );
      }
      assert.deepEqual(
        await walk(
          storage,
          {
            type: 'runtime.thread/v1',
            index: 'byParent',
            equals: [openProject, root],
          },
          2,
        ),
        [[sibling, child]],
      );
      assert.deepEqual(
        await walk(
          storage,
          { type: 'runtime.thread/v1', index: 'byOpen', equals: [true] },
          2,
        ),
        [[child, root]],
      );

      for (const expected of expectedDocuments) {
        assert.deepEqual(
          await storage.get({ type: expected.type, id: expected.id }),
          expected,
          `${expected.type} ${expected.id}`,
        );
      }

      for (const [thread, expected] of expectedStreams) {
        assert.deepEqual(
          await storage.read({
            stream: `runtime.thread.events/${thread}`,
            afterSequence: 0,
            limit: 1000,
          }),
          { ...expected, truncations: [] },
          thread,
        );
      }
    } finally {
      await dispose();
    }
  } finally {
    await resources.close();
  }
});

void test('applying the stage-7 migration again changes nothing', {
  skip: connectionString === undefined,
}, async () => {
  const resources = await legacyFixture();
  try {
    const { database } = resources;
    await resources.migrate(seedSql);
    await resources.migrate(await stage7Sql());
    const snapshot = async () =>
      database.$queryRaw<{ type: string; id: string; value: string }[]>`
          SELECT "type", "id", "value"::text AS "value" FROM "storage_document"
          ORDER BY "type", "id"`;
    const documents = await snapshot();
    const commits = await count(database, 'storage_commit');
    const entries = await count(database, 'storage_stream_entry');

    // A legacy row written after the switch is not imported again.
    await resources.migrate(`
      INSERT INTO "project" (
        "id", "name", "state", "config_revision", "config_snapshot",
        "created_at", "updated_at"
      ) VALUES (
        '${laterProject}', 'Later', 'QUEUED', 4, '{"revision": 4}',
        '2026-10-05T12:00:00.000Z', '2026-10-05T12:00:00.000Z'
      )`);
    await resources.migrate(await stage7Sql());

    assert.deepEqual(await snapshot(), documents);
    assert.equal(await count(database, 'storage_commit'), commits);
    assert.equal(await count(database, 'storage_stream_entry'), entries);
    assert.equal(await count(database, 'project'), 1);
  } finally {
    await resources.close();
  }
});

void test('the migration of an empty workspace only records the marker', {
  skip: connectionString === undefined,
}, async () => {
  const resources = await legacyFixture();
  try {
    const { database } = resources;
    await resources.migrate(await stage7Sql());
    const rows = await database.$queryRaw<{ type: string; id: string }[]>`
        SELECT "type", "id" FROM "storage_document"
        WHERE "type" LIKE 'runtime.%'`;
    assert.deepEqual(rows, [marker]);
  } finally {
    await resources.close();
  }
});
