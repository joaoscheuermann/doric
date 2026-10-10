import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { RuntimeStores } from '../../src/host/store/index.js';
import {
  type Backend,
  backends,
  memoryBackend,
  saveCheckpoint,
  saveMessages,
  snapshot,
  stores,
  testFormat,
} from './support.js';

/*
 * The runtime store's contract on storage/v1, ported from the PostgreSQL
 * store cases of agents/doric/tests/persistence.test.ts (design 57 §13), run
 * on the memory backend and, with DORIC_TEST_DATABASE_URL, on PostgreSQL.
 * `second` is another store over the same storage, as another host process
 * (or a restarted one) would read it.
 */

interface Context extends RuntimeStores {
  readonly backend: Backend;
  readonly second: RuntimeStores;
}

const storeTest = (name: string, run: (context: Context) => Promise<void>) => {
  for (const { name: backendName, open, skip } of backends)
    void test(`${name} (${backendName})`, { skip }, async () => {
      const backend = await open();
      try {
        await run({
          ...stores(backend.storage),
          backend,
          second: stores(backend.second()),
        });
      } finally {
        await backend.close();
      }
    });
};

const promptId = randomUUID();

const messagesOf = async (
  threads: RuntimeStores['threads'],
  id: string,
): Promise<unknown> => (await threads.history(id)).read('messages');

const checkpointsOf = async (
  threads: RuntimeStores['threads'],
  id: string,
): Promise<unknown> =>
  (
    (await (await threads.history(id)).read('meta')) as
      | { checkpoints: unknown }
      | undefined
  )?.checkpoints;

storeTest(
  'keeps execution timing through rename and returns the completed duration after reopening',
  async ({ projects, threads, second }) => {
    const { project } = await projects.create('Timer', snapshot(), 'blue');
    const { thread } = await threads.create(project.id, 'Agent');
    const running = await threads.setState(thread.id, 'running', promptId);
    assert.ok(running?.executionStartedAt);
    const start = await threads.appendEvent(thread.id, promptId, {
      type: 'prompt.started',
    });
    assert.equal(
      (await threads.rename(thread.id, 'Renamed'))?.executionStartedAt,
      start.createdAt,
    );
    assert.equal(
      (await second.threads.record(thread.id))?.executionStartedAt,
      start.createdAt,
    );
    await threads.setResult(thread.id, {
      promptId,
      status: 'completed',
      text: 'Done',
      at: new Date(Date.parse(start.createdAt) + 65_000).toISOString(),
    });
    await threads.setState(thread.id, 'ready');
    const finished = await second.threads.record(thread.id);
    assert.equal(finished?.executionStartedAt, undefined);
    assert.equal(finished?.lastExecutionMs, 65_000);
    assert.equal(
      (await second.threads.listByProject(project.id))[0]?.lastExecutionMs,
      65_000,
    );
  },
);

storeTest(
  'falls back to the update time while the running prompt has not started',
  async ({ projects, threads }) => {
    const { project } = await projects.create('Timer', snapshot(), 'blue');
    const { thread } = await threads.create(project.id, 'Agent');
    await threads.appendEvent(thread.id, promptId, { type: 'prompt.started' });
    const next = randomUUID();
    const running = await threads.setState(thread.id, 'running', next);
    assert.equal(running?.executionStartedAt, running?.updatedAt);
    assert.equal(running?.lastExecutionMs, undefined);
  },
);

storeTest(
  'stores acceptance and queue receipt atomically, including their sequence cursor',
  async ({ projects, threads, second }) => {
    const { project } = await projects.create('Queue', snapshot(), 'blue');
    const { thread } = await threads.create(project.id, 'Thread');
    const accepted = {
      type: 'prompt.accepted',
      text: 'Waiting input',
      source: { kind: 'user' },
      queued: true,
    };
    await assert.rejects(
      threads.appendEvents(thread.id, promptId, [
        accepted,
        { type: 'prompt.queued', invalid: 1n },
      ]),
    );
    assert.equal((await second.threads.eventsAfter(thread.id, 0)).length, 0);
    assert.equal(
      (await second.threads.find(thread.id))?.thread.lastSequence,
      0,
    );
    const written = await threads.appendEvents(thread.id, promptId, [
      accepted,
      { type: 'prompt.queued' },
    ]);
    const stored = await second.threads.eventsAfter(thread.id, 0);
    assert.deepEqual(
      stored.map((event) => [event.type, event.sequence]),
      [
        ['prompt.accepted', 1],
        ['prompt.queued', 2],
      ],
    );
    // One commit: both carry the same commit time, and the live answer is
    // what a replay reads.
    assert.deepEqual(written, stored);
    assert.equal(stored[0]?.createdAt, stored[1]?.createdAt);
    const queue = await second.threads.queue(thread.id);
    assert.equal(queue?.items[0]?.preview, 'Waiting input');
    assert.equal(queue?.items[0]?.acceptedAt, stored[0]?.createdAt);
    assert.equal(queue?.revision, 2);
  },
);

