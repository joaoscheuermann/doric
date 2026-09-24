import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { defaultConfig } from '../src/lib/config/schema.js';
import { createConfigStore } from '../src/lib/config/store.js';
import { createProjectStore } from '../src/lib/workspace/projects.js';
import { createThreadStore } from '../src/lib/workspace/threads.js';
import {
  migrationDirectory,
  persistenceFixture,
} from './helpers/persistence-fixture.js';

const connectionString = process.env.DORIC_TEST_DATABASE_URL;
const promptId = randomUUID();

integrationTest(
  'creates projects without threads and captures immutable configuration',
  async ({ configs, projects, threads }) => {
    const initial = await configs.load();
    const first = await projects.create('First project', initial);
    assert.equal(first.project.name, 'First project');
    assert.deepEqual(await threads.listByProject(first.project.id), []);
    const replacement = structuredClone(initial.configuration);
    replacement.models.execution.model = 'replacement';
    const second = await projects.create(
      'Second project',
      await configs.replace(replacement),
    );
    assert.deepEqual(
      (await projects.find(first.project.id))?.snapshot,
      initial,
    );
    assert.equal(
      (await projects.find(second.project.id))?.snapshot.configuration.models
        .execution.model,
      'replacement',
    );
    assert.equal(
      (await projects.rename(first.project.id, 'Renamed project'))?.name,
      'Renamed project',
    );
    assert.equal('configSnapshot' in first.project, false);
  },
);

integrationTest(
  'persists independent provider-ready histories and exact redacted events',
  async ({ configs, projects, threads }) => {
    const { project } = await projects.create('Project', await configs.load());
    const root = (await threads.create(project.id, 'Root')).thread;
    const child = (await threads.create(project.id, 'Child', root.id)).thread;
    assert.equal(root.name, 'Root');
    assert.equal(
      (await threads.rename(child.id, 'Renamed child'))?.name,
      'Renamed child',
    );
    const messages = [
      {
        role: 'assistant' as const,
        content: 'partial',
        replay: [{ encrypted_content: 'opaque' }],
      },
    ];
    await threads.saveMessages(child.id, messages);
    const value = {
      type: 'tool.finished',
      output: { token: '[REDACTED]', nested: [null, 42] },
    };
    await threads.appendEvent(child.id, promptId, value);
    assert.deepEqual((await threads.find(child.id))?.messages, messages);
    assert.deepEqual((await threads.find(root.id))?.messages, []);
    assert.deepEqual((await threads.eventsAfter(child.id, 0))[0]?.event, value);
    assert.deepEqual(await threads.eventsAfter(root.id, 0), []);
  },
);

integrationTest(
  'serializes event sequences across independent clients and rolls back failed insertion',
  async ({ configs, projects, threads, second }) => {
    const { project } = await projects.create('Project', await configs.load());
    const { thread } = await threads.create(project.id, 'Thread');
    const other = createThreadStore(second);
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 ? threads : other).appendEvent(thread.id, promptId, {
          type: 'delta',
          index,
        }),
      ),
    );
    await assert.rejects(
      threads.appendEvent(thread.id, 'not-a-uuid', { type: 'bad' }),
    );
    const next = await other.appendEvent(thread.id, promptId, { type: 'done' });
    assert.equal(next.sequence, 13);
    const events = await threads.eventsAfter(thread.id, 0);
    assert.deepEqual(
      new Set(
        events
          .filter(({ type }) => type === 'delta')
          .map(({ event }) => (event as { index: number }).index),
      ),
      new Set(Array.from({ length: 12 }, (_, index) => index)),
    );
    assert.deepEqual(
      events.map(({ sequence }) => sequence),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
    );
    assert.equal((await threads.find(thread.id))?.thread.lastSequence, 13);
    assert.deepEqual(
      (await threads.eventsAfter(thread.id, 12)).map(
        ({ sequence }) => sequence,
      ),
      [13],
    );
  },
);

