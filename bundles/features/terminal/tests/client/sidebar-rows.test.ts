// The terminal bundle's sidebar registration answers `busy` (spec
// docs/designs/sidebar-alignment.md §3; T-2.10, T-2.10b): a Thread with an
// agent terminal that has not exited is busy, the answer follows the store,
// and resolving each Thread's Project costs at most one `workspace().thread`
// call per Thread for the registration's life. The store is the real one over
// a fake `watchProject` stream (the host boundary); the regions, the sidebar
// and `layout.workspace/v1` are fakes that record what they were asked.

import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { describe, test } from 'node:test';

import type { Disposable } from 'bundle/contracts';

import { createTerminalApi } from '../../src/client/api.js';
import {
  isAgentBusy,
  type Terminal,
  type TerminalUpdate,
} from '../../src/client/domain/terminals.js';
import type { ThreadRecord, ThreadRows } from '../../src/client/peers.js';
import { createTerminalStore } from '../../src/client/store.js';

// The client entry reaches the terminal view, which imports xterm's
// stylesheet; Node loads no CSS, so a stylesheet loads as an empty module
// here (`module.registerHooks`, Node 22.15+; the repository's @types/node
// predates it).
(
  nodeModule as unknown as {
    registerHooks(hooks: {
      load(
        url: string,
        context: unknown,
        next: (url: string, context: unknown) => unknown,
      ): unknown;
    }): void;
  }
).registerHooks({
  load: (url, context, next) =>
    url.endsWith('.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : next(url, context),
});
const { registerTerminalSurfaces } = await import('../../src/client/index.js');

const PROJECT = 'project-1';

const terminal = (
  id: string,
  threadId: string,
  fields: Partial<Terminal> = {},
): Terminal => ({
  id,
  projectId: PROJECT,
  threadId,
  origin: 'agent',
  command: 'npm run dev',
  cwd: '/workspace',
  startedAt: '2026-11-10T10:00:00.000Z',
  timeoutMs: null,
  state: 'running',
  pty: true,
  ...fields,
});

const unreachable = async (): Promise<never> => {
  throw new Error('The test calls no terminal API.');
};

/**
 * The registration over fakes. `answer` decides what the fake
 * `workspace().thread` returns for each call, by Thread id and call number
 * (1-based); by default every Thread belongs to `PROJECT`.
 */
const setup = (
  answer: (threadId: string, call: number) => ThreadRecord | undefined = (
    threadId,
  ) => ({ id: threadId, projectId: PROJECT }),
) => {
  const streams = new Map<string, (update: TerminalUpdate) => void>();
  const followed: string[] = [];
  const store = createTerminalStore({
    api: createTerminalApi(() => ({
      list: unreachable,
      create: unreachable,
      snapshot: unreachable,
      input: unreachable,
      resize: unreachable,
      stop: unreachable,
      rename: unreachable,
    })),
    openTerminal: async () => undefined,
    watchProject: (projectId, listener) => {
      followed.push(projectId);
      streams.set(projectId, listener);
      return () => streams.delete(projectId);
    },
    toastError: () => undefined,
    closeTab: () => undefined,
    retitleTab: () => undefined,
    refreshFiles: () => undefined,
  });

  const lookups: string[] = [];
  let registered: ThreadRows | undefined;
  const registration = registerTerminalSurfaces(
    { add: (): Disposable => ({ dispose: () => undefined }) },
    {
      addThreadRows: (rows): Disposable => {
        registered = rows;
        return { dispose: () => undefined };
      },
    },
    store,
    () => ({
      thread: (threadId: string) => {
        lookups.push(threadId);
        return answer(threadId, lookups.filter((id) => id === threadId).length);
      },
    }),
  );
  assert.ok(registered !== undefined, 'No thread rows were registered.');
  const rows = registered;

  return {
    rows,
    busy: (threadId: string): boolean => {
      assert.ok(rows.busy !== undefined, 'The registration answers no busy.');
      return rows.busy(threadId);
    },
    followed,
    /** The `workspace().thread` calls so far, by Thread id. */
    lookups,
    /** Delivers an update on the Project's stream; fails unless followed. */
    report: (update: TerminalUpdate, projectId = PROJECT): void => {
      const stream = streams.get(projectId);
      assert.ok(
        stream !== undefined,
        `The Project ${projectId} is not followed.`,
      );
      stream(update);
    },
    dispose: () => {
      registration.dispose();
      store.dispose();
    },
  };
};

describe('the terminal registration answers busy (T-2.10)', () => {
  test('an agent terminal that has not exited makes its Thread busy; an exited or user terminal does not', () => {
    const fixture = setup();
    try {
      // Nothing followed the Project yet (`count` was never called).
      assert.equal(fixture.busy('running'), false, 'Busy before any snapshot.');
      assert.deepEqual(
        fixture.followed,
        [PROJECT],
        "The first busy call does not follow the Thread's Project.",
      );

      fixture.report({
        kind: 'snapshot',
        terminals: [
          terminal('a', 'running'),
          terminal('b', 'starting', { state: 'starting' }),
          terminal('c', 'exited', { state: 'exited' }),
          terminal('d', 'user', { origin: 'user' }),
        ],
      });

      assert.equal(fixture.busy('running'), true);
      assert.equal(fixture.busy('starting'), true);
      assert.equal(fixture.busy('exited'), false);
      assert.equal(fixture.busy('user'), false);
      assert.equal(fixture.busy('none'), false);
    } finally {
      fixture.dispose();
    }
  });

  test('the answer follows the store, and the listener hears each change', () => {
    const fixture = setup();
    try {
      fixture.busy('t1');
      let heard = 0;
      fixture.rows.subscribe(() => {
        heard += 1;
      });

      fixture.report({ kind: 'snapshot', terminals: [terminal('a', 't1')] });
      assert.equal(fixture.busy('t1'), true);
      assert.ok(heard > 0, 'The listener did not hear the snapshot.');

      const before = heard;
      fixture.report({
        kind: 'updated',
        terminal: terminal('a', 't1', { state: 'exited' }),
      });
      assert.ok(heard > before, 'The listener did not hear the exit.');
      assert.equal(fixture.busy('t1'), false, 'An exited agent keeps t1 busy.');

      fixture.report({
        kind: 'updated',
        terminal: terminal('b', 't2', { state: 'starting' }),
      });
      assert.equal(
        fixture.busy('t2'),
        true,
        'A starting agent leaves t2 idle.',
      );
      assert.equal(fixture.busy('t1'), false);
    } finally {
      fixture.dispose();
    }
  });

  test('resolves each Thread at most once for the registration, however many rounds', () => {
    const fixture = setup();
    const threads = ['t1', 't2', 't3', 't4', 't5'];
    try {
      for (const id of threads) fixture.busy(id);
      assert.ok(
        fixture.lookups.length <= threads.length,
        `The first round made ${fixture.lookups.length} lookups for ${threads.length} Threads.`,
      );

      fixture.report({
        kind: 'snapshot',
        terminals: [
          terminal('a', 't2'),
          terminal('b', 't4', { origin: 'user' }),
        ],
      });
      const first = fixture.lookups.length;
      assert.deepEqual(
        threads.map((id) => fixture.busy(id)),
        [false, true, false, false, false],
      );
      assert.equal(
        fixture.lookups.length,
        first,
        'The second round looked Threads up again.',
      );
    } finally {
      fixture.dispose();
    }
  });

  test('a Thread not loaded yet is looked up again on the next call, then never', () => {
    const fixture = setup((threadId, call) =>
      threadId === 'late' && call === 1
        ? undefined
        : { id: threadId, projectId: PROJECT },
    );
    const count = (): number =>
      fixture.lookups.filter((id) => id === 'late').length;
    try {
      fixture.busy('late');
      assert.equal(count(), 1);
      fixture.busy('late');
      assert.equal(count(), 2, 'The unresolved Thread was not asked again.');
      fixture.busy('late');
      assert.equal(count(), 2, 'The resolved Thread was asked again.');
      assert.deepEqual(fixture.followed, [PROJECT]);
    } finally {
      fixture.dispose();
    }
  });

  test('count keeps its answers', () => {
    const fixture = setup();
    try {
      fixture.rows.count('t1');
      fixture.report({
        kind: 'snapshot',
        terminals: [
          terminal('a', 't1'),
          terminal('b', 't1', { state: 'exited' }),
          terminal('c', 't2', { origin: 'user' }),
        ],
      });
      assert.equal(fixture.rows.count('t1'), 2);
      assert.equal(fixture.rows.count('t2'), 1);
      assert.equal(fixture.rows.count('t3'), 0);
    } finally {
      fixture.dispose();
    }
  });
});

describe('isAgentBusy (T-2.10b)', () => {
  test('is true for an agent terminal starting or running', () => {
    assert.equal(isAgentBusy(terminal('a', 't', { state: 'starting' })), true);
    assert.equal(isAgentBusy(terminal('a', 't', { state: 'running' })), true);
  });

  test('is false for an exited agent terminal and for a user terminal', () => {
    assert.equal(isAgentBusy(terminal('a', 't', { state: 'exited' })), false);
    assert.equal(
      isAgentBusy(terminal('a', 't', { origin: 'user', state: 'running' })),
      false,
    );
  });
});
