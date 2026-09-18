import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { defaultConfig } from '../src/lib/config.js';
import { createConfigStore } from '../src/lib/config-store.js';
import { createProjectStore } from '../src/lib/projects.js';
import { createThreadStore } from '../src/lib/threads.js';
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
    const first = await projects.create(initial);
    assert.deepEqual(await threads.listByProject(first.project.id), []);
    const replacement = structuredClone(initial.configuration);
    replacement.models.execution.model = 'replacement';
    const second = await projects.create(await configs.replace(replacement));
    assert.deepEqual(
      (await projects.find(first.project.id))?.snapshot,
      initial,
    );
    assert.equal(
      (await projects.find(second.project.id))?.snapshot.configuration.models
        .execution.model,
      'replacement',
    );
    assert.equal('configSnapshot' in first.project, false);
  },
);

integrationTest(
  'persists independent provider-ready histories and exact redacted events',
  async ({ configs, projects, threads }) => {
    const { project } = await projects.create(await configs.load());
    const root = (await threads.create(project.id)).thread;
    const child = (await threads.create(project.id, root.id)).thread;
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
    const { project } = await projects.create(await configs.load());
    const { thread } = await threads.create(project.id);
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
  'preserves terminal and cancelling states and clears the active prompt when not running',
  async ({ configs, projects, threads }) => {
    const { project } = await projects.create(await configs.load());
    const { thread } = await threads.create(project.id);
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
    const first = (await projects.create(await configs.load())).project;
    const second = (await projects.create(await configs.load())).project;
    const root = (await threads.create(first.id)).thread;
    const sibling = (await threads.create(first.id)).thread;
    const children = await Promise.all([
      threads.create(first.id, root.id),
      threads.create(first.id, root.id),
    ]);
    const foreign = (await threads.create(second.id)).thread;
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
    const first = (await projects.create(await configs.load())).project;
    const second = (await projects.create(await configs.load())).project;
    const root = (await threads.create(first.id)).thread;
    const child = (await threads.create(first.id, root.id)).thread;
    await assert.rejects(
      database.thread.create({
        data: { projectId: second.id, parentThreadId: root.id },
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
        data: { id: self, projectId: first.id, parentThreadId: self },
      }),
    );
    const a = randomUUID();
    const b = randomUUID();
    await assert.rejects(
      database.thread.createMany({
        data: [
          { id: a, projectId: first.id, parentThreadId: b },
          { id: b, projectId: first.id, parentThreadId: a },
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
    const { project } = await projects.create(await configs.load());
    const root = (await threads.create(project.id)).thread;
    const child = (await threads.create(project.id, root.id)).thread;
    const grandchild = (await threads.create(project.id, child.id)).thread;
    const sibling = (await threads.create(project.id)).thread;
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
      const { project } = await projects.create(snapshot);
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
          const { thread } = await threads.create(project.id);
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

test('ships only the approved clean baseline and migration lock metadata', async () => {
  assert.deepEqual((await readdir(migrationDirectory)).sort(), [
    '20260825000000_initial',
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
});

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
