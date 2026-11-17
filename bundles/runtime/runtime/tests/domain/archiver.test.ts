import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { ContractError, type Log } from 'bundle/contracts';

import type { Thread } from '../../src/contracts/model.js';
import { dayMs } from '../../src/host/domain/archive.js';
import {
  type ArchiverContext,
  createArchiver,
  projectGraceMs,
} from '../../src/host/domain/archiver.js';
import type { ProjectRuntime } from '../../src/host/domain/runtime.js';
import type { ArchiveState, ThreadStore } from '../../src/host/store/types.js';
import { deferred } from './support/harness.js';

/*
 * The archiver's sweep and views over a fake context (docs/designs/
 * thread-archive.md §5, T-34, T-35): the store, the Project lock, the
 * settings, the schedule and the log are the boundaries it is given. `Date`
 * is mocked (D28); each sweep is called by hand.
 */

const base = Date.parse('2026-11-17T12:00:00.000Z');
const iso = (ms: number) => new Date(base + ms).toISOString();

interface LogLine {
  readonly level: string;
  readonly message: string;
  readonly fields?: unknown;
}

/** One Project: a main thread and an agent child whose turn ended a minute ago. */
const projectStates = (projectId: string) => {
  const main: Thread = {
    id: randomUUID(),
    projectId,
    origin: 'user',
    name: 'Main',
    state: 'ready',
    lastSequence: 2,
    cwd: '/workspace',
    createdAt: iso(-120_000),
    updatedAt: iso(-120_000),
    result: {
      status: 'completed',
      text: 'done',
      promptId: randomUUID(),
      at: iso(-60_000),
    },
  };
  const child: Thread = {
    ...main,
    id: randomUUID(),
    parentThreadId: main.id,
    origin: 'agent',
    name: 'Child',
    result: main.result && { ...main.result, promptId: randomUUID() },
  };
  return { main, child };
};

const runtimeOf = (projectId: string): ProjectRuntime =>
  ({
    project: { id: projectId },
    controller: new AbortController(),
    threads: new Map(),
    closing: false,
  }) as unknown as ProjectRuntime;

