// The records mirror, `runtime.records/v1` (docs/designs/bundle-isolation.md
// section 4; T3.1, T3.2, T3.4, T3.5, T3.6 and T3.7), against a fake
// `runtime/v1`, a fake `runtime.threads/v1` and a fake connection.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ContractError } from 'bundle/contracts';

import type {
  Page,
  Project,
  ProjectActivity,
  RecordsRead,
  Thread,
} from '../../src/contracts/index.js';
import {
  archiveBatch,
  countNotices,
  createHost,
  deferred,
  end,
  flush,
  mirrorOf,
  openOf,
  project,
  thread,
  uuid,
} from './support/hosts.js';

const projectId = uuid(1);
const otherProjectId = uuid(2);
const rootId = uuid(11);
const childId = uuid(12);
const grandchildId = uuid(13);
const siblingId = uuid(14);

const seed = () => ({
  projects: [project(projectId), project(otherProjectId)],
  threads: [
    thread(rootId, projectId),
    thread(childId, projectId, rootId),
    thread(grandchildId, projectId, childId),
    thread(siblingId, projectId),
  ],
});

const ids = (values: readonly { readonly id: string }[] | undefined) =>
  (values ?? []).map(({ id }) => id);

/** A rejection of the mirror: the adapter's `ClientError`, read by its fields. */
const rejectsWithCode = (
  promise: Promise<unknown>,
  code: string,
  message?: string,
) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'ClientError');
    assert.equal((error as { code?: unknown }).code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });

/** A read that answers `loading` and holds no value yet. */
const assertLoadingWithoutValue = (read: RecordsRead<unknown>) => {
  assert.equal(read.status, 'loading');
  assert.equal(read.value, undefined);
};

/** The mirror with the Project list and `projectId`'s Threads described. */
const described = async (t: Parameters<typeof mirrorOf>[0]) => {
  const host = createHost(seed());
  const records = mirrorOf(t, host);
  records.projects();
  records.threads(projectId);
  await flush();
  assert.equal(records.projects().status, 'ready');
  assert.equal(records.threads(projectId).status, 'ready');
  host.calls.length = 0;
  return { host, records };
};