storeTest(
  'sums descendant charges once and keeps costs through rewind and reconnection',
  async ({ projects, threads, second, backend }) => {
    const { project } = await projects.create('Usage', snapshot(), 'blue');
    const root = await threads.create(project.id, 'Parent');
    const child = await threads.create(project.id, 'Child', root.thread.id);
    const grandchild = await threads.create(
      project.id,
      'Grandchild',
      child.thread.id,
    );
    const unrelated = await threads.create(project.id, 'Other');
    for (const [record, amount] of [
      [root, 0.25],
      [child, 0.5],
      [grandchild, 0],
      [unrelated, 9],
    ] as const) {
      const id = record.thread.id;
      await saveCheckpoint(threads, id, promptId);
      await threads.appendEvent(id, promptId, {
        type: 'response.started',
        provider: 'unified',
        model: 'm',
        contextWindow: 200000,
      });
      const usage = {
        inputTokens: 48000,
        outputTokens: 200,
        cost: { amount, unit: 'credits' },
      };
      await threads.appendEvent(id, promptId, { type: 'usage', usage });
      await threads.appendEvent(id, promptId, {
        type: 'response.finished',
        finish: { usage },
      });
    }
    const before = await threads.usage(root.thread.id);
    assert.equal(before?.total.cost, 0.75);
    assert.equal(before?.total.calls, 3);
    assert.deepEqual(
      before?.threads.map(({ name, parentThreadId }) => [name, parentThreadId]),
      [
        ['Parent', undefined],
        ['Child', root.thread.id],
        ['Grandchild', child.thread.id],
      ],
    );
    assert.equal(before?.context?.inputTokens, 48000);
    assert.equal(before?.context?.contextWindow, 200000);
    await threads.rewind(root.thread.id, promptId);
    const after = await second.threads.usage(root.thread.id);
    assert.equal(after?.total.cost, 0.75);
    assert.equal(after?.context, undefined);
    assert.equal(
      (await second.threads.usage(child.thread.id))?.total.cost,
      0.5,
    );
    // A Thread migrated from before the aggregate has only its usage events.
    const stored = await backend.storage.get({
      type: 'runtime.thread/v1',
      id: child.thread.id,
    });
    assert.ok(stored);
    await backend.storage.commit({
      expect: [
        {
          type: 'runtime.thread/v1',
          id: child.thread.id,
          revision: stored.revision,
        },
      ],
      put: [
        {
          type: 'runtime.thread/v1',
          id: child.thread.id,
          value: { ...(stored.value as object), usage: null },
        },
      ],
    });
    assert.equal(
      (await stores(backend.second()).threads.usage(root.thread.id))?.total
        .cost,
      0.75,
    );
    assert.equal(await threads.usage(randomUUID()), undefined);
  },
);

storeTest(
  'creates projects without threads and captures immutable configuration',
  async ({ projects, threads }) => {
    const initial = snapshot();
    const first = await projects.create('First project', initial, 'blue');
    assert.equal(first.project.name, 'First project');
    assert.equal(first.snapshot, initial);
    assert.deepEqual(await threads.listByProject(first.project.id), []);
    const second = await projects.create(
      'Second project',
      snapshot('replacement'),
      'blue',
    );
    assert.deepEqual(
      (await projects.find(first.project.id))?.snapshot,
      initial,
    );
    assert.deepEqual(
      (await projects.find(second.project.id))?.snapshot,
      snapshot('replacement'),
    );
    assert.equal(
      (await projects.rename(first.project.id, 'Renamed project'))?.name,
      'Renamed project',
    );
    assert.equal('configSnapshot' in first.project, false);
    assert.deepEqual(Object.keys(first.project), [
      'id',
      'name',
      'color',
      'state',
      'configRevision',
      'createdAt',
      'updatedAt',
    ]);
    assert.equal(first.project.state, 'queued');
    assert.equal(first.project.configRevision, 3);
  },
);

storeTest(
  'recolors a Project and clears its color, and answers nothing for a missing one',
  async ({ projects }) => {
    const { project } = await projects.create('Color', snapshot(), 'blue');
    assert.equal((await projects.setColor(project.id, 'teal'))?.color, 'teal');
    const cleared = await projects.setColor(project.id, undefined);
    assert.equal(cleared !== undefined && 'color' in cleared, false);
    assert.equal(await projects.setColor(randomUUID(), 'red'), undefined);
    assert.equal(await projects.rename(randomUUID(), 'x'), undefined);
  },
);