/** Settles every pending callback a few times over, then checks `done`. */
const until = async (done: () => boolean, what: string) => {
  const deadline = performance.now() + 5000;
  while (!done()) {
    if (performance.now() > deadline)
      throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

const settle = async () => {
  for (let round = 0; round < 5; round += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

const fakeContext = (projectIds: readonly string[]) => {
  const states = new Map<string, ArchiveState[]>();
  const children = new Map<string, Thread>();
  /** The agent child thread id of `projectId`. */
  const childId = (projectId: string) => children.get(projectId)?.id ?? '';
  for (const projectId of projectIds) {
    const { main, child } = projectStates(projectId);
    children.set(projectId, child);
    states.set(projectId, [
      { thread: main, interrupted: false },
      { thread: child, interrupted: false },
    ]);
  }
  const archived: string[][] = [];
  const logs: LogLine[] = [];
  const locks: string[] = [];
  const armed: (() => void)[] = [];
  const options = {
    /** Answers each store archive; the default writes it. */
    archive: (_ids: readonly string[]): Promise<void> => Promise.resolve(),
    archiveStates: (_projectId: string): Promise<void> => Promise.resolve(),
    exclusive: (_projectId: string): Promise<never> | undefined => undefined,
    settings: () =>
      Promise.resolve({ agentThreads: true, mainThreadsAfterMs: 7 * dayMs }),
    /** Answers each markViewed; its write lands once it resolves. */
    markViewed: (): Promise<void> => Promise.resolve(),
  };
  const stateOf = (id: string) =>
    [...states.values()].flat().find((state) => state.thread.id === id);
  const replace = (id: string, next: (state: ArchiveState) => ArchiveState) => {
    for (const [projectId, list] of states)
      states.set(
        projectId,
        list.map((state) => (state.thread.id === id ? next(state) : state)),
      );
  };
  const threads = {
    archiveStates: async (projectId: string) => {
      await options.archiveStates(projectId);
      return states.get(projectId) ?? [];
    },
    archive: async (
      ids: readonly string[],
      archive: { readonly at: string; readonly batch: string },
    ) => {
      await options.archive(ids);
      archived.push([...ids]);
      for (const id of ids)
        replace(id, (state) => ({
          ...state,
          batch: archive.batch,
          thread: { ...state.thread, archivedAt: archive.at },
        }));
      return ids.map((id) => stateOf(id)?.thread);
    },
    markViewed: async (id: string, at: string) => {
      await options.markViewed();
      replace(id, (state) => ({ ...state, viewedAt: at }));
    },
  } as unknown as ThreadStore;
  const line =
    (level: string) =>
    (message: string, fields?: unknown): void => {
      logs.push({
        level,
        message,
        ...(fields === undefined ? {} : { fields }),
      });
    };
  const log = {
    debug: line('debug'),
    info: line('info'),
    warn: line('warn'),
    error: line('error'),
  } as unknown as Log;
  const context: ArchiverContext = {
    threads,
    publisher: {
      event: () => undefined,
      threadUpdated: () => undefined,
      threadDeleted: () => undefined,
      projectUpdated: () => undefined,
      projectDeleted: () => undefined,
    },
    exclusive: (projectId, operation) => {
      locks.push(projectId);
      return options.exclusive(projectId) ?? operation();
    },
    runtimes: new Map(projectIds.map((id) => [id, runtimeOf(id)])),
    settings: () => options.settings(),
    // As the service's helper with the sweep's operation name (D27).
    oversized: (fields) => (error) => {
      if ((error as { code?: unknown } | null)?.code === 'limit_exceeded')
        log.error('Auto-archive exceeds the storage batch limit', fields);
      throw error;
    },
    schedule: (run) => {
      armed.push(run);
      return () => {
        const index = armed.indexOf(run);
        if (index >= 0) armed.splice(index, 1);
      };
    },
    log,
  };
  /** Whether a store archive wrote the agent child of `projectId`. */
  const childArchived = (projectId: string) =>
    archived.some((ids) => ids.includes(childId(projectId)));
  return {
    context,
    options,
    archived,
    logs,
    locks,
    armed,
    childId,
    childArchived,
  };
};

void test('a Project whose lock is held does not delay another Project and gets no second write while it waits', {
  timeout: 10_000,
}, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: base });
  const [held, free] = [randomUUID(), randomUUID()];
  const fake = fakeContext([held, free]);
  fake.options.exclusive = (projectId) =>
    projectId === held ? new Promise<never>(() => undefined) : undefined;
  const archiver = createArchiver(fake.context);
  try {
    await archiver.sweep();
    t.mock.timers.tick(projectGraceMs);
    await archiver.sweep();
    await until(() => fake.childArchived(free), 'the free Project archive');
    assert.equal(fake.childArchived(held), false);
    await archiver.sweep();
    await settle();
    assert.equal(fake.locks.filter((id) => id === held).length, 1);
    assert.equal(fake.childArchived(held), false);
  } finally {
    archiver.dispose();
  }
});

void test('a Project first seen at S is not swept before S + 30 s and is swept after', {
  timeout: 10_000,
}, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: base });
  const projectId = randomUUID();
  const fake = fakeContext([projectId]);
  const archiver = createArchiver(fake.context);
  try {
    await archiver.sweep();
    await settle();
    t.mock.timers.tick(projectGraceMs - 1);
    await archiver.sweep();
    await settle();
    assert.equal(fake.childArchived(projectId), false);
    t.mock.timers.tick(1);
    await archiver.sweep();
    await until(() => fake.childArchived(projectId), 'the archive');
    // The agent child alone: its main thread is not due.
    assert.deepEqual(fake.archived, [[fake.childId(projectId)]]);
  } finally {
    archiver.dispose();
  }
});

void test('a view whose end write has not settled still counts as viewed', {
  timeout: 10_000,
}, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: base });
  const projectId = randomUUID();
  const fake = fakeContext([projectId]);
  const childId = fake.childId(projectId);
  const archiver = createArchiver(fake.context);
  try {
    await archiver.sweep();
    t.mock.timers.tick(projectGraceMs);
    const view = archiver.view(childId, () => undefined);
    assert.equal(archiver.viewing(childId), true);
    await settle();
    // The end write stays in flight; the stored view time is the start's.
    const endWrite = deferred();
    fake.options.markViewed = () => endWrite.promise;
    t.mock.timers.tick(60_000);
    view.dispose();
    assert.equal(archiver.viewing(childId), true);
    await archiver.sweep();
    await settle();
    assert.equal(fake.childArchived(projectId), false);

    endWrite.resolve();
    await until(() => !archiver.viewing(childId), 'the view end to settle');
    t.mock.timers.tick(30_000);
    await archiver.sweep();
    await until(() => fake.childArchived(projectId), 'the archive');
  } finally {
    archiver.dispose();
  }
});

