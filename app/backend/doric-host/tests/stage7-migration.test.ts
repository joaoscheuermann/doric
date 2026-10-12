import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { createTestServices } from 'bundle';
import { type StorageBackend, StorageBackendV1 } from 'bundle/contracts';
import { PostgresDatabaseV1 } from 'postgres/contracts';
import type { Database } from 'postgres/prisma';
import { createPostgres } from 'postgres/testing';
import {
  historyDocumentSchema,
  historyType,
  migrationDocumentSchema,
  migrationType,
  projectDocumentSchema,
  projectType,
  threadDocumentSchema,
  threadEventsStream,
  threadStreamEntrySchema,
  threadType,
} from 'runtime/contracts';

import {
  createProjectStore,
  createThreadStore,
} from './helpers/legacy/index.js';
import type {
  Page,
  Project,
  Thread,
  ThreadEvent,
} from './helpers/legacy/types.js';
import {
  migrationDirectory,
  persistenceFixture,
} from './helpers/persistence-fixture.js';
import { kernelOver } from './helpers/platform.js';

// Stage 7 (design 57 §10): `prisma migrate deploy` moves the legacy Project,
// Thread, history and event rows into the runtime's storage/v1 documents and
// streams without loss, once, and the host refuses legacy rows that were never
// moved. The legacy stores are the oracle: what they read back before the
// migration is what the generic storage must answer after it.