storeTest(
  'persists independent histories and exact redacted events',
  async ({ projects, threads, second }) => {
    const { project } = await projects.create('Project', snapshot(), 'blue');
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
    const before = (await threads.record(child.id))?.updatedAt;
    await saveMessages(threads, child.id, messages);
    assert.ok(
      ((await threads.record(child.id))?.updatedAt ?? '') >= (before ?? ''),
    );
    const value = {
      type: 'tool.finished',
      output: { token: '[REDACTED]', nested: [null, 42] },
    };
    await threads.appendEvent(child.id, promptId, value);
    const history = await second.threads.history(child.id);
    assert.equal(history.format, testFormat);
    assert.deepEqual(await history.read('messages'), messages);
    assert.equal(await history.read('absent'), undefined);
    const empty = await second.threads.history(root.id);
    assert.equal(empty.format, undefined);
    assert.equal(await empty.read('messages'), undefined);
    assert.deepEqual((await threads.eventsAfter(child.id, 0))[0]?.event, value);
    assert.deepEqual(await threads.eventsAfter(root.id, 0), []);
    await assert.rejects(saveMessages(threads, randomUUID(), messages));
  },
);

storeTest(
  'stores event, history and result text PostgreSQL refuses as replacement characters',
  async ({ projects, threads }) => {
    const { project } = await projects.create('Project', snapshot(), 'blue');
    const { thread } = await threads.create(project.id, 'Thread');
    // A search or read over a binary file returns bytes no PostgreSQL string
    // accepts: U+0000, and surrogates no pair completes. Astral pairs are text
    // and must survive untouched.
    await threads.appendEvent(thread.id, promptId, {
      type: 'tool.finished',
      output: 'before\u0000after\uD800tail 😀',
    });
    assert.deepEqual((await threads.eventsAfter(thread.id, 0))[0]?.event, {
      type: 'tool.finished',
      output: 'before�after�tail 😀',
    });
    await saveMessages(threads, thread.id, [{ content: 'a\u0000b' }]);
    assert.deepEqual(await messagesOf(threads, thread.id), [
      { content: 'a�b' },
    ]);
    await threads.setResult(thread.id, {
      status: 'completed',
      text: 'report\u0000published',
      promptId,
      at: '2026-01-01T00:00:00.000Z',
    });
    assert.deepEqual((await threads.record(thread.id))?.result, {
      status: 'completed',
      text: 'report�published',
      promptId,
      at: '2026-01-01T00:00:00.000Z',
    });
  },
);

storeTest(
  'stores a Thread working directory with its hint, and lets a child inherit both',
  async ({ projects, threads }) => {
    const { project } = await projects.create('Project', snapshot(), 'blue');
    const root = (await threads.create(project.id, 'Root')).thread;
    assert.equal(root.cwd, '/workspace');
    assert.equal(root.cwdRepo, undefined);

    const moved = await threads.setCwd(root.id, '/workspace/doric', 'github');
    assert.equal(moved?.cwd, '/workspace/doric');
    assert.equal(moved?.cwdRepo, 'github');
    assert.deepEqual(await threads.record(root.id), moved);

    const child = (
      await threads.create(project.id, 'Child', root.id, {
        cwd: '/workspace/doric',
        cwdRepo: 'github',
      })
    ).thread;
    assert.equal(child.cwd, '/workspace/doric');
    assert.equal(child.cwdRepo, 'github');

    const deeper = await threads.setCwd(root.id, '/workspace/doric/src');
    assert.equal(deeper?.cwd, '/workspace/doric/src');
    assert.equal(deeper?.cwdRepo, undefined);
    assert.equal((await threads.record(child.id))?.cwdRepo, 'github');

    assert.equal(await threads.setCwd(randomUUID(), '/workspace'), undefined);
  },
);

storeTest(
  'reads a thread or project record alone and answers nothing when it is missing',
  async ({ projects, threads }) => {
    const { project } = await projects.create('Project', snapshot(), 'blue');
    const { thread } = await threads.create(project.id, 'Thread');
    assert.deepEqual(
      await threads.record(thread.id),
      (await threads.find(thread.id))?.thread,
    );
    assert.deepEqual(Object.keys(thread), [
      'id',
      'projectId',
      'name',
      'state',
      'queuePaused',
      'lastSequence',
      'cwd',
      'createdAt',
      'updatedAt',
    ]);
    assert.deepEqual(
      await projects.record(project.id),
      (await projects.find(project.id))?.project,
    );
    const missing = randomUUID();
    assert.equal(await threads.record(missing), undefined);
    assert.equal(await threads.find(missing), undefined);
    assert.equal(await projects.record(missing), undefined);
    assert.equal(await projects.find(missing), undefined);
  },
);

storeTest(
  'serializes event sequences across independent clients and rolls back failed insertion',
  async ({ projects, threads, second }) => {
    const { project } = await projects.create('Project', snapshot(), 'blue');
    const { thread } = await threads.create(project.id, 'Thread');
    const other = second.threads;
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
    assert.deepEqual(await threads.eventsAfter(thread.id, 99), []);
    assert.deepEqual(await threads.eventsAfter(randomUUID(), 0), []);
    assert.deepEqual(events[0] && Object.keys(events[0]), [
      'projectId',
      'threadId',
      'promptId',
      'sequence',
      'type',
      'event',
      'createdAt',
    ]);
    assert.equal(
      (await threads.appendEvent(thread.id, promptId, 'plain')).type,
      'unknown',
    );
  },
);