describe('reads (T3.1)', () => {
  test('the first projects() answers loading, then ready with the host list, and loads once', async (t) => {
    const host = createHost(seed());
    const records = mirrorOf(t, host);

    assertLoadingWithoutValue(records.projects());
    await flush();

    assert.deepEqual(records.projects(), {
      status: 'ready',
      value: [project(projectId), project(otherProjectId)],
    });
    assert.deepEqual(records.project(projectId), project(projectId));
    assert.deepEqual(
      host.calls.filter((call) => call === 'projects'),
      ['projects'],
    );
  });

  test('the first threads(projectId) answers loading, then ready with that Project\u2019s Threads', async (t) => {
    const host = createHost(seed());
    const records = mirrorOf(t, host);

    assertLoadingWithoutValue(records.threads(projectId));
    await flush();

    const read = records.threads(projectId);
    assert.equal(read.status, 'ready');
    assert.deepEqual(ids(read.value), [
      rootId,
      childId,
      grandchildId,
      siblingId,
    ]);
    assert.deepEqual(
      records.thread(childId),
      thread(childId, projectId, rootId),
    );
    assert.deepEqual(host.calls, ['threads']);
  });

  test('subscribers are called when a read settles', async (t) => {
    const host = createHost(seed());
    const records = mirrorOf(t, host);
    const notices = countNotices(t, records);

    records.projects();
    await flush();

    assert.ok(notices.count() > 0);
  });

  test('a described Project that is not followed keeps its list when the host\u2019s copy changes', async (t) => {
    const { host, records } = await described(t);

    host.state.threads.push(thread(uuid(20), projectId));
    host.state.threads = host.state.threads.filter(
      ({ id }) => id !== siblingId,
    );
    records.threads(projectId);
    records.projects();
    await flush();

    assert.deepEqual(ids(records.threads(projectId).value), [
      rootId,
      childId,
      grandchildId,
      siblingId,
    ]);
    assert.deepEqual(host.calls, []);
  });

  test('follow replaces the list with each snapshot and applies each update, a new Thread landing last', async (t) => {
    const { host, records } = await described(t);
    const notices = countNotices(t, records);

    records.follow({ projectId });
    assert.equal(host.watches.length, 1);
    const [watch] = host.watches;
    assert.ok(watch !== undefined);
    assert.deepEqual(watch.input, { projectId });

    const renamedProject = { ...project(projectId), name: 'Renamed' };
    watch.observer.next({
      kind: 'snapshot',
      projectId,
      project: renamedProject,
      threads: [thread(siblingId, projectId), thread(rootId, projectId)],
      terminals: [],
    });
    assert.deepEqual(records.threads(projectId), {
      status: 'ready',
      value: [thread(siblingId, projectId), thread(rootId, projectId)],
    });
    assert.equal(records.thread(childId), undefined);
    assert.deepEqual(records.project(projectId), renamedProject);

    const added = thread(uuid(21), projectId);
    watch.observer.next({ kind: 'thread-updated', thread: added });
    assert.deepEqual(ids(records.threads(projectId).value), [
      siblingId,
      rootId,
      added.id,
    ]);

    const renamedRoot = { ...thread(rootId, projectId), name: 'Root' };
    watch.observer.next({ kind: 'thread-updated', thread: renamedRoot });
    assert.deepEqual(ids(records.threads(projectId).value), [
      siblingId,
      rootId,
      added.id,
    ]);
    assert.deepEqual(records.thread(rootId), renamedRoot);

    watch.observer.next({
      kind: 'thread-deleted',
      projectId,
      threadId: siblingId,
    });
    assert.deepEqual(ids(records.threads(projectId).value), [rootId, added.id]);

    const recolored = { ...renamedProject, color: 'blue' as const };
    watch.observer.next({ kind: 'project-updated', project: recolored });
    assert.deepEqual(records.project(projectId), recolored);

    assert.ok(notices.count() > 0);
    assert.deepEqual(
      host.calls.filter((call) => call !== 'watchProject'),
      [],
    );
  });

  test('a snapshot describes a Project that was not described', async (t) => {
    const host = createHost(seed());
    const records = mirrorOf(t, host);

    records.follow({ projectId: otherProjectId });
    const [watch] = host.watches;
    assert.ok(watch !== undefined);
    watch.observer.next({
      kind: 'snapshot',
      projectId: otherProjectId,
      project: project(otherProjectId),
      threads: [thread(uuid(30), otherProjectId)],
      terminals: [],
    });

    assert.deepEqual(
      records.thread(uuid(30)),
      thread(uuid(30), otherProjectId),
    );
    assert.deepEqual(records.threads(otherProjectId), {
      status: 'ready',
      value: [thread(uuid(30), otherProjectId)],
    });
    assert.deepEqual(
      host.calls.filter((call) => call === 'threads'),
      [],
    );
  });

  test('two follows of one Project open one stream, and disposing the last ends it', async (t) => {
    const { host, records } = await described(t);

    const first = records.follow({ projectId });
    const second = records.follow({ projectId });
    assert.equal(host.watches.length, 1);
    assert.equal(openOf(host.watches).length, 1);

    first.dispose();
    assert.equal(openOf(host.watches).length, 1);

    second.dispose();
    assert.equal(openOf(host.watches).length, 0);
    assert.equal(host.watches.length, 1);
  });

  test('a Project that is no longer followed keeps its last list', async (t) => {
    const { host, records } = await described(t);
    const follow = records.follow({ projectId });
    const [watch] = host.watches;
    assert.ok(watch !== undefined);
    watch.observer.next({
      kind: 'snapshot',
      projectId,
      project: project(projectId),
      threads: [thread(rootId, projectId)],
      terminals: [],
    });

    follow.dispose();
    host.state.threads.push(thread(uuid(22), projectId));
    await flush();

    assert.deepEqual(records.threads(projectId), {
      status: 'ready',
      value: [thread(rootId, projectId)],
    });
  });

  test('reload loads again and answers loading with its last value until it settles', async (t) => {
    const { host, records } = await described(t);
    const added = project(uuid(3));
    host.state.projects.push(added);

    records.reload({ target: 'projects' });
    assert.deepEqual(records.projects(), {
      status: 'loading',
      value: [project(projectId), project(otherProjectId)],
    });
    await flush();

    assert.deepEqual(records.projects(), {
      status: 'ready',
      value: [project(projectId), project(otherProjectId), added],
    });
    assert.deepEqual(host.calls, ['projects']);
  });

  test('reload of a Project\u2019s Threads loads them again', async (t) => {
    const { host, records } = await described(t);
    host.state.threads = host.state.threads.filter(({ id }) => id === rootId);

    records.reload({ target: 'threads', projectId });
    assert.equal(records.threads(projectId).status, 'loading');
    assert.deepEqual(ids(records.threads(projectId).value), [
      rootId,
      childId,
      grandchildId,
      siblingId,
    ]);
    await flush();

    assert.deepEqual(records.threads(projectId), {
      status: 'ready',
      value: [thread(rootId, projectId)],
    });
    assert.deepEqual(host.calls, ['threads']);
  });

  test('reload starts a load even for a read never asked for (R4)', async (t) => {
    const host = createHost(seed());
    const records = mirrorOf(t, host);

    records.reload({ target: 'threads', projectId: otherProjectId });
    assert.deepEqual(host.calls, ['threads']);
    assertLoadingWithoutValue(records.threads(otherProjectId));
    await flush();

    assert.deepEqual(records.threads(otherProjectId), {
      status: 'ready',
      value: [],
    });
    assert.deepEqual(host.calls, ['threads']);
  });
});

