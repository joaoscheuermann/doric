// The fake of `runtime/testing` (bundle isolation phase 3, T3.8): its reads
// answer from the options, a pending read waits and a failing one fails; its
// writes change what the reads answer, as the host would, and call the
// subscribers.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createTestServices } from 'bundle/testing';

import {
  type Project,
  type ProjectActivity,
  RuntimeRecordsV1,
  type Thread,
} from '../src/contracts/index.js';
import { createRecordsApi, createRecordsFake } from '../src/testing.js';

const project = (id: string): Project => ({
  id,
  name: `Project ${id}`,
  state: 'ready',
  configRevision: 0,
  createdAt: '',
  updatedAt: '',
});

const thread = (
  id: string,
  projectId: string,
  extra: Partial<Thread> = {},
): Thread => ({
  id,
  projectId,
  name: `Thread ${id}`,
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '',
  updatedAt: '',
  ...extra,
});

const projects = [project('p1'), project('p2')];
const threads = [
  thread('root', 'p1'),
  thread('child', 'p1', { parentThreadId: 'root' }),
  thread('grandchild', 'p1', { parentThreadId: 'child' }),
  thread('running', 'p1', { parentThreadId: 'root', state: 'running' }),
  thread('pinned', 'p1', { parentThreadId: 'root', pinned: true }),
  thread('sibling', 'p1'),
  thread('other', 'p2'),
];
const activity: ProjectActivity[] = [
  { project: project('p1'), activityAt: '2026-11-18T12:00:00.000Z' },
];

const ids = (values: readonly { readonly id: string }[] | undefined) =>
  (values ?? []).map(({ id }) => id);

/** Whether `promise` settles once every pending callback has run. */
const settles = async (promise: Promise<unknown>): Promise<boolean> => {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let round = 0; round < 10; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return settled;
};

const unreachable = {
  code: 'unavailable',
  message: 'The host is unreachable.',
};

describe('reads', () => {
  test('answer ready at once from the options', async () => {
    const api = createRecordsApi({ projects, threads, activity });

    assert.deepEqual(api.projects(), { status: 'ready', value: projects });
    assert.deepEqual(api.project('p2'), project('p2'));
    assert.deepEqual(api.threads('p2'), {
      status: 'ready',
      value: [thread('other', 'p2')],
    });
    assert.deepEqual(api.thread('other'), thread('other', 'p2'));
    assert.equal(api.connection(), 'connected');
    assert.deepEqual(await api.activity(), activity);
    assert.deepEqual(
      await api.findThread({ threadId: 'child' }),
      threads.find(({ id }) => id === 'child'),
    );
    assert.equal(await api.findThread({ threadId: 'absent' }), undefined);
  });

  test('a Project is described from the first threads(projectId) call on', () => {
    const api = createRecordsApi({ projects, threads });

    assert.equal(api.thread('root'), undefined);
    api.threads('p1');
    assert.deepEqual(api.thread('root'), thread('root', 'p1'));
  });

  test('connection answers the option', () => {
    assert.equal(
      createRecordsApi({ connection: 'disconnected' }).connection(),
      'disconnected',
    );
  });

  test('a pending read answers loading for good, and a pending promise never settles', async () => {
    const api = createRecordsApi({
      projects,
      threads,
      activity,
      pending: ['projects', 'threads', 'activity', 'findThread'],
    });

    assert.equal(api.projects().status, 'loading');
    assert.equal(api.threads('p1').status, 'loading');
    assert.equal(await settles(api.activity()), false);
    assert.equal(await settles(api.findThread({ threadId: 'root' })), false);
    assert.equal(api.projects().status, 'loading');
  });

  test('a failing read answers failed, and a failing promise rejects with an Error that has the code', async () => {
    const api = createRecordsApi({
      projects,
      threads,
      activity,
      failing: ['projects', 'threads', 'activity', 'findThread'],
    });

    const read = api.projects();
    assert.equal(read.status, 'failed');
    assert.deepEqual(
      read.status === 'failed'
        ? { code: read.error.code, message: read.error.message }
        : undefined,
      unreachable,
    );
    const threadsRead = api.threads('p1');
    assert.equal(threadsRead.status, 'failed');
    assert.equal(
      threadsRead.status === 'failed' ? threadsRead.error.code : '',
      'unavailable',
    );
    for (const promise of [
      api.activity(),
      api.findThread({ threadId: 'root' }),
    ]) {
      await assert.rejects(promise, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { code?: unknown }).code, unreachable.code);
        assert.equal(error.message, unreachable.message);
        return true;
      });
    }
  });

  test('each call makes a new, independent fake', async () => {
    const first = createRecordsApi({ projects });
    const second = createRecordsApi({ projects });

    await first.deleteProject({ projectId: 'p1' });

    assert.deepEqual(ids(first.projects().value), ['p2']);
    assert.deepEqual(ids(second.projects().value), ['p1', 'p2']);
  });
});