storeTest(
  'pages events after a sequence and says where the next page starts',
  async ({ projects, threads }) => {
    const { project } = await projects.create('Project', snapshot(), 'blue');
    const { thread } = await threads.create(project.id, 'Thread');
    await threads.appendEvents(
      thread.id,
      promptId,
      Array.from({ length: 5 }, (_, index) => ({ type: 'delta', index })),
    );
    const first = await threads.eventsAfterPage(thread.id, 0, 2);
    assert.deepEqual(
      first.events.map(({ sequence }) => sequence),
      [1, 2],
    );
    assert.equal(first.nextSequence, 2);
    const last = await threads.eventsAfterPage(thread.id, 3, 2);
    assert.deepEqual(
      last.events.map(({ sequence }) => sequence),
      [4, 5],
    );
    assert.equal(last.nextSequence, undefined);
    assert.deepEqual(await threads.eventsAfterPage(thread.id, 5, 2), {
      events: [],
    });
    await assert.rejects(threads.eventsAfterPage(thread.id, 0, 0), TypeError);
  },
);

storeTest(
  'rewinds a Thread onto an earlier turn boundary without reusing sequences',
  async ({ projects, threads, second }) => {
    const { project } = await projects.create('Project', snapshot(), 'blue');
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
    for (const [index, id] of ids.entries()) {
      await saveCheckpoint(threads, thread.id, id);
      await threads.appendEvent(thread.id, id, {
        type: 'prompt.accepted',
      });
      await saveMessages(
        threads,
        thread.id,
        messages.slice(0, (index + 1) * 2),
      );
    }
    assert.deepEqual(await checkpointsOf(threads, thread.id), {
      [ids[0]]: 0,
      [ids[1]]: 2,
      [ids[2]]: 4,
    });

    const marker = await threads.rewind(thread.id, ids[1]);

    assert.equal(marker?.sequence, 4);
    assert.equal(marker?.type, 'history.truncated');
    assert.equal(marker?.promptId, ids[1]);
    assert.deepEqual(marker?.event, {
      type: 'history.truncated',
      afterSequence: 1,
    });
    const replay = await second.threads.eventsAfter(thread.id, 0);
    assert.deepEqual(
      replay.map(({ sequence }) => sequence),
      [1, 4],
    );
    assert.deepEqual(replay[1], marker);
    assert.equal((await second.threads.record(thread.id))?.lastSequence, 4);
    assert.deepEqual(
      await messagesOf(second.threads, thread.id),
      messages.slice(0, 2),
    );
    assert.deepEqual(await checkpointsOf(second.threads, thread.id), {
      [ids[0]]: 0,
    });
    // The rewound prompts are no longer pending; the survivor still is.
    assert.deepEqual(
      (await second.threads.unfinishedPrompts(thread.id)).map(
        ({ promptId: id }) => id,
      ),
      [ids[0]],
    );
    assert.equal(await threads.rewind(thread.id, ids[1]), undefined);
    assert.equal(await threads.rewind(thread.id, ids[2]), undefined);
    assert.equal(await threads.rewind(thread.id, randomUUID()), undefined);
    assert.equal(await threads.rewind(randomUUID(), ids[0]), undefined);
    // The next event continues after the marker.
    assert.equal(
      (await threads.appendEvent(thread.id, ids[0], { type: 'next' })).sequence,
      5,
    );
  },
);

storeTest(
  'refuses a rewind the executor has no turn boundary for',
  async ({ projects, threads }) => {
    const { project } = await projects.create('Project', snapshot(), 'blue');
    const { thread } = await threads.create(project.id, 'Thread');
    await threads.appendEvent(thread.id, promptId, { type: 'prompt.accepted' });
    assert.equal(await threads.rewind(thread.id, promptId), undefined);
    assert.equal((await threads.record(thread.id))?.lastSequence, 1);
  },
);

storeTest(
  'records each turn boundary once, so a resumed turn keeps the one it began at',
  async ({ projects, threads }) => {
    const { project } = await projects.create('Project', snapshot(), 'blue');
    const { thread } = await threads.create(project.id, 'Thread');
    const id = randomUUID();
    await saveCheckpoint(threads, thread.id, id);
    await saveMessages(threads, thread.id, [
      { role: 'user', content: 'input' },
      { role: 'assistant', content: 'partial' },
    ]);
    const before = (await threads.record(thread.id))?.updatedAt;
    await saveCheckpoint(threads, thread.id, id);
    assert.deepEqual(await checkpointsOf(threads, thread.id), { [id]: 0 });
    // The checkpoint write does not move the record's update time.
    assert.equal((await threads.record(thread.id))?.updatedAt, before);
    // Nor does it write anything for a missing Thread.
    await saveCheckpoint(threads, randomUUID(), id);
  },
);