const connectionString = process.env.DORIC_TEST_DATABASE_URL;
const stage7 = '20261010000000_runtime_documents';
const reason =
  'Legacy Project and Thread data has not been migrated; run prisma migrate deploy.';

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
    provide: [postgres.storage, postgres.database],
  });
  return {
    storage: services.services.use(StorageBackendV1),
    connect: () => services.services.use(PostgresDatabaseV1).connect(),
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

const legacyWalk = async <Value extends { readonly id: string }>(
  list: (cursor?: string) => Promise<Page<Value>>,
): Promise<string[][]> => {
  const pages: string[][] = [];
  let cursor: string | undefined;
  do {
    const page = await list(cursor);
    if (page.items.length > 0) pages.push(page.items.map(({ id }) => id));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return pages;
};

const optional = <Value>(value: Value | null): Value | undefined =>
  value === null ? undefined : value;

/** Seeds a varied legacy workspace through the legacy stores. */
const seed = async (database: Database) => {
  const kernel = await kernelOver(database);
  const snapshot = await kernel.configs.load().finally(() => kernel.close());
  const projects = createProjectStore(database);
  const threads = createThreadStore(database);

  const { project: open } = await projects.create('Open', snapshot, 'blue');
  await projects.setState(open.id, 'ready');
  const { project: cancelled } = await projects.create('Gone', snapshot, 'red');
  await threads.create(cancelled.id, 'Alone');
  await projects.setState(cancelled.id, 'cancelled');
  // Rows written before colors existed hold none.
  await database.$executeRaw`
    UPDATE "project" SET "color" = NULL WHERE "id" = ${cancelled.id}::uuid`;
  await projects.create('Queued', snapshot, 'green');

  const { thread: root } = await threads.create(open.id, 'Root');
  const { thread: child } = await threads.create(open.id, 'Child', root.id);
  const { thread: sibling } = await threads.create(open.id, 'Sibling', root.id);

  const first = randomUUID();
  const second = randomUUID();
  await threads.setState(root.id, 'running', first);
  await threads.appendEvent(root.id, first, { type: 'prompt.started' });
  await threads.saveCheckpoint(root.id, first);
  await threads.appendEvent(root.id, first, {
    type: 'message.delta',
    text: 'héllo "quoted" \u0000-free',
  });
  await threads.saveMessages(root.id, [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer' },
  ] as never);
  await threads.appendEvent(root.id, first, {
    type: 'prompt.finished',
    status: 'completed',
  });
  await threads.setResult(root.id, {
    status: 'completed',
    text: 'answer',
    promptId: first,
    at: new Date().toISOString(),
  });
  await threads.appendEvent(root.id, second, { type: 'prompt.started' });
  await threads.saveCheckpoint(root.id, second);
  await threads.saveMessages(root.id, [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'second' },
  ] as never);
  // A rewind leaves a gap in the sequence and moves the counter on.
  await threads.rewind(root.id, second);
  await threads.setState(root.id, 'ready');

  await threads.setCwd(child.id, '/workspace/repo', 'github');
  await threads.setState(sibling.id, 'failed', undefined, 'boom');
  await database.$executeRaw`
    UPDATE "thread"
    SET "usage" = '{"costUsd": 0.25, "prompts": {"a": 1}}'::jsonb,
        "queue_paused" = true
    WHERE "id" = ${child.id}::uuid`;

  return { open, cancelled, root, child };
};

/** Everything the legacy stores answer, recorded before the move. */
const readLegacy = async (database: Database) => {
  const projects = createProjectStore(database);
  const threads = createThreadStore(database);
  const projectPages = await legacyWalk((cursor) => projects.list(2, cursor));
  const projectRecords = new Map<
    string,
    { project: Project; snapshot: unknown }
  >();
  const threadRecords = new Map<
    string,
    {
      thread: Thread;
      messages: unknown;
      checkpoints: unknown;
      events: readonly ThreadEvent[];
    }
  >();
  const threadPages = new Map<string, string[][]>();

  for (const id of projectPages.flat()) {
    const record = await projects.find(id);
    assert.ok(record);
    projectRecords.set(id, record);
    threadPages.set(
      id,
      await legacyWalk((cursor) => threads.list(id, 2, cursor)),
    );
    for (const thread of await threads.listByProject(id)) {
      const found = await threads.find(thread.id);
      assert.ok(found);
      threadRecords.set(thread.id, {
        ...found,
        events: await threads.eventsAfter(thread.id, 0),
      });
    }
  }

  return { projectPages, projectRecords, threadRecords, threadPages };
};

const count = async (database: Database, table: string): Promise<number> => {
  const [row] = await database.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*) AS count FROM "${table}"`,
  );
  return Number(row?.count);
};

void test('the stage-7 migration moves Projects, Threads, histories and events without loss', {
  skip: connectionString === undefined,
}, async () => {
  const resources = await legacyFixture();
  try {
    const { database } = resources;
    const seeded = await seed(database);
    const legacy = await readLegacy(database);
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

    const { storage, dispose } = backendOver(database);
    try {
      const marker = await storage.get({
        type: 'runtime.migration/v1',
        id: 'legacy-prisma',
      });
      assert.ok(marker);
      assert.deepEqual(migrationDocumentSchema.parse(marker.value).counts, {
        projects: 3,
        threads: 4,
        events: [...legacy.threadRecords.values()].reduce(
          (total, { events }) => total + events.length,
          0,
        ),
        histories: 8,
      });
      const feed = await storage.feed({ after: Number(before), limit: 10 });
      assert.deepEqual(
        feed.commits.map(({ documents }) => documents),
        [[{ type: 'runtime.migration/v1', id: 'legacy-prisma' }]],
      );

      await declareRuntimeTypes(storage);

      // Paged reads answer the legacy order, page boundaries included.
      assert.deepEqual(
        await walk(
          storage,
          { type: 'runtime.project/v1', index: 'byCreated', equals: [] },
          2,
        ),
        legacy.projectPages,
      );
      for (const [projectId, pages] of legacy.threadPages) {
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
        );
      }
      assert.deepEqual(
        (
          await walk(
            storage,
            { type: 'runtime.project/v1', index: 'byOpen', equals: [true] },
            10,
          )
        ).flat(),
        legacy.projectPages.flat().filter((id) => id !== seeded.cancelled.id),
      );
      assert.deepEqual(
        (
          await walk(
            storage,
            {
              type: 'runtime.thread/v1',
              index: 'byParent',
              equals: [seeded.open.id, seeded.root.id],
            },
            10,
          )
        ).flat(),
        legacy.threadPages
          .get(seeded.open.id)
          ?.flat()
          .filter(
            (id) =>
              legacy.threadRecords.get(id)?.thread.parentThreadId ===
              seeded.root.id,
          ),
      );

      for (const [id, record] of legacy.projectRecords) {
        const stored = await storage.get({ type: 'runtime.project/v1', id });
        assert.ok(stored);
        const document = projectDocumentSchema.parse(stored.value);
        const { project } = record;
        assert.deepEqual(
          {
            id: document.id,
            name: document.name,
            color: optional(document.color),
            state: document.state,
            configRevision: document.configRevision,
            errorCode: optional(document.errorCode),
            createdAt: document.createdAt,
            updatedAt: document.updatedAt,
            startedAt: optional(document.startedAt),
            finishedAt: optional(document.finishedAt),
          },
          {
            id: project.id,
            name: project.name,
            color: project.color,
            state: project.state,
            configRevision: project.configRevision,
            errorCode: project.errorCode,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
            startedAt: project.startedAt,
            finishedAt: project.finishedAt,
          },
        );
        assert.deepEqual(document.configSnapshot, record.snapshot);
        assert.equal(document.open, project.state !== 'cancelled');
      }

      for (const [id, record] of legacy.threadRecords) {
        const stored = await storage.get({ type: 'runtime.thread/v1', id });
        assert.ok(stored);
        const document = threadDocumentSchema.parse(stored.value);
        const { thread } = record;
        assert.deepEqual(
          {
            projectId: document.projectId,
            parentThreadId: optional(document.parentThreadId),
            name: document.name,
            state: document.state,
            cwd: document.cwd,
            cwdRepo: optional(document.cwdRepo),
            activePromptId: optional(document.activePromptId),
            errorCode: optional(document.errorCode),
            lastSequence: document.lastSequence,
            result: optional(document.result),
            createdAt: document.createdAt,
            updatedAt: document.updatedAt,
            startedAt: optional(document.startedAt),
            finishedAt: optional(document.finishedAt),
          },
          {
            projectId: thread.projectId,
            parentThreadId: thread.parentThreadId,
            name: thread.name,
            state: thread.state,
            cwd: thread.cwd,
            cwdRepo: thread.cwdRepo,
            activePromptId: thread.activePromptId,
            errorCode: thread.errorCode,
            lastSequence: thread.lastSequence,
            result: thread.result,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            startedAt: thread.startedAt,
            finishedAt: thread.finishedAt,
          },
        );
        assert.equal(document.queuePaused, thread.queuePaused ?? false);
        assert.equal(document.pending, null);
        const started = [...record.events]
          .reverse()
          .find(({ type }) => type === 'prompt.started');
        assert.deepEqual(
          document.lastStarted,
          started === undefined
            ? null
            : { promptId: started.promptId, at: started.createdAt },
        );

        const messages = await storage.get({
          type: 'runtime.history/v1',
          id: `${id}:messages`,
        });
        const meta = await storage.get({
          type: 'runtime.history/v1',
          id: `${id}:meta`,
        });
        assert.ok(messages && meta);
        assert.deepEqual(historyDocumentSchema.parse(messages.value), {
          threadId: id,
          projectId: thread.projectId,
          format: 'direct.history/v1',
          part: 'messages',
          value: record.messages,
        });
        assert.deepEqual(historyDocumentSchema.parse(meta.value).value, {
          checkpoints: record.checkpoints,
          messageCount: (record.messages as unknown[]).length,
        });

        const page = await storage.read({
          stream: threadEventsStream(id),
          afterSequence: 0,
          limit: 1000,
        });
        assert.equal(page.lastSequence, thread.lastSequence);
        assert.deepEqual(
          page.entries.map(({ sequence, value, createdAt }) => {
            const entry = threadStreamEntrySchema.parse(value);
            return {
              projectId: entry.projectId,
              threadId: entry.threadId,
              promptId: entry.promptId,
              sequence,
              type: entry.type,
              event: entry.event,
              createdAt,
            };
          }),
          record.events,
        );
      }

      // The rewound Thread keeps its gap and its counter.
      const root = legacy.threadRecords.get(seeded.root.id);
      assert.ok(root);
      const sequences = root.events.map(({ sequence }) => sequence);
      assert.ok(sequences.at(-1) === root.thread.lastSequence);
      assert.ok(sequences.length < root.thread.lastSequence);
      assert.equal(
        legacy.threadRecords.get(seeded.child.id)?.thread.cwdRepo,
        'github',
      );
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
    await seed(database);
    await resources.migrate(await stage7Sql());
    const snapshot = async () =>
      database.$queryRaw<{ type: string; id: string; value: string }[]>`
          SELECT "type", "id", "value"::text AS "value" FROM "storage_document"
          ORDER BY "type", "id"`;
    const documents = await snapshot();
    const commits = await count(database, 'storage_commit');
    const entries = await count(database, 'storage_stream_entry');

    // New legacy rows written after the switch are not imported again.
    const kernel = await kernelOver(database);
    const config = await kernel.configs.load().finally(() => kernel.close());
    await createProjectStore(database).create('Later', config, 'blue');
    await resources.migrate(await stage7Sql());

    assert.deepEqual(await snapshot(), documents);
    assert.equal(await count(database, 'storage_commit'), commits);
    assert.equal(await count(database, 'storage_stream_entry'), entries);
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
    assert.deepEqual(rows, [
      { type: 'runtime.migration/v1', id: 'legacy-prisma' },
    ]);
  } finally {
    await resources.close();
  }
});

void test('connecting refuses legacy rows that were never migrated, then accepts them once moved', {
  skip: connectionString === undefined,
}, async () => {
  const resources = await legacyFixture();
  try {
    const { database } = resources;
    const { connect, dispose } = backendOver(database);
    try {
      // An empty legacy layout is not a refusal.
      await connect();

      await seed(database);
      await assert.rejects(connect(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, reason);
        return true;
      });

      await resources.migrate(await stage7Sql());
      await connect();
    } finally {
      await dispose();
    }
  } finally {
    await resources.close();
  }
});
