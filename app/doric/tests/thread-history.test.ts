import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import type { Thread } from '../src/workspace/api';
import type { ThreadEvent, ThreadUpdate } from '../src/workspace/events';
import {
  createThreadHistoryStore,
  type ThreadHistory,
} from '../src/workspace/thread-history';

const directories: string[] = [];

const directory = (): string => {
  const made = mkdtempSync(join(tmpdir(), 'doric-thread-history-'));
  directories.push(made);
  return made;
};

after(() => {
  for (const made of directories) {
    rmSync(made, { recursive: true, force: true });
  }
});

const thread: Thread = {
  id: 'thread-id',
  name: 'Main',
  projectId: 'project-id',
  state: 'ready',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const event = (sequence: number): ThreadEvent => ({
  projectId: 'project-id',
  threadId: 'thread-id',
  promptId: 'prompt-id',
  sequence,
  type: 'message.delta',
  event: { text: String(sequence) },
  createdAt: '2026-01-01T00:00:00.000Z',
});

const truncation = (sequence: number, afterSequence: number): ThreadEvent => ({
  ...event(sequence),
  type: 'history.truncated',
  event: { type: 'history.truncated', afterSequence },
});

const snapshot = (
  events: readonly ThreadEvent[],
  record: Thread | null = null,
): ThreadUpdate => ({
  kind: 'snapshot',
  snapshot: {
    threadId: 'thread-id',
    projectId: 'project-id',
    project: null,
    thread: record,
    events,
  },
});

const updated = (record: Thread): ThreadUpdate => ({
  kind: 'updated',
  thread: record,
});

const sequences = (history: ThreadHistory | null): readonly number[] =>
  history === null ? [] : history.events.map((item) => item.sequence);

describe('Thread history snapshot', () => {
  test('merges absorbed events into one log deduplicated by sequence', () => {
    const store = createThreadHistoryStore(directory());
    store.absorb(snapshot([event(3), event(1), event(2)]));
    store.absorb(snapshot([event(2), event(4)]));

    const history = store.read('thread-id');
    assert.deepEqual(sequences(history), [1, 2, 3, 4]);
    assert.equal(history?.lastSequence, 4);
  });

  test('keeps the Thread record snapshots and updates carry', () => {
    const store = createThreadHistoryStore(directory());
    store.absorb(snapshot([event(1)], { ...thread, name: 'First' }));
    store.absorb(updated({ ...thread, name: 'Second' }));

    assert.equal(store.read('thread-id')?.thread?.name, 'Second');
  });

  test('drops events a rewind marker discards when the marker arrives alone after a restart', () => {
    const dir = directory();
    const closed = createThreadHistoryStore(dir);
    closed.absorb(
      snapshot(Array.from({ length: 10 }, (_value, index) => event(index + 1))),
    );
    closed.flush();

    const reopened = createThreadHistoryStore(dir);
    reopened.absorb({ kind: 'event', event: truncation(11, 5) });

    const history = reopened.read('thread-id');
    assert.deepEqual(sequences(history), [1, 2, 3, 4, 5, 11]);
    assert.equal(history?.lastSequence, 11);
  });

  test('absorbs new events onto the log a previous run cached', () => {
    const dir = directory();
    const closed = createThreadHistoryStore(dir);
    closed.absorb(snapshot([event(1), event(2)]));
    closed.flush();

    const reopened = createThreadHistoryStore(dir);
    reopened.absorb({ kind: 'event', event: event(3) });

    assert.deepEqual(sequences(reopened.read('thread-id')), [1, 2, 3]);
  });

  test('answers null when the app holds no snapshot', () => {
    const store = createThreadHistoryStore(directory());
    assert.equal(store.read('thread-id'), null);
  });

  test('answers null when the cached file is corrupt', () => {
    const dir = directory();
    writeFileSync(join(dir, 'thread-id.json'), '{ not json');

    const store = createThreadHistoryStore(dir);
    assert.equal(store.read('thread-id'), null);
  });

  test('keeps every snapshot while twenty or fewer Threads are held', () => {
    const store = createThreadHistoryStore(directory());
    for (let index = 1; index <= 20; index += 1) {
      store.absorb(updated({ ...thread, id: `thread-${index}` }));
    }

    for (let index = 1; index <= 20; index += 1) {
      assert.notEqual(store.read(`thread-${index}`), null);
    }
  });

  test('evicts the least recently updated snapshot when a twenty-first Thread is updated', () => {
    const store = createThreadHistoryStore(directory());
    for (let index = 1; index <= 20; index += 1) {
      store.absorb(updated({ ...thread, id: `thread-${index}` }));
    }
    store.flush();
    store.absorb(updated({ ...thread, id: 'thread-1' }));
    store.absorb(updated({ ...thread, id: 'thread-21' }));

    assert.equal(store.read('thread-2'), null);
    assert.notEqual(store.read('thread-1'), null);
    assert.notEqual(store.read('thread-21'), null);
  });

  test('removes the cached snapshot when the Thread is deleted', () => {
    const dir = directory();
    const store = createThreadHistoryStore(dir);
    store.absorb(snapshot([event(1)]));
    store.flush();
    store.absorb({
      kind: 'deleted',
      projectId: 'project-id',
      threadId: 'thread-id',
    });

    assert.equal(store.read('thread-id'), null);
    assert.equal(createThreadHistoryStore(dir).read('thread-id'), null);
  });
});