storeTest(
  'preserves terminal and cancelling states and clears the active prompt when not running',
  async ({ projects, threads }) => {
    const { project } = await projects.create('Project', snapshot(), 'blue');
    const { thread } = await threads.create(project.id, 'Thread');
    const ready = await threads.setState(thread.id, 'ready');
    assert.ok(ready?.startedAt);
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
    const readyAgain = await threads.setState(thread.id, 'ready');
    assert.equal(readyAgain?.activePromptId, undefined);
    assert.equal(readyAgain?.startedAt, ready?.startedAt);
    const cancelled = await threads.setState(thread.id, 'cancelled');
    assert.ok(cancelled?.finishedAt);
    assert.equal(
      (await threads.setState(thread.id, 'failed', undefined, 'late'))?.state,
      'cancelled',
    );
    assert.equal(await threads.setState(randomUUID(), 'ready'), undefined);
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
    assert.equal(await projects.setState(randomUUID(), 'ready'), undefined);
  },
);

storeTest(
  'scopes pagination cursors to their project and parent',
  async ({ projects, threads }) => {
    const first = (await projects.create('First', snapshot(), 'blue')).project;
    const second = (await projects.create('Second', snapshot(), 'blue'))
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
    assert.deepEqual((await projects.list(1, randomUUID())).items, []);
    await assert.rejects(projects.list(0), TypeError);
    await assert.rejects(threads.list(first.id, 1.5), TypeError);
  },
);