describe('writes (T3.2)', () => {
  test('createProject resolves with the host\u2019s Project, described with no Threads (R3)', async (t) => {
    const { host, records } = await described(t);
    const notices = countNotices(t, records);

    const created = await records.createProject({ name: 'New' });

    assert.equal(created.name, 'New');
    assert.deepEqual(host.state.projects.at(-1), created);
    assert.deepEqual(records.project(created.id), created);
    assert.ok(ids(records.projects().value).includes(created.id));
    assert.deepEqual(records.threads(created.id), {
      status: 'ready',
      value: [],
    });
    assert.deepEqual(host.calls, ['createProject']);
    assert.ok(notices.count() > 0);
  });

  test('renameProject, setProjectColor and terminateProject resolve with the host\u2019s record, which the mirror holds', async (t) => {
    const { records } = await described(t);

    const renamed = await records.renameProject({ projectId, name: 'Renamed' });
    assert.equal(renamed.name, 'Renamed');
    assert.deepEqual(records.project(projectId), renamed);

    const colored = await records.setProjectColor({ projectId, color: 'pink' });
    assert.equal(colored.color, 'pink');
    assert.deepEqual(records.project(projectId), colored);

    const cleared = await records.setProjectColor({ projectId });
    assert.equal(cleared.color, undefined);
    assert.deepEqual(records.project(projectId), cleared);

    const terminated = await records.terminateProject({ projectId });
    assert.equal(terminated.state, 'cancelled');
    assert.deepEqual(records.project(projectId), terminated);
    assert.deepEqual(
      ids(records.projects().value),
      [projectId, otherProjectId],
      'a written Project keeps its place',
    );
  });

  test('deleteProject takes the Project and its Threads out of every read', async (t) => {
    const { records } = await described(t);
    const notices = countNotices(t, records);

    assert.equal(await records.deleteProject({ projectId }), undefined);

    assert.equal(records.project(projectId), undefined);
    assert.deepEqual(ids(records.projects().value), [otherProjectId]);
    assert.equal(records.thread(rootId), undefined);
    assert.equal(records.thread(siblingId), undefined);
    assert.ok(notices.count() > 0);
  });

  test('createThread, renameThread and terminateThread resolve with the host\u2019s Thread, which the mirror holds', async (t) => {
    const { records } = await described(t);

    const created = await records.createThread({
      projectId,
      name: 'Child',
      parentThreadId: rootId,
    });
    assert.equal(created.parentThreadId, rootId);
    assert.deepEqual(records.thread(created.id), created);
    assert.ok(ids(records.threads(projectId).value).includes(created.id));

    const renamed = await records.renameThread({
      threadId: rootId,
      name: 'Root',
    });
    assert.equal(renamed.name, 'Root');
    assert.deepEqual(records.thread(rootId), renamed);

    const terminated = await records.terminateThread({ threadId: siblingId });
    assert.equal(terminated.state, 'cancelled');
    assert.deepEqual(records.thread(siblingId), terminated);
  });

  test('deleteThread takes the Thread and its subtree with it', async (t) => {
    const { records } = await described(t);

    assert.equal(await records.deleteThread({ threadId: childId }), undefined);

    assert.equal(records.thread(childId), undefined);
    assert.equal(records.thread(grandchildId), undefined);
    assert.deepEqual(ids(records.threads(projectId).value), [
      rootId,
      siblingId,
    ]);
  });

  test('archive marks the Threads it answers, restore clears them and pin sets the field', async (t) => {
    const { records } = await described(t);
    const notices = countNotices(t, records);

    const archived = await records.archiveThread({ threadId: childId });
    assert.equal(archived.batch, archiveBatch);
    assert.deepEqual(ids(archived.threads), [childId, grandchildId]);
    for (const value of archived.threads) {
      assert.deepEqual(records.thread(value.id), value);
      assert.notEqual(records.thread(value.id)?.archivedAt, undefined);
    }
    assert.equal(records.thread(rootId)?.archivedAt, undefined);
    assert.ok(
      ids(records.threads(projectId).value).includes(childId),
      'an archived Thread stays in its read',
    );

    const restored = await records.restoreThread({
      threadId: childId,
      batch: archived.batch,
    });
    assert.deepEqual(ids(restored), [childId, grandchildId]);
    assert.equal(records.thread(childId)?.archivedAt, undefined);
    assert.equal(records.thread(grandchildId)?.archivedAt, undefined);

    const pinned = await records.setThreadPinned({
      threadId: siblingId,
      pinned: true,
    });
    assert.equal(pinned.pinned, true);
    assert.deepEqual(records.thread(siblingId), pinned);
    assert.ok(notices.count() > 0);
  });

  for (const status of ['busy', 'already_archived'] as const) {
    test(`an archive the host answers ${status} rejects with conflict and changes no record`, async (t) => {
      const { host, records } = await described(t);
      host.threads.archiveThread = async () => ({ status });
      const before = records.threads(projectId);

      await rejectsWithCode(
        records.archiveThread({ threadId: rootId }),
        'conflict',
      );

      assert.deepEqual(records.threads(projectId), before);
    });
  }

  test('a restore the host answers not_archived rejects with conflict and changes no record', async (t) => {
    const { host, records } = await described(t);
    host.threads.restoreThread = async () => ({ status: 'not_archived' });
    const before = records.threads(projectId);

    await rejectsWithCode(
      records.restoreThread({ threadId: rootId }),
      'conflict',
      'The thread is not archived.',
    );

    assert.deepEqual(records.threads(projectId), before);
  });

  test('a host error rejects with a ClientError of the host\u2019s code, the adapter\u2019s message and the host error as cause', async (t) => {
    const { host, records } = await described(t);
    const failure = new ContractError('unavailable', 'The bridge is down.');
    host.runtime.renameProject = async () => {
      throw failure;
    };

    await assert.rejects(
      records.renameProject({ projectId, name: 'Renamed' }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'ClientError');
        assert.equal((error as { code?: unknown }).code, 'unavailable');
        assert.equal(error.message, 'Doric backend is unavailable.');
        assert.equal(error.cause, failure);
        return true;
      },
    );
    assert.deepEqual(records.project(projectId), project(projectId));
  });

  test('an internal host error rejects with internal and no cause', async (t) => {
    const { host, records } = await described(t);
    host.threads.renameThread = async () => {
      throw new ContractError('internal', 'private detail');
    };

    await assert.rejects(
      records.renameThread({ threadId: rootId, name: 'Root' }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { code?: unknown }).code, 'internal');
        assert.equal(error.message, 'The request could not be completed.');
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  });

  test('a name the guard refuses rejects with invalid_input and calls no host method', async (t) => {
    const { host, records } = await described(t);

    await rejectsWithCode(
      records.createProject({ name: '   ' }),
      'invalid_input',
      'Enter a name between 1 and 80 characters.',
    );
    await rejectsWithCode(
      records.renameThread({ threadId: rootId, name: 'bad\0name' }),
      'invalid_input',
      'Enter a valid name before continuing.',
    );

    assert.deepEqual(host.calls, []);
  });

  test('a delete the host answers missing rejects with not_found', async (t) => {
    const { host, records } = await described(t);
    host.runtime.deleteProject = async () => 'missing';
    host.threads.deleteThread = async () => 'missing';

    await rejectsWithCode(
      records.deleteProject({ projectId }),
      'not_found',
      'The project was not found.',
    );
    await rejectsWithCode(
      records.deleteThread({ threadId: rootId }),
      'not_found',
      'The thread was not found.',
    );
  });

  test('a delete the host answers forbidden rejects with conflict and keeps the Thread', async (t) => {
    const { host, records } = await described(t);
    host.threads.deleteThread = async () => 'forbidden';

    await rejectsWithCode(
      records.deleteThread({ threadId: rootId }),
      'conflict',
    );

    assert.deepEqual(records.thread(rootId), thread(rootId, projectId));
  });

  test('a delete the host answers active is tried again until it is deleted', async (t) => {
    const { host, records } = await described(t);
    const answers = ['active', 'active', 'deleted'] as const;
    let attempt = 0;
    host.threads.deleteThread = async () => answers[attempt++] ?? 'deleted';

    await records.deleteThread({ threadId: siblingId });

    assert.equal(attempt, 3);
    assert.equal(records.thread(siblingId), undefined);
  });

  test('a write during a threads load drops that load, and the read is ready with the written list (R2)', async (t) => {
    const { host, records } = await described(t);
    const load = deferred<Page<Thread> | undefined>();
    host.threads.threads = () => load.promise;

    records.reload({ target: 'threads', projectId });
    assert.equal(records.threads(projectId).status, 'loading');

    const renamed = await records.renameThread({
      threadId: rootId,
      name: 'Root',
    });
    const written = [
      renamed,
      ...[childId, grandchildId, siblingId].map((id) =>
        host.state.threads.find((value) => value.id === id),
      ),
    ];
    assert.deepEqual(records.threads(projectId), {
      status: 'ready',
      value: written,
    });

    load.resolve({ items: [thread(rootId, projectId)] });
    await flush();

    assert.deepEqual(records.threads(projectId), {
      status: 'ready',
      value: written,
    });
  });
});

