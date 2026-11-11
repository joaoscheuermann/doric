// layout.sidebar/v1 (R-9.4): a bundle adds rows under each Thread; a Thread
// with rows counted is expandable, the tree re-reads counts when the owner
// says they changed, and a duplicate id is a registration conflict.

import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';

import { ContractError, type Disposable } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';

import { createLayoutSidebar } from '../src/client/services/layout-sidebar.js';
import {
  hasThreadRows,
  resetThreadRows,
  threadRowsBusy,
  threadRowsStore,
} from '../src/client/stores/thread-rows.js';
import { LayoutSidebarV1, type ThreadRows } from '../src/contracts/index.js';

const counted = (counts: Record<string, number>) => {
  const listeners = new Set<() => void>();
  return {
    rows: {
      id: 'terminals',
      tag: 'terminal-rows',
      count: (threadId: string) => counts[threadId] ?? 0,
      subscribe: (listener: () => void): Disposable => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    },
    change: (threadId: string, count: number) => {
      counts[threadId] = count;
      for (const listener of listeners) listener();
    },
    listeners,
  };
};

const setup = () => {
  const harness = createTestServices({
    bundle: { id: 'terminal' },
    provide: [createLayoutSidebar()],
  });
  return {
    sidebar: harness.services.use(LayoutSidebarV1),
    dispose: harness.dispose,
  };
};

beforeEach(resetThreadRows);

describe('layout.sidebar/v1', () => {
  test('a Thread with rows counted is expandable; others are not', async () => {
    const { sidebar, dispose } = setup();
    const owner = counted({ t1: 2 });
    sidebar.addThreadRows(owner.rows);

    const { rows } = threadRowsStore.getState();
    assert.equal(hasThreadRows(rows, 't1'), true);
    assert.equal(hasThreadRows(rows, 't2'), false);
    await dispose();
  });

  test('a count change moves the revision the tree re-renders on', async () => {
    const { sidebar, dispose } = setup();
    const owner = counted({});
    sidebar.addThreadRows(owner.rows);
    const before = threadRowsStore.getState().revision;

    owner.change('t1', 1);

    assert.ok(threadRowsStore.getState().revision > before);
    assert.equal(hasThreadRows(threadRowsStore.getState().rows, 't1'), true);
    await dispose();
  });

  test('disposing removes the rows and stops listening to their owner', async () => {
    const { sidebar, dispose } = setup();
    const owner = counted({ t1: 1 });
    const registration = sidebar.addThreadRows(owner.rows);

    registration.dispose();

    assert.deepEqual(threadRowsStore.getState().rows, []);
    assert.equal(owner.listeners.size, 0);
    await dispose();
  });

  test('a second registration with the same id is a conflict', async () => {
    const { sidebar, dispose } = setup();
    sidebar.addThreadRows(counted({}).rows);

    assert.throws(
      () => sidebar.addThreadRows(counted({}).rows),
      (error: unknown) =>
        error instanceof ContractError &&
        error.code === 'registration_conflict',
    );
    await dispose();
  });

  test('a count that throws counts as no rows', () => {
    assert.equal(
      hasThreadRows(
        [
          {
            id: 'broken',
            tag: 'x-broken',
            count: () => {
              throw new Error('broken');
            },
            subscribe: () => ({ dispose: () => undefined }),
          },
        ],
        't1',
      ),
      false,
    );
  });

  test('accepts a registration with a busy answer and one without (T-2.6)', async () => {
    const { sidebar, dispose } = setup();
    const busy = { ...counted({}).rows, id: 'busy', busy: () => true };
    const plain = { ...counted({}).rows, id: 'plain' };

    sidebar.addThreadRows(busy);
    sidebar.addThreadRows(plain);

    assert.equal(threadRowsStore.getState().rows.length, 2);
    await dispose();
  });

  for (const value of [1, null]) {
    test(`refuses busy: ${String(value)} as invalid input (T-2.6)`, async () => {
      const { sidebar, dispose } = setup();
      const rows = {
        ...counted({}).rows,
        busy: value,
      } as unknown as ThreadRows;

      assert.throws(
        () => sidebar.addThreadRows(rows),
        (error: unknown) =>
          error instanceof ContractError &&
          error.code === 'invalid_input' &&
          error.message.includes('Expected { id, tag, count, subscribe, busy? }.'),
      );
      await dispose();
    });
  }
});

describe('threadRowsBusy', () => {
  const rows = (id: string, busy?: (threadId: string) => boolean): ThreadRows => ({
    id,
    tag: `x-${id}`,
    count: () => 0,
    subscribe: () => ({ dispose: () => undefined }),
    ...(busy === undefined ? {} : { busy }),
  });

  test('is false when no registration answers busy (T-2.6)', () => {
    assert.equal(threadRowsBusy([], 't1'), false);
    assert.equal(threadRowsBusy([rows('plain')], 't1'), false);
  });

  test('reads a throwing busy as false and logs nothing (T-2.6)', () => {
    const logged = ['error', 'warn', 'log', 'info', 'debug'].map((name) =>
      mock.method(console, name as 'error', () => undefined),
    );
    try {
      const broken = rows('broken', () => {
        throw new Error('broken');
      });
      assert.equal(threadRowsBusy([broken], 't1'), false);
      for (const spy of logged) assert.equal(spy.mock.callCount(), 0);
    } finally {
      for (const spy of logged) spy.mock.restore();
    }
  });

  test('is true when any registration answers true (T-2.6)', () => {
    const broken = rows('broken', () => {
      throw new Error('broken');
    });
    assert.equal(
      threadRowsBusy(
        [rows('plain'), broken, rows('idle', () => false), rows('busy', (id) => id === 't1')],
        't1',
      ),
      true,
    );
    assert.equal(
      threadRowsBusy([rows('busy', (id) => id === 't1')], 't2'),
      false,
    );
  });
});