storeTest(
  'lists newest first by creation time then id, and a Project oldest first',
  async ({ projects, threads }) => {
    const { project } = await projects.create('Order', snapshot(), 'blue');
    const created = [];
    for (const name of ['a', 'b', 'c', 'd', 'e'])
      created.push((await threads.create(project.id, name)).thread);
    const expected = [...created]
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? b.id.localeCompare(a.id)
          : b.createdAt.localeCompare(a.createdAt),
      )
      .map(({ id }) => id);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await threads.list(project.id, 2, cursor);
      seen.push(...page.items.map(({ id }) => id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    assert.deepEqual(seen, expected);
    assert.deepEqual(
      (await threads.listByProject(project.id)).map(({ id }) => id),
      [...expected].reverse(),
    );
  },
);

storeTest(
  'enforces same-project live parentage when a Thread is created',
  async ({ projects, threads }) => {
    const first = (await projects.create('First', snapshot(), 'blue')).project;
    const second = (await projects.create('Second', snapshot(), 'blue'))
      .project;
    const root = (await threads.create(first.id, 'Root')).thread;
    const child = (await threads.create(first.id, 'Child', root.id)).thread;
    await assert.rejects(threads.create(second.id, 'Invalid', root.id), {
      message: 'Invalid parent thread.',
    });
    await assert.rejects(threads.create(first.id, 'Invalid', randomUUID()), {
      message: 'Invalid parent thread.',
    });
    await threads.setState(root.id, 'cancelling');
    // Any terminating or terminal ancestor refuses, not only the parent.
    await assert.rejects(threads.create(first.id, 'Grandchild', child.id), {
      message: 'Invalid parent thread.',
    });
    await projects.setState(second.id, 'cancelling');
    await assert.rejects(threads.create(second.id, 'Late'), {
      message: 'Inactive project.',
    });
    assert.equal(
      (await threads.find(child.id))?.thread.parentThreadId,
      root.id,
    );
  },
);

storeTest(
  'deletes only fully terminal subtrees without affecting other roots',
  async ({ projects, threads, backend }) => {
    const { project } = await projects.create('Project', snapshot(), 'blue');
    const root = (await threads.create(project.id, 'Root')).thread;
    const child = (await threads.create(project.id, 'Child', root.id)).thread;
    const grandchild = (
      await threads.create(project.id, 'Grandchild', child.id)
    ).thread;
    const sibling = (await threads.create(project.id, 'Sibling')).thread;
    await threads.appendEvent(grandchild.id, promptId, { type: 'saved' });
    await saveMessages(threads, grandchild.id, [{ content: 'kept' }]);
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
    assert.equal(await messagesOf(threads, grandchild.id), undefined);
    assert.equal(
      (
        await backend.storage.read({
          stream: `runtime.thread.events/${grandchild.id}`,
          afterSequence: 0,
          limit: 1,
        })
      ).lastSequence,
      0,
    );
    assert.ok(await threads.find(sibling.id));
    await projects.setState(project.id, 'cancelled');
    assert.equal(await projects.delete(project.id), 'active');
    await threads.setState(sibling.id, 'failed');
    assert.equal(await projects.delete(project.id), 'deleted');
    assert.equal(await threads.find(sibling.id), undefined);
    assert.equal(await projects.find(project.id), undefined);
    assert.equal(await projects.delete(project.id), 'missing');
    assert.equal(await threads.deleteSubtree(root.id), 'missing');
  },
);

storeTest(
  'refuses to delete a Project that is not terminal',
  async ({ projects }) => {
    const { project } = await projects.create('Project', snapshot(), 'blue');
    assert.equal(await projects.delete(project.id), 'active');
    await projects.setState(project.id, 'failed');
    assert.equal(await projects.delete(project.id), 'deleted');
  },
);

storeTest(
  'resumes nonterminal records, pausing an interrupted prompt and preserving history',
  async ({ projects, threads, second }) => {
    const config = snapshot();
    const parentId = randomUUID();
    const projectCases = [];
    for (const state of [
      'queued',
      'ready',
      'cancelling',
      'failed',
      'cancelled',
    ] as const) {
      const { project } = await projects.create('Project', config, 'blue');
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
            { role: 'user', content: `Preserve ${threadState} conversation` },
            {
              role: 'assistant',
              content: 'Partial answer',
              replay: [{ encrypted_content: 'opaque' }],
            },
          ];
          await saveMessages(threads, thread.id, messages);
          if (threadState === 'running') {
            await threads.appendEvent(thread.id, promptId, {
              type: 'prompt.accepted',
              text: 'interrupted',
              source: { kind: 'parent', threadId: parentId, promptId },
            });
            await threads.appendEvent(thread.id, promptId, {
              type: 'agent.started',
              model: 'test-model',
              input: 'interrupted',
            });
          }
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
          const before = await threads.find(thread.id);
          assert.ok(before !== undefined);
          threadCases.push({ before, event, messages });
        }
      }
      await projects.setState(project.id, state, 'original');
      const before = await projects.find(project.id);
      assert.ok(before !== undefined);
      projectCases.push({ before, threadCases });
    }
    // Only the resumed records are counted: the queued and running Threads,
    // and the ready Project.
    assert.equal(await second.threads.reconcile(), 2);
    assert.equal(await second.projects.reconcile(), 1);
    for (const { before, threadCases } of projectCases) {
      const after = await projects.find(before.project.id);
      assert.ok(after !== undefined);
      const terminal = ['failed', 'cancelled'].includes(before.project.state);
      const cancelling = before.project.state === 'cancelling';
      assert.equal(
        after.project.state,
        terminal ? before.project.state : cancelling ? 'cancelled' : 'queued',
      );
      assert.equal(after.project.errorCode, terminal ? 'original' : undefined);
      if (cancelling) assert.ok(after.project.finishedAt !== undefined);
      assert.deepEqual(after.snapshot, config);
      if (terminal) assert.deepEqual(after, before);
      for (const { before: record, event, messages } of threadCases) {
        const restored = await threads.find(record.thread.id);
        assert.ok(restored !== undefined);
        const terminalThread = ['failed', 'cancelled'].includes(
          record.thread.state,
        );
        const cancellingThread = record.thread.state === 'cancelling';
        assert.equal(
          restored.thread.state,
          terminalThread
            ? record.thread.state
            : cancellingThread
              ? 'cancelled'
              : 'ready',
        );
        if (cancellingThread)
          assert.ok(restored.thread.finishedAt !== undefined);
        assert.equal(
          restored.thread.errorCode,
          terminalThread ? 'original' : undefined,
        );
        assert.equal(restored.thread.activePromptId, undefined);
        assert.deepEqual(await messagesOf(threads, record.thread.id), messages);
        if (terminalThread) {
          assert.deepEqual(restored, record);
          assert.deepEqual(await threads.eventsAfter(record.thread.id, 0), [
            event,
          ]);
          continue;
        }
        if (record.thread.state === 'running') {
          const events = await threads.eventsAfter(record.thread.id, 0);
          assert.deepEqual(events.at(-1)?.event, {
            type: 'prompt.paused',
            reason: 'host_restarted',
          });
          assert.equal(events.at(-1)?.promptId, promptId);
          assert.equal(restored.thread.result, undefined);
          assert.equal(
            events.some(({ type }) => type === 'prompt.finished'),
            false,
          );
          assert.equal(
            restored.thread.lastSequence,
            record.thread.lastSequence + 1,
          );
          const [paused] = await threads.unfinishedPrompts(record.thread.id);
          assert.equal(paused?.paused, 'host_restarted');
          assert.equal(paused?.started, true);
        } else {
          assert.equal(
            restored.thread.lastSequence,
            record.thread.lastSequence,
          );
          assert.deepEqual(await threads.eventsAfter(record.thread.id, 0), [
            event,
          ]);
        }
      }
    }
    assert.equal(await threads.reconcile(), 0);
    assert.equal(await projects.reconcile(), 0);
  },
);

storeTest(
  'keeps a storage pause and its error through a restart',
  async ({ projects, threads }) => {
    const { project } = await projects.create('Project', snapshot(), 'blue');
    const { thread } = await threads.create(project.id, 'Thread');
    await threads.setState(thread.id, 'ready');
    await threads.appendEvent(thread.id, promptId, {
      type: 'queue.paused',
      reason: 'storage_low',
    });
    const paused = await threads.record(thread.id);
    assert.equal(paused?.queuePaused, true);
    assert.equal(paused?.errorCode, 'storage_low');
    assert.equal((await threads.queue(thread.id))?.error?.code, 'storage_low');
    assert.equal(await threads.reconcile(), 0);
    assert.equal((await threads.record(thread.id))?.errorCode, 'storage_low');
    await threads.appendEvent(thread.id, promptId, { type: 'queue.resumed' });
    assert.equal((await threads.record(thread.id))?.queuePaused, false);
    // The resume does not clear the error; the next state write does.
    assert.equal((await threads.record(thread.id))?.errorCode, 'storage_low');
    await threads.appendEvent(thread.id, promptId, {
      type: 'queue.paused',
      reason: 'reader_stopped',
    });
    assert.equal((await threads.record(thread.id))?.queuePaused, true);
  },
);