describe('connection (T3.4)', () => {
  test('a dropped connection answers disconnected and keeps every value', async (t) => {
    const { host, records } = await described(t);
    const notices = countNotices(t, records);
    const projects = records.projects();
    const threads = records.threads(projectId);
    assert.equal(records.connection(), 'connected');

    host.connection.report('disconnected');

    assert.equal(records.connection(), 'disconnected');
    assert.deepEqual(records.projects(), projects);
    assert.deepEqual(records.threads(projectId), threads);
    assert.ok(notices.count() > 0, 'subscribers are called');

    host.connection.report('connected');
    assert.equal(records.connection(), 'connected');
  });

  for (const code of [
    'disconnected',
    'unavailable',
    'generation_lost',
  ] as const) {
    test(`a watch that ends ${code} subscribes again on reconnect, without a report`, async (t) => {
      const { host, records } = await described(t);
      records.follow({ projectId });
      const [first] = host.watches;
      assert.ok(first !== undefined);
      first.observer.next({
        kind: 'snapshot',
        projectId,
        project: project(projectId),
        threads: [thread(rootId, projectId)],
        terminals: [],
      });

      host.connection.current = 'disconnected';
      end(first, new ContractError(code, 'gone for now'));
      host.connection.report('disconnected');
      assert.equal(openOf(host.watches).length, 0);
      const kept = records.threads(projectId);
      assert.equal(kept.status, 'ready');

      host.connection.report('connected');
      assert.equal(openOf(host.watches).length, 1);
      assert.deepEqual(host.watches.at(-1)?.input, { projectId });
      assert.deepEqual(records.threads(projectId), kept);
    });
  }
});

