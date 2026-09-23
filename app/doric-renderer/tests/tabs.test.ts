import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  parseTabs,
  restoreTabs,
  serializeTabs,
  shouldWriteTabs,
} from '../src/domain/tabs';
import type { Thread } from '../src/domain/workspace';

const thread = (id: string): Thread => ({
  id,
  name: id,
  projectId: 'project',
  state: 'ready',
  createdAt: '',
  updatedAt: '',
});

describe('persisted tabs', () => {
  test('rejects unversioned and malformed local state', () => {
    assert.equal(parseTabs('{"openThreadIds":[]}'), undefined);
    assert.equal(parseTabs('{"version":1,"openThreadIds":[1]}'), undefined);
    assert.equal(parseTabs('not json'), undefined);
  });

  test('preserves open order and selected thread', async () => {
    const stored = parseTabs(
      serializeTabs([thread('second'), thread('first')], 'first'),
    );
    const restored = await restoreTabs(stored, async (id) => thread(id));

    assert.deepEqual(
      restored.openThreads.map(({ id }) => id),
      ['second', 'first'],
    );
    assert.equal(restored.selectedThread?.id, 'first');
  });

  test('discards missing Threads while retaining valid relative order', async () => {
    const restored = await restoreTabs(
      {
        version: 1,
        openThreadIds: ['one', 'missing', 'two'],
        selectedThreadId: 'missing',
      },
      async (id) => (id === 'missing' ? undefined : thread(id)),
    );

    assert.deepEqual(
      restored.openThreads.map(({ id }) => id),
      ['one', 'two'],
    );
    assert.equal(restored.selectedThread?.id, 'one');
  });

  test('propagates a transient lookup failure instead of dropping saved tabs', async () => {
    await assert.rejects(
      restoreTabs({ version: 1, openThreadIds: ['one'] }, async () => {
        throw new Error('Doric backend is unavailable.');
      }),
      /Doric backend is unavailable/,
    );
  });

  test('writes nothing while the saved tabs are still being read', () => {
    assert.equal(shouldWriteTabs(undefined, false), false);
    assert.equal(shouldWriteTabs(undefined, true), false);
  });

  test('writes once a read found nothing or restored the saved tabs', () => {
    assert.equal(shouldWriteTabs('none', false), true);
    assert.equal(shouldWriteTabs('restored', false), true);
  });

  test('keeps the saved tabs when the read that would replace them failed', () => {
    assert.equal(shouldWriteTabs('failed', false), false);
  });

  test('writes every change that follows a failed read', () => {
    assert.equal(shouldWriteTabs('failed', true), true);
  });
});