integrationTest(
  'rewinds a Thread onto an earlier turn boundary without reusing sequences',
  async ({ configs, projects, threads }) => {
    const { project } = await projects.create('Project', await configs.load());
    const { thread } = await threads.create(project.id, 'Thread');
    const ids = [randomUUID(), randomUUID(), randomUUID()] as const;
    const messages = [
      { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: 'first answer' },
      { role: 'user' as const, content: 'second' },
      { role: 'assistant' as const, content: 'second answer' },
      { role: 'user' as const, content: 'third' },
      { role: 'assistant' as const, content: 'third answer' },
    ];
    // Each turn checkpoints the provider history it reads, then appends its own.
    for (const [index, promptId] of ids.entries()) {
      await threads.saveCheckpoint(thread.id, promptId);
      await threads.appendEvent(thread.id, promptId, {
        type: 'prompt.accepted',
      });
      await threads.saveMessages(thread.id, messages.slice(0, (index + 1) * 2));
    }
    assert.deepEqual((await threads.find(thread.id))?.checkpoints, {
      [ids[0]]: 0,
      [ids[1]]: 2,
      [ids[2]]: 4,
    });

    const marker = await threads.rewind(thread.id, ids[1]);

    assert.equal(marker?.sequence, 4);
    assert.equal(marker?.type, 'history.truncated');
    assert.deepEqual(marker?.event, {
      type: 'history.truncated',
      afterSequence: 1,
    });
    assert.deepEqual(
      (await threads.eventsAfter(thread.id, 0)).map(({ sequence }) => sequence),
      [1, 4],
    );
    const restored = (await threads.find(thread.id))!;
    assert.equal(restored.thread.lastSequence, 4);
    assert.deepEqual(restored.messages, messages.slice(0, 2));
    assert.deepEqual(restored.checkpoints, { [ids[0]]: 0 });
    // Removed turns lost their checkpoint, so they cannot be rewound again.
    assert.equal(await threads.rewind(thread.id, ids[1]), undefined);
    assert.equal(await threads.rewind(thread.id, ids[2]), undefined);
    assert.equal(await threads.rewind(thread.id, randomUUID()), undefined);
    assert.equal(await threads.rewind(randomUUID(), ids[0]), undefined);
  },
);

integrationTest(
  'preserves terminal and cancelling states and clears the active prompt when not running',
  async ({ configs, projects, threads }) => {
    const { project } = await projects.create('Project', await configs.load());
    const { thread } = await threads.create(project.id, 'Thread');
    await threads.setState(thread.id, 'ready');
    await threads.setState(thread.id, 'running', promptId);
    assert.equal(
      (await threads.find(thread.id))?.thread.activePromptId,
      promptId,
    );
    await threads.setState(thread.id, 'cancelling');
    assert.equal(
      (await threads.setState(thread.id, 'running', randomUUID()))?.state,
      'cancelling',
    );
    assert.equal(
      (await threads.setState(thread.id, 'ready'))?.activePromptId,
      undefined,
    );
    await threads.setState(thread.id, 'cancelled');
    assert.equal(
      (await threads.setState(thread.id, 'failed', undefined, 'late'))?.state,
      'cancelled',
    );
    await projects.setState(project.id, 'cancelling');
    assert.equal(
      (await projects.setState(project.id, 'ready'))?.state,
      'cancelling',
    );
    await projects.setState(project.id, 'failed', 'failure');
    assert.equal(
      (await projects.setState(project.id, 'ready'))?.errorCode,
      'failure',
    );
  },
);

integrationTest(
  'scopes pagination cursors to their project and parent',
  async ({ configs, projects, threads }) => {
    const first = (await projects.create('First', await configs.load()))
      .project;
    const second = (await projects.create('Second', await configs.load()))
      .project;
    const root = (await threads.create(first.id, 'Root')).thread;
    const sibling = (await threads.create(first.id, 'Sibling')).thread;
    const children = await Promise.all([
      threads.create(first.id, 'First child', root.id),
      threads.create(first.id, 'Second child', root.id),
    ]);
    const foreign = (await threads.create(second.id, 'Foreign')).thread;
    assert.deepEqual((await threads.list(first.id, 10, foreign.id)).items, []);
    assert.deepEqual(
      (await threads.list(first.id, 10, sibling.id, root.id)).items,
      [],
    );
    const firstPage = await threads.list(first.id, 1, undefined, root.id);
    const lastPage = await threads.list(
      first.id,
      1,
      firstPage.nextCursor,
      root.id,
    );
    assert.deepEqual(
      new Set([...firstPage.items, ...lastPage.items].map(({ id }) => id)),
      new Set(children.map(({ thread }) => thread.id)),
    );
    assert.equal(lastPage.nextCursor, undefined);
    const projectsPage = await projects.list(1);
    assert.equal(
      (await projects.list(1, projectsPage.nextCursor)).items.length,
      1,
    );
  },
);

