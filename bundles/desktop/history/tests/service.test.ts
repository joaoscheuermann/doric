import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import {
  HistorySnapshotsV1,
  type HistoryUpdate,
  type ThreadEventRecord,
} from '../src/contracts/index.js';
import { bootDesktop } from './support/desktop.js';

const directories: string[] = [];

const cacheDirectory = (): string => {
  const made = mkdtempSync(join(tmpdir(), 'doric-history-'));
  directories.push(made);
  return made;
};

after(() => {
  for (const made of directories) {
    rmSync(made, { recursive: true, force: true });
  }
});

const storage = {
  hostId: '6f1c2a5e-8f3b-4c1d-9a7e-2b4d6f8a0c1e',
  storageGeneration: 3,
} as const;

const event = (sequence: number): ThreadEventRecord => ({
  projectId: 'project-id',
  threadId: 'thread-id',
  promptId: 'prompt-id',
  sequence,
  type: 'message.delta',
  event: { text: String(sequence) },
  createdAt: '2026-01-01T00:00:00.000Z',
});

const snapshot: HistoryUpdate = {
  kind: 'snapshot',
  thread: { id: 'thread-id', name: 'Main', projectId: 'project-id' },
  events: [event(1), event(2)],
};

const namespace = (root: string): string =>
  join(root, storage.hostId, String(storage.storageGeneration));

describe('history.snapshots/v1', () => {
  test('reads back what was written, before anything reaches disk', async () => {
    const root = cacheDirectory();
    const desktop = await bootDesktop({ cacheDirectory: root, storage });
    const history = desktop.services.use(HistorySnapshotsV1);

    await history.write({ threadId: 'thread-id', updates: [snapshot] });
    await history.write({
      threadId: 'thread-id',
      updates: [{ kind: 'event', event: event(3) }],
    });

    const read = await history.read('thread-id');
    assert.deepEqual(
      read?.events.map((item) => item.sequence),
      [1, 2, 3],
    );
    assert.equal(read?.lastSequence, 3);
    assert.equal(read?.thread?.name, 'Main');
    assert.equal(existsSync(join(namespace(root), 'thread-id.json')), false);
    await desktop.stop();
  });

  test('saves each Thread under <hostId>/<storageGeneration>/<threadId>.json', async () => {
    const root = cacheDirectory();
    const desktop = await bootDesktop({ cacheDirectory: root, storage });

    await desktop.services
      .use(HistorySnapshotsV1)
      .write({ threadId: 'thread/a b', updates: [snapshot] });
    await desktop.stop();

    assert.deepEqual(readdirSync(namespace(root)), [
      `${encodeURIComponent('thread/a b')}.json`,
    ]);
  });

  test('flushes pending writes when the app is about to quit, without vetoing it', async () => {
    const root = cacheDirectory();
    const desktop = await bootDesktop({ cacheDirectory: root, storage });

    await desktop.services
      .use(HistorySnapshotsV1)
      .write({ threadId: 'thread-id', updates: [snapshot] });

    assert.deepEqual(await desktop.beforeQuit(), { allow: true });
    assert.equal(existsSync(join(namespace(root), 'thread-id.json')), true);
    await desktop.stop();
  });

  test('a later run with the same storage identity reads the saved history', async () => {
    const root = cacheDirectory();
    const first = await bootDesktop({ cacheDirectory: root, storage });
    await first.services
      .use(HistorySnapshotsV1)
      .write({ threadId: 'thread-id', updates: [snapshot] });
    await first.stop();

    const second = await bootDesktop({ cacheDirectory: root, storage });
    const read = await second.services
      .use(HistorySnapshotsV1)
      .read('thread-id');
    assert.equal(read?.lastSequence, 2);
    await second.stop();
  });

  test('another storage generation does not see the history of the previous one', async () => {
    const root = cacheDirectory();
    const first = await bootDesktop({ cacheDirectory: root, storage });
    await first.services
      .use(HistorySnapshotsV1)
      .write({ threadId: 'thread-id', updates: [snapshot] });
    await first.stop();

    const reset = await bootDesktop({
      cacheDirectory: root,
      storage: { ...storage, storageGeneration: 4 },
    });
    assert.equal(
      await reset.services.use(HistorySnapshotsV1).read('thread-id'),
      null,
    );
    await reset.stop();
  });

  test('without a host storage identity nothing is kept or written', async () => {
    const root = cacheDirectory();
    const desktop = await bootDesktop({ cacheDirectory: root });
    const history = desktop.services.use(HistorySnapshotsV1);

    assert.equal(desktop.states.history, 'active');
    await history.write({ threadId: 'thread-id', updates: [snapshot] });
    assert.equal(await history.read('thread-id'), null);
    await desktop.beforeQuit();
    await desktop.stop();
    assert.deepEqual(readdirSync(root), []);
  });
});