describe('failed reads (T3.5)', () => {
  test('a failed first load answers failed with the code and no value', async (t) => {
    const host = createHost(seed());
    host.runtime.projects = async () => {
      throw new ContractError('unavailable', 'The bridge is down.');
    };
    const records = mirrorOf(t, host);

    records.projects();
    await flush();

    const read = records.projects();
    assert.equal(read.status, 'failed');
    assert.equal(read.value, undefined);
    assert.equal(
      read.status === 'failed' ? read.error.code : '',
      'unavailable',
    );
  });

  test('a failed refresh answers failed with its last value, and error is the ClientError itself (R1)', async (t) => {
    const { host, records } = await described(t);
    const failure = new ContractError('unavailable', 'The bridge is down.');
    host.threads.threads = async () => {
      throw failure;
    };

    records.reload({ target: 'threads', projectId });
    await flush();

    const read = records.threads(projectId);
    assert.equal(read.status, 'failed');
    assert.deepEqual(ids(read.value), [
      rootId,
      childId,
      grandchildId,
      siblingId,
    ]);
    assert.ok(read.status === 'failed');
    const error: unknown = read.error;
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'ClientError');
    assert.equal(read.error.code, 'unavailable');
    assert.equal(read.error.message, 'Doric backend is unavailable.');
    assert.equal(error.cause, failure);
  });

  test('reload after a failure loads again: loading with the last value, then ready', async (t) => {
    const { host, records } = await described(t);
    const answer = host.runtime.projects;
    host.runtime.projects = async () => {
      throw new ContractError('unavailable', 'The bridge is down.');
    };
    records.reload({ target: 'projects' });
    await flush();
    assert.equal(records.projects().status, 'failed');

    host.runtime.projects = answer;
    records.reload({ target: 'projects' });
    assert.deepEqual(records.projects(), {
      status: 'loading',
      value: [project(projectId), project(otherProjectId)],
    });
    await flush();

    assert.deepEqual(records.projects(), {
      status: 'ready',
      value: [project(projectId), project(otherProjectId)],
    });
  });

  test('the Threads of a Project the host no longer has answer failed with not_found', async (t) => {
    const host = createHost(seed());
    const records = mirrorOf(t, host);

    records.threads(uuid(99));
    await flush();

    const read = records.threads(uuid(99));
    assert.equal(read.status, 'failed');
    assert.equal(read.status === 'failed' ? read.error.code : '', 'not_found');
  });
});

