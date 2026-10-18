import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ContractError } from 'bundle/contracts';

import {
  createTerminalApi,
  type TerminalHost,
  terminalApiMessages,
} from '../src/client/api.js';
import type {
  Terminal,
  TerminalUpdate,
} from '../src/client/domain/terminals.js';
import { createTerminalStore } from '../src/client/store.js';
import type { TerminalSession } from '../src/contracts/index.js';
import { deferred } from './support/deferred.js';

/*
 * The window's terminal calls and state (moved from the layout's provisional
 * adapter, `useTerminals` and the manual part of its tabs store): the
 * payload guards and failure sentences of the old terminal REST client, the
 * ordered keystrokes, and what a list change does to tabs, manual shells and
 * the Project's file reads.
 */

const session = (
  overrides: Partial<TerminalSession> = {},
): TerminalSession => ({
  id: 'terminal-1',
  projectId: 'project-1',
  threadId: 'thread-1',
  origin: 'user',
  command: 'bash',
  cwd: '/workspace',
  startedAt: '2026-01-01T00:00:00.000Z',
  timeoutMs: null,
  state: 'running',
  pty: true,
  ...overrides,
});

const host = (overrides: Partial<TerminalHost> = {}): TerminalHost => ({
  list: async () => [],
  create: async () => session(),
  snapshot: async () => ({
    terminal: session(),
    output: 'out',
    offset: 3,
    truncated: false,
  }),
  input: async () => true,
  resize: async () => true,
  stop: async () => true,
  ...overrides,
});

void describe('terminal client calls', () => {
  void test('a lost bridge is the backend being unavailable; any other failure is one sentence', async () => {
    for (const code of ['unavailable', 'disconnected', 'generation_lost']) {
      const api = createTerminalApi(() =>
        host({
          list: async () => {
            throw new ContractError(code as 'unavailable', 'x');
          },
        }),
      );
      await assert.rejects(api.list('project-1'), {
        message: 'Doric backend is unavailable.',
      });
    }
    const api = createTerminalApi(() =>
      host({
        stop: async () => {
          throw new Error('boom');
        },
      }),
    );
    await assert.rejects(api.stop('terminal-1'), {
      message: 'Doric could not complete the terminal request.',
    });
  });

  void test('missing terminals answer the route statuses as the failure sentence', async () => {
    const api = createTerminalApi(() =>
      host({
        create: async () => undefined,
        snapshot: async () => undefined,
        input: async () => false,
        resize: async () => false,
      }),
    );
    for (const call of [
      api.create('thread-1'),
      api.snapshot('terminal-1'),
      api.input('terminal-1', 'x'),
      api.resize('terminal-1', 80, 24),
    ])
      await assert.rejects(call, {
        message: terminalApiMessages.terminalFailed,
      });
  });

  void test('payloads are guarded before any host call, with the main process messages', async () => {
    let calls = 0;
    const api = createTerminalApi(() => {
      calls += 1;
      return host();
    });
    await assert.rejects(api.list(''), {
      message: 'The item identifier is invalid.',
    });
    await assert.rejects(api.input('terminal-1', 'x'.repeat(65_537)), {
      message: 'Terminal input is invalid.',
    });
    await assert.rejects(api.resize('terminal-1', 0, 24), {
      message: 'Terminal dimensions are invalid.',
    });
    await assert.rejects(api.resize('terminal-1', 80, 1001), {
      message: 'Terminal dimensions are invalid.',
    });
    assert.equal(calls, 0);
  });

  void test('invalid answers are refused with their own messages', async () => {
    const api = createTerminalApi(() =>
      host({
        list: async () => [{ ...session(), origin: 'robot' } as never],
        snapshot: async () => ({
          terminal: session(),
          output: 'long',
          offset: 2,
          truncated: false,
        }),
      }),
    );
    await assert.rejects(api.list('project-1'), {
      message: 'Doric returned an invalid terminal.',
    });
    await assert.rejects(api.snapshot('terminal-1'), {
      message: 'Doric returned an invalid terminal snapshot.',
    });
  });

  void test('keystrokes reach the host in typed order, even after a failed write', async () => {
    const gate = deferred();
    const written: string[] = [];
    const api = createTerminalApi(() =>
      host({
        input: async (_id, data) => {
          if (data === 'a') await gate.promise;
          written.push(data);
          return data !== 'b';
        },
      }),
    );
    const first = api.input('terminal-1', 'a');
    const second = api.input('terminal-1', 'b');
    const third = api.input('terminal-1', 'c');
    gate.resolve();
    await first;
    await assert.rejects(second);
    await third;
    assert.deepEqual(written, ['a', 'b', 'c']);
  });

  void test('records are copied field by field, dropping unknown fields', async () => {
    const api = createTerminalApi(() =>
      host({ list: async () => [{ ...session(), extra: 1 } as never] }),
    );
    assert.deepEqual(await api.list('project-1'), [session()]);
  });
});