void test('a draining archiver ends every view with unavailable and sweeps no more', {
  timeout: 10_000,
}, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: base });
  const projectId = randomUUID();
  const fake = fakeContext([projectId]);
  const childId = fake.childId(projectId);
  const archiver = createArchiver(fake.context);
  try {
    const ended: unknown[] = [];
    archiver.view(childId, (error) => ended.push(error));
    await archiver.sweep();
    t.mock.timers.tick(projectGraceMs);
    archiver.drain();
    assert.equal(ended.length, 1);
    assert.ok(ended[0] instanceof ContractError);
    assert.equal((ended[0] as ContractError).code, 'unavailable');

    const late: unknown[] = [];
    archiver.view(childId, (error) => late.push(error));
    assert.equal((late[0] as ContractError | undefined)?.code, 'unavailable');
    await settle();
    assert.equal(archiver.viewing(childId), false);

    // Long past every due time: a sweep that still ran would archive.
    t.mock.timers.tick(10 * 60_000);
    for (const run of [...fake.armed]) run();
    await archiver.sweep();
    await settle();
    assert.deepEqual(fake.archived, []);
  } finally {
    archiver.dispose();
  }
});

void test('a store archive over the batch limit logs it and the next sweep tries again', {
  timeout: 10_000,
}, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: base });
  const projectId = randomUUID();
  const fake = fakeContext([projectId]);
  let refusals = 0;
  fake.options.archive = async () => {
    if (refusals > 0) return;
    refusals += 1;
    throw new ContractError('limit_exceeded', 'Too many items.');
  };
  const archiver = createArchiver(fake.context);
  try {
    await archiver.sweep();
    t.mock.timers.tick(projectGraceMs);
    await archiver.sweep();
    await until(
      () =>
        fake.logs.some(
          ({ message }) =>
            message === 'Auto-archive exceeds the storage batch limit',
        ),
      'the limit log',
    );
    assert.equal(fake.childArchived(projectId), false);
    await archiver.sweep();
    await until(() => fake.childArchived(projectId), 'the retried archive');
  } finally {
    archiver.dispose();
  }
});

void test('any other rejected store archive logs an error and the next sweep tries again', {
  timeout: 10_000,
}, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: base });
  const projectId = randomUUID();
  const fake = fakeContext([projectId]);
  let refusals = 0;
  fake.options.archive = async () => {
    if (refusals > 0) return;
    refusals += 1;
    throw new Error('disk on fire');
  };
  const archiver = createArchiver(fake.context);
  try {
    await archiver.sweep();
    t.mock.timers.tick(projectGraceMs);
    await archiver.sweep();
    await until(
      () => fake.logs.some(({ level }) => level === 'error'),
      'the error log',
    );
    assert.equal(fake.childArchived(projectId), false);
    await archiver.sweep();
    await until(() => fake.childArchived(projectId), 'the retried archive');
  } finally {
    archiver.dispose();
  }
});

void test('a rejected settings read logs a warning and the next sweep still runs', {
  timeout: 10_000,
}, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: base });
  const projectId = randomUUID();
  const fake = fakeContext([projectId]);
  const archiver = createArchiver(fake.context);
  try {
    await archiver.sweep();
    t.mock.timers.tick(projectGraceMs);
    fake.options.settings = () => Promise.reject(new Error('no settings'));
    const armedBefore = fake.armed.length;
    await archiver.sweep();
    await settle();
    assert.ok(fake.logs.some(({ level }) => level === 'warn'));
    assert.equal(fake.childArchived(projectId), false);
    assert.ok(fake.armed.length > armedBefore, 'the next sweep is armed');

    fake.options.settings = () =>
      Promise.resolve({ agentThreads: true, mainThreadsAfterMs: 7 * dayMs });
    fake.armed.at(-1)?.();
    await until(() => fake.childArchived(projectId), 'the next sweep archive');
  } finally {
    archiver.dispose();
  }
});

void test('a rejected archiveStates read skips only that Project', {
  timeout: 10_000,
}, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: base });
  const [failing, healthy] = [randomUUID(), randomUUID()];
  const fake = fakeContext([failing, healthy]);
  const archiver = createArchiver(fake.context);
  try {
    await archiver.sweep();
    t.mock.timers.tick(projectGraceMs);
    fake.options.archiveStates = async (projectId) => {
      if (projectId === failing) throw new Error('read failed');
    };
    await archiver.sweep();
    await until(() => fake.childArchived(healthy), 'the healthy archive');
    assert.equal(fake.childArchived(failing), false);
    assert.ok(fake.logs.some(({ level }) => level === 'warn'));
  } finally {
    archiver.dispose();
  }
});