storeTest(
  'leaves an accepted prompt that never started unfinished for the boot',
  async ({ projects, threads }) => {
    const { project } = await projects.create('Project', snapshot(), 'blue');
    const { thread } = await threads.create(project.id, 'Thread');
    const queuedPromptId = randomUUID();
    await threads.setState(thread.id, 'ready');
    const accepted = await threads.appendEvent(thread.id, queuedPromptId, {
      type: 'prompt.accepted',
      text: 'queued',
      source: { kind: 'user' },
    });
    assert.equal(await threads.reconcile(), 0);
    const restored = await threads.find(thread.id);
    assert.ok(restored !== undefined);
    assert.equal(restored.thread.state, 'ready');
    assert.equal(restored.thread.result, undefined);
    assert.deepEqual(
      (await threads.eventsAfter(thread.id, 0)).map(({ event }) => event),
      [{ type: 'prompt.accepted', text: 'queued', source: { kind: 'user' } }],
    );
    assert.deepEqual(await threads.unfinishedPrompts(thread.id), [
      {
        projectId: project.id,
        threadId: thread.id,
        promptId: queuedPromptId,
        text: 'queued',
        revision: 1,
        source: { kind: 'user' },
        started: false,
        attempts: 0,
        acceptedAt: accepted.createdAt,
        queuedSequence: 1,
      },
    ]);
  },
);

storeTest(
  'lists every unfinished prompt of open Threads in the order the logs accepted them',
  async ({ projects, threads }) => {
    const { project } = await projects.create('Project', snapshot(), 'blue');
    const a = (await threads.create(project.id, 'A')).thread;
    const b = (await threads.create(project.id, 'B')).thread;
    const closed = (await threads.create(project.id, 'Closed')).thread;
    const ids = Array.from({ length: 4 }, () => randomUUID());
    const accept = (thread: string, id: string) =>
      threads.appendEvent(thread, id, {
        type: 'prompt.accepted',
        text: id,
        source: { kind: 'user' },
        queued: true,
      });
    await accept(b.id, ids[0] as string); // b:1
    await accept(a.id, ids[1] as string); // a:1
    await accept(a.id, ids[2] as string); // a:2
    await accept(b.id, ids[3] as string); // b:2
    await accept(closed.id, randomUUID());
    await threads.setState(closed.id, 'failed');
    const expected = [
      ...[
        [a.id, ids[1]],
        [b.id, ids[0]],
      ].sort(([x], [y]) => ((x ?? '') < (y ?? '') ? -1 : 1)),
      ...[
        [a.id, ids[2]],
        [b.id, ids[3]],
      ].sort(([x], [y]) => ((x ?? '') < (y ?? '') ? -1 : 1)),
    ];
    assert.deepEqual(
      (await threads.unfinishedPrompts()).map(({ threadId, promptId: id }) => [
        threadId,
        id,
      ]),
      expected,
    );
    assert.deepEqual(await threads.unfinishedPrompts(closed.id), []);
  },
);

storeTest(
  'closes an exhausted delegated prompt and delivers its failure to the live parent once',
  async ({ projects, threads, second }) => {
    const { project } = await projects.create('Project', snapshot(), 'blue');
    const parent = (await threads.create(project.id, 'Parent')).thread;
    const child = (await threads.create(project.id, 'Child', parent.id)).thread;
    const request = randomUUID();
    await threads.appendEvent(child.id, promptId, {
      type: 'prompt.accepted',
      text: 'do it',
      source: { kind: 'parent', threadId: parent.id, promptId: request },
    });
    await threads.appendEvent(child.id, promptId, { type: 'prompt.started' });
    const [progress] = await threads.unfinishedPrompts(child.id);
    assert.ok(progress);
    const failure = {
      name: 'ResumeExhaustedError',
      code: 'resume_exhausted',
      message: 'gave up',
    };
    await threads.failPrompt(progress, failure);
    // A second close of the same prompt is a no-op.
    await second.threads.failPrompt(progress, failure);
    const events = await threads.eventsAfter(child.id, 0);
    assert.deepEqual(
      events.slice(2).map(({ event }) => event),
      [
        { type: 'agent.failed', error: failure },
        {
          type: 'prompt.finished',
          status: 'failed',
          text: 'The prompt failed.',
          source: { kind: 'parent', threadId: parent.id, promptId: request },
        },
      ],
    );
    const record = await threads.record(child.id);
    assert.equal(record?.result?.status, 'failed');
    assert.equal(record?.result?.text, 'The prompt failed.');
    assert.equal(record?.result?.promptId, promptId);
    assert.deepEqual(await threads.unfinishedPrompts(child.id), []);
    const delivered = await threads.eventsAfter(parent.id, 0);
    assert.deepEqual(
      delivered.map(({ type }) => type),
      ['prompt.accepted', 'prompt.queued'],
    );
    assert.equal(delivered[0]?.promptId, delivered[1]?.promptId);
    assert.deepEqual(
      (delivered[0]?.event as { source?: unknown } | undefined)?.source,
      {
        kind: 'result',
        threadId: child.id,
        promptId,
        requestPromptId: request,
      },
    );
    assert.equal(
      (delivered[0]?.event as { text?: string } | undefined)?.text,
      [
        '# Delegated task result',
        '',
        `Child thread: ${child.id}`,
        `Child prompt: ${promptId}`,
        `Originating prompt: ${request}`,
        'Status: failed',
        '',
        '## Result',
        '',
        'gave up',
      ].join('\n'),
    );
    const [queued] = await threads.unfinishedPrompts(parent.id);
    assert.equal(queued?.source.kind, 'result');
    assert.equal(queued?.acceptedAt, delivered[0]?.createdAt);
  },
);