integrationTest(
  'enforces same-project immutable acyclic parentage at the database boundary',
  async ({ configs, projects, threads, database }) => {
    const first = (await projects.create('First', await configs.load()))
      .project;
    const second = (await projects.create('Second', await configs.load()))
      .project;
    const root = (await threads.create(first.id, 'Root')).thread;
    const child = (await threads.create(first.id, 'Child', root.id)).thread;
    await assert.rejects(
      database.thread.create({
        data: {
          projectId: second.id,
          name: 'Invalid child',
          parentThreadId: root.id,
        },
      }),
    );
    await assert.rejects(
      database.thread.update({
        where: { id: child.id },
        data: { parentThreadId: null },
      }),
    );
    await assert.rejects(
      database.thread.update({
        where: { id: root.id },
        data: { projectId: second.id },
      }),
    );
    const self = randomUUID();
    await assert.rejects(
      database.thread.create({
        data: {
          id: self,
          projectId: first.id,
          name: 'Self',
          parentThreadId: self,
        },
      }),
    );
    const a = randomUUID();
    const b = randomUUID();
    await assert.rejects(
      database.thread.createMany({
        data: [
          { id: a, projectId: first.id, name: 'A', parentThreadId: b },
          { id: b, projectId: first.id, name: 'B', parentThreadId: a },
        ],
      }),
    );
    assert.equal(
      (await threads.find(child.id))?.thread.parentThreadId,
      root.id,
    );
  },
);

integrationTest(
  'deletes only fully terminal subtrees without affecting other roots',
  async ({ configs, projects, threads }) => {
    const { project } = await projects.create('Project', await configs.load());
    const root = (await threads.create(project.id, 'Root')).thread;
    const child = (await threads.create(project.id, 'Child', root.id)).thread;
    const grandchild = (
      await threads.create(project.id, 'Grandchild', child.id)
    ).thread;
    const sibling = (await threads.create(project.id, 'Sibling')).thread;
    await threads.appendEvent(grandchild.id, promptId, { type: 'saved' });
    await threads.setState(root.id, 'cancelled');
    assert.equal(await threads.deleteSubtree(root.id), 'active');
    await threads.setState(child.id, 'failed');
    const saved = await threads.eventsAfter(grandchild.id, 0);
    assert.equal(await threads.deleteSubtree(root.id), 'active');
    for (const node of [root, child, grandchild]) {
      assert.ok(await threads.find(node.id));
    }
    assert.deepEqual(await threads.eventsAfter(grandchild.id, 0), saved);
    await threads.setState(grandchild.id, 'cancelled');
    assert.equal(await threads.deleteSubtree(root.id), 'deleted');
    assert.equal(await threads.find(child.id), undefined);
    assert.deepEqual(await threads.eventsAfter(grandchild.id, 0), []);
    assert.ok(await threads.find(sibling.id));
    await projects.setState(project.id, 'cancelled');
    assert.equal(await projects.delete(project.id), 'active');
    await threads.setState(sibling.id, 'failed');
    assert.equal(await projects.delete(project.id), 'deleted');
    assert.equal(await threads.find(sibling.id), undefined);
    assert.equal(await projects.delete(project.id), 'missing');
    assert.equal(await threads.deleteSubtree(root.id), 'missing');
  },
);