describe('writes', () => {
  const subscribed = () => {
    const api = createRecordsApi({ projects, threads });
    api.threads('p1');
    api.threads('p2');
    let notices = 0;
    api.subscribe(() => {
      notices += 1;
    });
    /** Runs one write and asserts that it called the subscribers. */
    const notifying = async <Value>(write: () => Promise<Value>) => {
      const before = notices;
      const result = await write();
      assert.ok(notices > before, 'the write calls the subscribers');
      return result;
    };
    return { api, notifying };
  };

  test('Project writes change what the reads answer and call the subscribers', async () => {
    const { api, notifying } = subscribed();

    const created = await notifying(() => api.createProject({ name: 'New' }));
    assert.equal(created.name, 'New');
    assert.deepEqual(api.project(created.id), created);
    assert.ok(ids(api.projects().value).includes(created.id));

    const renamed = await notifying(() =>
      api.renameProject({ projectId: 'p1', name: 'One' }),
    );
    assert.equal(renamed.name, 'One');
    assert.deepEqual(api.project('p1'), renamed);

    const colored = await notifying(() =>
      api.setProjectColor({ projectId: 'p1', color: 'blue' }),
    );
    assert.equal(colored.color, 'blue');
    assert.deepEqual(api.project('p1'), colored);

    const terminated = await notifying(() =>
      api.terminateProject({ projectId: 'p1' }),
    );
    assert.deepEqual(api.project('p1'), terminated);

    await notifying(() => api.deleteProject({ projectId: 'p2' }));
    assert.equal(api.project('p2'), undefined);
    assert.equal(api.thread('other'), undefined);
  });

  test('Thread writes change what the reads answer and call the subscribers', async () => {
    const { api, notifying } = subscribed();

    const created = await notifying(() =>
      api.createThread({
        projectId: 'p1',
        name: 'New',
        parentThreadId: 'root',
      }),
    );
    assert.equal(created.name, 'New');
    assert.equal(created.parentThreadId, 'root');
    assert.deepEqual(api.thread(created.id), created);
    assert.ok(ids(api.threads('p1').value).includes(created.id));

    const renamed = await notifying(() =>
      api.renameThread({ threadId: 'sibling', name: 'S' }),
    );
    assert.equal(renamed.name, 'S');
    assert.deepEqual(api.thread('sibling'), renamed);

    const terminated = await notifying(() =>
      api.terminateThread({ threadId: 'sibling' }),
    );
    assert.deepEqual(api.thread('sibling'), terminated);
  });

  test('a deleted Thread takes its children with it', async () => {
    const { api, notifying } = subscribed();

    await notifying(() => api.deleteThread({ threadId: 'child' }));

    assert.equal(api.thread('child'), undefined);
    assert.equal(api.thread('grandchild'), undefined);
    assert.deepEqual(ids(api.threads('p1').value), [
      'root',
      'running',
      'pinned',
      'sibling',
    ]);
  });

  test('an archive marks the target with its descendants that are not archived, busy or pinned, and a restore of its batch clears them', async () => {
    const { api, notifying } = subscribed();

    const archived = await notifying(() =>
      api.archiveThread({ threadId: 'root' }),
    );

    assert.equal(archived.threads[0]?.id, 'root');
    assert.deepEqual(ids(archived.threads).sort(), [
      'child',
      'grandchild',
      'root',
    ]);
    for (const id of ['root', 'child', 'grandchild']) {
      assert.notEqual(api.thread(id)?.archivedAt, undefined, id);
    }
    for (const id of ['running', 'pinned', 'sibling']) {
      assert.equal(api.thread(id)?.archivedAt, undefined, id);
    }

    const restored = await notifying(() =>
      api.restoreThread({ threadId: 'root', batch: archived.batch }),
    );

    assert.deepEqual(ids(restored).sort(), ['child', 'grandchild', 'root']);
    for (const id of ['root', 'child', 'grandchild']) {
      assert.equal(api.thread(id)?.archivedAt, undefined, id);
    }
  });

  test('two archives answer different batches', async () => {
    const { api } = subscribed();

    const first = await api.archiveThread({ threadId: 'child' });
    const second = await api.archiveThread({ threadId: 'sibling' });

    assert.notEqual(first.batch, second.batch);
  });

  test('setThreadPinned sets the field', async () => {
    const { api, notifying } = subscribed();

    const pinned = await notifying(() =>
      api.setThreadPinned({ threadId: 'sibling', pinned: true }),
    );
    assert.equal(pinned.pinned, true);
    assert.equal(api.thread('sibling')?.pinned, true);

    const unpinned = await notifying(() =>
      api.setThreadPinned({ threadId: 'sibling', pinned: false }),
    );
    assert.notEqual(unpinned.pinned, true);
    assert.notEqual(api.thread('sibling')?.pinned, true);
  });
});