storeTest(
  'does not deliver a closed prompt to a terminating parent',
  async ({ projects, threads }) => {
    const { project } = await projects.create('Project', snapshot(), 'blue');
    const parent = (await threads.create(project.id, 'Parent')).thread;
    const child = (await threads.create(project.id, 'Child', parent.id)).thread;
    await threads.appendEvent(child.id, promptId, {
      type: 'prompt.accepted',
      text: 'do it',
      source: { kind: 'parent', threadId: parent.id, promptId: randomUUID() },
    });
    await threads.setState(parent.id, 'cancelling');
    const [progress] = await threads.unfinishedPrompts(child.id);
    assert.ok(progress);
    await threads.failPrompt(progress, {
      name: 'Error',
      code: 'x',
      message: 'm',
    });
    assert.deepEqual(await threads.eventsAfter(parent.id, 0), []);
    assert.equal((await threads.eventsAfter(child.id, 0)).length, 3);
  },
);

storeTest(
  'answers the queue snapshot with names, the current prompt and the reader pause',
  async ({ projects, threads }) => {
    const { project } = await projects.create('Project', snapshot(), 'blue');
    const parent = (await threads.create(project.id, 'Planner')).thread;
    const { thread } = await threads.create(project.id, 'Worker', parent.id);
    const [running, waiting, paused] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    await threads.appendEvent(thread.id, paused, {
      type: 'prompt.accepted',
      text: 'paused one',
      source: { kind: 'user' },
    });
    await threads.appendEvent(thread.id, paused, { type: 'prompt.started' });
    await threads.appendEvent(thread.id, paused, {
      type: 'prompt.paused',
      reason: 'reader_stopped',
    });
    await threads.appendEvent(thread.id, running, {
      type: 'prompt.accepted',
      text: 'from   the\nparent',
      source: { kind: 'parent', threadId: parent.id, promptId: randomUUID() },
      queued: true,
    });
    await threads.appendEvent(thread.id, waiting, {
      type: 'prompt.accepted',
      text: 'later',
      source: { kind: 'user' },
      queued: true,
    });
    await threads.setState(thread.id, 'running', running);
    const queue = await threads.queue(thread.id);
    assert.equal(queue?.current?.promptId, running);
    assert.equal(queue?.current?.label, 'Parent · Planner');
    assert.equal(queue?.current?.preview, 'from the parent');
    assert.equal(queue?.resumable?.promptId, paused);
    assert.deepEqual(
      queue?.items.map(({ promptId: id, editable }) => [id, editable]),
      [[waiting, true]],
    );
    assert.equal(queue?.paused, false);
    assert.equal(await threads.queue(randomUUID()), undefined);
  },
);

void test('refuses a Project deletion over the backend batch limit without removing anything', async () => {
  const backend = memoryBackend({ maxBatch: 6 });
  try {
    const { projects, threads } = stores(backend.storage);
    const { project } = await projects.create('Large', snapshot(), 'blue');
    const ids = [];
    for (const name of ['a', 'b', 'c']) {
      const { thread } = await threads.create(project.id, name);
      await threads.appendEvent(thread.id, promptId, { type: 'saved' });
      await threads.setState(thread.id, 'failed');
      ids.push(thread.id);
    }
    await projects.setState(project.id, 'cancelled');
    await assert.rejects(projects.delete(project.id), {
      code: 'limit_exceeded',
    });
    assert.ok(await projects.find(project.id));
    for (const id of ids) {
      assert.ok(await threads.find(id));
      assert.equal((await threads.eventsAfter(id, 0)).length, 1);
    }
  } finally {
    await backend.close();
  }
});