integrationTest(
  'reconciles only nonterminal records and preserves history and configuration',
  async ({ configs, projects, threads }) => {
    const snapshot = await configs.load();
    const projectCases = [];
    for (const state of [
      'queued',
      'ready',
      'cancelling',
      'failed',
      'cancelled',
    ] as const) {
      const { project } = await projects.create('Project', snapshot);
      // Create conversations before making their owner terminal.
      const threadCases = [];
      if (state === 'queued') {
        for (const threadState of [
          'queued',
          'ready',
          'running',
          'cancelling',
          'failed',
          'cancelled',
        ] as const) {
          const { thread } = await threads.create(project.id, 'Thread');
          const messages = [
            {
              role: 'user' as const,
              content: `Preserve ${threadState} conversation`,
            },
            {
              role: 'assistant' as const,
              content: 'Partial answer',
              replay: [{ encrypted_content: 'opaque' }],
            },
          ];
          await threads.saveMessages(thread.id, messages);
          await threads.setState(
            thread.id,
            threadState,
            threadState === 'running' ? promptId : undefined,
            'original',
          );
          const event = await threads.appendEvent(thread.id, promptId, {
            type: 'partial',
            output: { text: 'retained evidence', nested: [null, 42] },
          });
          threadCases.push({ before: (await threads.find(thread.id))!, event });
        }
      }
      await projects.setState(project.id, state, 'original');
      projectCases.push({
        before: (await projects.find(project.id))!,
        threadCases,
      });
    }
    assert.equal(await threads.reconcile(), 4);
    assert.equal(await projects.reconcile(), 3);
    for (const { before, threadCases } of projectCases) {
      const after = (await projects.find(before.project.id))!;
      const terminal = ['failed', 'cancelled'].includes(before.project.state);
      assert.equal(
        after.project.state,
        terminal ? before.project.state : 'failed',
      );
      assert.equal(
        after.project.errorCode,
        terminal ? 'original' : 'process_interrupted',
      );
      assert.deepEqual(after.snapshot, snapshot);
      if (terminal) assert.deepEqual(after, before);
      for (const { before: record, event } of threadCases) {
        const restored = (await threads.find(record.thread.id))!;
        const terminalThread = ['failed', 'cancelled'].includes(
          record.thread.state,
        );
        assert.equal(
          restored.thread.state,
          terminalThread ? record.thread.state : 'failed',
        );
        assert.equal(
          restored.thread.errorCode,
          terminalThread ? 'original' : 'process_interrupted',
        );
        assert.equal(restored.thread.activePromptId, undefined);
        assert.equal(restored.thread.lastSequence, record.thread.lastSequence);
        assert.deepEqual(restored.messages, record.messages);
        assert.deepEqual(await threads.eventsAfter(record.thread.id, 0), [
          event,
        ]);
        if (terminalThread) assert.deepEqual(restored, record);
      }
    }
    assert.equal(await threads.reconcile(), 0);
    assert.equal(await projects.reconcile(), 0);
  },
);

test('ships the baseline followed by the incremental naming, checkpoint, and color migrations', async () => {
  assert.deepEqual((await readdir(migrationDirectory)).sort(), [
    '20260825000000_initial',
    '20260826000000_add_project_thread_names',
    '20260827000000_add_thread_checkpoints',
    '20260923000000_add_project_color',
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
});

test(
  'upgrades existing related Project and Thread rows with names and data intact',
  { skip: connectionString === undefined },
  async () => {
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
      assert.equal(await resources.database.threadEvent.count(), 1);
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
  },
);

for (const failure of [
  'admin connect',
  'schema create',
  'sql connect',
  'migration read',
  'migration query',
] as const) {
  test(`releases acquired database resources after ${failure} failure even if one close fails`, async () => {
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

integrationTest(
  'installs a clean Project and Thread baseline without legacy tables or data',
  async ({ database, projects, configs }) => {
    const tables = await database.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = current_schema() ORDER BY tablename`;
    assert.deepEqual(
      tables.map(({ tablename }) => tablename),
      [
        'doric_configuration',
        'model_configuration',
        'project',
        'provider_configuration',
        'thread',
        'thread_event',
      ],
    );
    assert.deepEqual((await projects.list(100)).items, []);
    assert.equal(await database.thread.count(), 0);
    assert.equal(await database.threadEvent.count(), 0);
    assert.deepEqual((await configs.load()).configuration, defaultConfig);
    await assert.rejects(database.$executeRaw`
      INSERT INTO doric_configuration (id, revision, generation, max_turns, updated_at)
      SELECT 2, revision, generation, max_turns, updated_at FROM doric_configuration WHERE id = 1`);
  },
);

type Stores = Awaited<ReturnType<typeof fixture>>;

function integrationTest(name: string, run: (stores: Stores) => Promise<void>) {
  test(name, { skip: connectionString === undefined }, async () => {
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
  return {
    ...resources,
    configs: createConfigStore(database),
    projects: createProjectStore(database),
    threads: createThreadStore(database),
  };
}