describe('loads and presence', () => {
  test('view and follow answer a Disposable and change nothing; reload calls the subscribers', () => {
    const api = createRecordsApi({ projects, threads });
    const before = api.threads('p1');
    let notices = 0;
    const subscription = api.subscribe(() => {
      notices += 1;
    });

    const view = api.view({ threadId: 'root' });
    const follow = api.follow({ projectId: 'p1' });
    assert.equal(typeof view.dispose, 'function');
    assert.equal(typeof follow.dispose, 'function');
    view.dispose();
    follow.dispose();
    assert.deepEqual(api.threads('p1'), before);
    assert.equal(notices, 0);

    api.reload({ target: 'projects' });
    assert.ok(notices > 0);

    subscription.dispose();
    const after = notices;
    api.reload({ target: 'threads', projectId: 'p1' });
    assert.equal(notices, after);
  });

  test('a member a test replaced is what a caller reaches', async () => {
    const api = createRecordsApi({ projects, threads });
    const replacement = async () => [] as const;

    (api as { activity: typeof api.activity }).activity = replacement;

    assert.equal(api.activity, replacement);
    assert.deepEqual(await api.activity(), []);
  });
});

describe('createRecordsFake', () => {
  test('provides the same records behind runtime.records/v1', async () => {
    const definition = createRecordsFake({ projects, threads, activity });
    assert.equal(definition.id, RuntimeRecordsV1.id);

    const test = createTestServices({
      bundle: { id: 'consumer' },
      provide: [definition],
    });
    try {
      const records = test.services.use(RuntimeRecordsV1);

      assert.deepEqual(records.projects(), {
        status: 'ready',
        value: projects,
      });
      assert.deepEqual(records.threads('p2'), {
        status: 'ready',
        value: [thread('other', 'p2')],
      });
      assert.deepEqual(await records.activity(), activity);

      const created = await records.createProject({ name: 'New' });
      assert.ok(ids(records.projects().value).includes(created.id));
    } finally {
      await test.dispose();
    }
  });
});