describe('an unreachable host (T3.6)', () => {
  test('creating the mirror calls no host method; the first projects() answers loading, then failed', async (t) => {
    const host = createHost(seed());
    host.connection.current = 'disconnected';
    const unreachable = async (): Promise<never> => {
      host.calls.push('unreachable');
      throw new ContractError('unavailable', 'The host cannot be reached.');
    };
    host.runtime.projects = unreachable;
    host.threads.threads = unreachable;
    const records = mirrorOf(t, host);

    assert.deepEqual(host.calls, []);
    assert.equal(records.connection(), 'disconnected');

    assertLoadingWithoutValue(records.projects());
    await flush();

    const read: RecordsRead<readonly Project[]> = records.projects();
    assert.equal(read.status, 'failed');
    assert.equal(
      read.status === 'failed' ? read.error.code : '',
      'unavailable',
    );
    assert.equal(read.value, undefined);
  });
});

describe('one-off reads and the watch failure (T3.7)', () => {
  test('findThread asks the host once, answers the Thread, and changes no read', async (t) => {
    const host = createHost(seed());
    const records = mirrorOf(t, host);
    const notices = countNotices(t, records);

    assert.deepEqual(
      await records.findThread({ threadId: childId }),
      thread(childId, projectId, rootId),
    );

    assert.deepEqual(host.calls, ['thread']);
    assert.equal(records.thread(childId), undefined);
    assert.equal(notices.count(), 0);
  });

  test('findThread answers undefined for a Thread the host does not have', async (t) => {
    const host = createHost(seed());
    const records = mirrorOf(t, host);

    assert.equal(await records.findThread({ threadId: uuid(98) }), undefined);
    assert.deepEqual(host.calls, ['thread']);
  });

  test('activity answers the host\u2019s list and changes no read', async (t) => {
    const activity: ProjectActivity[] = [
      {
        project: project(projectId),
        activityAt: '2026-11-18T12:00:00.000Z',
        latestActiveThreadId: rootId,
      },
    ];
    const host = createHost({ ...seed(), activity });
    const records = mirrorOf(t, host);
    const notices = countNotices(t, records);

    assert.deepEqual(await records.activity(), activity);
    assert.deepEqual(host.calls, ['projectActivity']);
    assert.equal(notices.count(), 0);
  });

  test('thread(id) of a Project that is not described answers undefined and starts no load', async (t) => {
    const host = createHost(seed());
    const records = mirrorOf(t, host);

    assert.equal(records.thread(rootId), undefined);
    assert.equal(records.project(projectId), undefined);
    await flush();

    assert.deepEqual(host.calls, []);
  });

  test('a watch that ends with a failure makes threads answer failed with project_stream_failed and its last value', async (t) => {
    const { host, records } = await described(t);
    records.follow({ projectId });
    const [watch] = host.watches;
    assert.ok(watch !== undefined);
    watch.observer.next({
      kind: 'snapshot',
      projectId,
      project: project(projectId),
      threads: [thread(rootId, projectId)],
      terminals: [],
    });

    end(watch, new ContractError('internal', 'The stream broke.'));

    const read = records.threads(projectId);
    assert.equal(read.status, 'failed');
    assert.deepEqual(read.value, [thread(rootId, projectId)]);
    assert.equal(
      read.status === 'failed' ? read.error.code : '',
      'project_stream_failed',
    );
    assert.equal(
      read.status === 'failed' ? read.error.message : '',
      'The Project event stream failed.',
    );
    host.fireTimers();
    assert.equal(openOf(host.watches).length, 0, 'a failed watch stays ended');
  });
});