const storeFixture = (
  api = createTerminalApi(() => host()),
  openTerminal?: (terminal: Terminal) => Promise<void>,
) => {
  const listeners = new Map<string, (update: TerminalUpdate) => void>();
  const toasts: string[] = [];
  const closed: { id: string; threadId: string }[] = [];
  const refreshed: string[] = [];
  const opened: Terminal[] = [];
  const store = createTerminalStore({
    api,
    openTerminal:
      openTerminal ??
      (async (terminal) => {
        opened.push(terminal);
      }),
    watchProject: (projectId, listener) => {
      listeners.set(projectId, listener);
      return () => listeners.delete(projectId);
    },
    toastError: (message) => toasts.push(message),
    closeTab: (input) => closed.push(input),
    refreshFiles: (projectId) => refreshed.push(projectId),
  });
  return {
    store,
    toasts,
    closed,
    refreshed,
    opened,
    emit: (projectId: string, update: TerminalUpdate) =>
      listeners.get(projectId)?.(update),
    listeners,
  };
};

const agent = session({ id: 'agent-1', origin: 'agent', command: 'npm test' });
const manual = session({ id: 'manual-1' }) as Terminal;

void describe('terminal store', () => {
  void test('follows a Project once and lists its terminals by Thread', () => {
    const f = storeFixture();
    f.store.follow('project-1');
    f.store.follow('project-1');
    assert.equal(f.listeners.size, 1);
    f.emit('project-1', { kind: 'snapshot', terminals: [agent, manual] });
    assert.deepEqual(
      f.store.threadTerminals('thread-1').map(({ id }) => id),
      ['agent-1', 'manual-1'],
    );
    f.store.unfollow('project-1');
    assert.equal(f.listeners.size, 0);
    assert.deepEqual(f.store.terminals(), []);
  });

  void test('a terminal leaving the list closes its workspace tab for either origin', () => {
    const f = storeFixture();
    f.store.follow('project-1');
    f.emit('project-1', { kind: 'snapshot', terminals: [agent, manual] });
    f.emit('project-1', { kind: 'snapshot', terminals: [manual] });
    assert.deepEqual(f.closed, [
      { id: 'terminal:agent-1', threadId: 'thread-1' },
    ]);
    f.emit('project-1', { kind: 'removed', terminalId: 'manual-1' });
    assert.deepEqual(f.closed.at(-1), {
      id: 'terminal:manual-1',
      threadId: 'thread-1',
    });
    assert.deepEqual(f.store.terminals(), []);
  });

  void test('only a change of terminal activity refreshes the Project files', () => {
    const f = storeFixture();
    f.store.follow('project-1');
    f.emit('project-1', { kind: 'snapshot', terminals: [manual] });
    f.emit('project-1', { kind: 'snapshot', terminals: [manual] });
    f.emit('project-1', {
      kind: 'updated',
      terminal: { ...manual, command: 'npm run dev' },
    });
    f.emit('project-1', {
      kind: 'updated',
      terminal: { ...manual, command: 'npm run dev', timeoutMs: 5 },
    });
    assert.deepEqual(f.refreshed, ['project-1', 'project-1']);
  });

  void test('a stream error is a toast and leaves the list as it was', () => {
    const f = storeFixture();
    f.store.follow('project-1');
    f.emit('project-1', { kind: 'snapshot', terminals: [manual] });
    f.emit('project-1', {
      kind: 'error',
      message: 'The terminal connection failed.',
    });
    assert.deepEqual(f.toasts, ['The terminal connection failed.']);
    assert.equal(f.store.terminals().length, 1);
  });

  void test('create lists the new shell and opens its workspace tab; a failure is a toast', async () => {
    const f = storeFixture();
    await f.store.create('thread-1');
    assert.deepEqual(
      f.opened.map(({ id }) => id),
      ['terminal-1'],
    );
    assert.deepEqual(
      f.store.terminals().map(({ id }) => id),
      ['terminal-1'],
    );
    const failing = storeFixture(
      createTerminalApi(() => host({ create: async () => undefined })),
    );
    await failing.store.create('thread-1');
    assert.deepEqual(failing.toasts, [
      'Doric could not complete the terminal request.',
    ]);
  });

  void test('a failed workspace-tab opening retains the created shell for reopening', async () => {
    const f = storeFixture(undefined, async () => {
      throw new Error('The workspace tab could not open.');
    });
    await f.store.create('thread-1');
    assert.deepEqual(
      f.store.threadTerminals('thread-1').map(({ id }) => id),
      ['terminal-1'],
    );
    assert.deepEqual(f.toasts, ['The workspace tab could not open.']);
  });

  void test('a failed stop is a toast', async () => {
    const f = storeFixture(
      createTerminalApi(() =>
        host({
          stop: async () => {
            throw new Error('x');
          },
        }),
      ),
    );
    f.store.stop('terminal-1');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.toasts, [
      'Doric could not complete the terminal request.',
    ]);
  });
});
