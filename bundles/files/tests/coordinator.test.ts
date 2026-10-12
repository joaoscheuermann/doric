// files.refresh/v1 (stage 10, §3.6): when the Project refresh coordinator
// rereads a Project's registered reads. Observed through the public service
// and a registrant's `refresh`, over a fake workspace, a fake window and a
// fake clock; the coalescing is the refresh queue's, observed through one
// files query client.

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { QueryClient, QueryObserver } from '@tanstack/query-core';
import type { Disposable } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';

import {
  createFilesRefresh,
  createRefreshCoordinator,
  PERIODIC_REFRESH_MS,
  type RefreshEnvironment,
  type RefreshWorkspace,
} from '../src/client/refresh/coordinator.js';
import { refreshSandbox } from '../src/client/sandbox-store.js';
import { FilesRefreshV1 } from '../src/contracts/index.js';

type Thread = { id: string; state: string; cwd?: string };

const fakeWorkspace = () => {
  const listeners = new Set<() => void>();
  const state = {
    project: { id: 'p-1', state: 'ready' } as
      | { id: string; state: string }
      | undefined,
    thread: { id: 't-1', cwd: '/workspace' } as
      | { id: string; cwd?: string }
      | undefined,
    threads: [{ id: 't-1', state: 'ready', cwd: '/workspace' }] as Thread[],
    connected: true,
  };
  const workspace: RefreshWorkspace = {
    selection: () => ({
      ...(state.project === undefined ? {} : { project: state.project }),
      ...(state.thread === undefined ? {} : { thread: state.thread }),
    }),
    threads: (projectId) =>
      projectId === state.project?.id ? state.threads : [],
    connected: () => state.connected,
    subscribe: (listener): Disposable => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  return {
    workspace,
    state,
    change: (update: (current: typeof state) => void) => {
      update(state);
      for (const listener of [...listeners]) listener();
    },
  };
};

interface FakeWindow {
  visible: boolean;
  readonly environment: RefreshEnvironment;
  tick(): void;
  focus(): void;
}

const fakeWindow = (): FakeWindow => {
  const timers = new Map<number, () => void>();
  const focus = new Set<() => void>();
  let next = 0;
  const screen: FakeWindow = {
    visible: true,
    environment: {
      visible: () => screen.visible,
      onFocus: (listener) => {
        focus.add(listener);
        return () => focus.delete(listener);
      },
      setInterval: (callback, ms) => {
        assert.equal(ms, PERIODIC_REFRESH_MS);
        next += 1;
        timers.set(next, callback);
        return next;
      },
      clearInterval: (handle) => timers.delete(handle as number),
    },
    tick: () => {
      for (const callback of [...timers.values()]) callback();
    },
    focus: () => {
      for (const listener of [...focus]) listener();
    },
  };
  return screen;
};

/** A registrant recording each refresh it is asked for. */
const registrant = (projectId: string, shown = true) => {
  const refreshes: boolean[] = [];
  return {
    refreshes,
    reads: {
      projectId,
      active: () => shown,
      refresh: async ({ periodic }: { readonly periodic: boolean }) => {
        refreshes.push(periodic);
      },
    },
  };
};

let window: FakeWindow;
let workspace: ReturnType<typeof fakeWorkspace>;

beforeEach(() => {
  window = fakeWindow();
  workspace = fakeWorkspace();
});

const setup = () => {
  const coordinator = createRefreshCoordinator(window.environment);
  coordinator.setWorkspace(workspace.workspace);
  return coordinator;
};

describe('files.refresh/v1', () => {
  test('a request rereads every registrant of that Project, and only those', async () => {
    const coordinator = setup();
    const harness = createTestServices({
      bundle: { id: 'git' },
      provide: [createFilesRefresh(coordinator)],
    });
    const refresh = harness.services.use(FilesRefreshV1);
    const mine = registrant('p-1');
    const other = registrant('p-2');
    refresh.register(mine.reads);
    refresh.register(other.reads);
    mine.refreshes.length = 0;
    other.refreshes.length = 0;

    refresh.request('p-2');
    refresh.request('p-2', { periodic: true });

    assert.deepEqual(mine.refreshes, []);
    assert.deepEqual(other.refreshes, [false, true]);
    await harness.dispose();
  });

  test('a registrant disposed hears no further request', () => {
    const coordinator = setup();
    const mine = registrant('p-1');
    const registration = coordinator.register(mine.reads);
    registration.dispose();
    mine.refreshes.length = 0;

    coordinator.request('p-1');

    assert.deepEqual(mine.refreshes, []);
  });

  test('a change of what the selected Project shows rereads it, while connected', () => {
    const coordinator = setup();
    const mine = registrant('p-1');
    coordinator.register(mine.reads);
    // Something of the selected Project became shown.
    assert.deepEqual(mine.refreshes, [false]);

    workspace.change((state) => {
      state.thread = { id: 't-1', cwd: '/workspace/src' };
    });
    workspace.change((state) => {
      state.threads = [{ id: 't-1', state: 'running', cwd: '/workspace/src' }];
    });
    workspace.change((state) => {
      state.project = { id: 'p-1', state: 'cancelled' };
    });
    assert.deepEqual(mine.refreshes, [false, false, false, false]);

    // A notification that changes nothing the policy reads rereads nothing.
    workspace.change(() => undefined);
    assert.equal(mine.refreshes.length, 4);
  });

  test('offline, nothing rereads; the connection coming back does', () => {
    const coordinator = setup();
    const mine = registrant('p-1');
    coordinator.register(mine.reads);
    mine.refreshes.length = 0;

    workspace.change((state) => {
      state.connected = false;
    });
    workspace.change((state) => {
      state.thread = { id: 't-2', cwd: '/workspace' };
    });
    window.tick();
    window.focus();
    assert.deepEqual(mine.refreshes, []);

    workspace.change((state) => {
      state.connected = true;
    });
    assert.deepEqual(mine.refreshes, [false]);
  });

  test('the 15-second poll is periodic and runs only while shown and visible', () => {
    const coordinator = setup();
    const hidden = registrant('p-1', false);
    coordinator.register(hidden.reads);
    hidden.refreshes.length = 0;
    window.tick();
    assert.deepEqual(hidden.refreshes, [], 'nothing of the Project is shown');

    const shown = registrant('p-1');
    coordinator.register(shown.reads);
    shown.refreshes.length = 0;
    hidden.refreshes.length = 0;
    window.tick();
    assert.deepEqual(shown.refreshes, [true]);

    window.visible = false;
    window.tick();
    assert.deepEqual(shown.refreshes, [true], 'the document is hidden');
  });

  test('window focus rereads the shown Project as a change, not a poll', () => {
    const coordinator = setup();
    const shown = registrant('p-1');
    coordinator.register(shown.reads);
    shown.refreshes.length = 0;

    window.focus();
    assert.deepEqual(shown.refreshes, [false]);

    window.visible = false;
    window.focus();
    assert.deepEqual(shown.refreshes, [false]);
  });

  test('a Project not selected is reread only when asked', () => {
    const coordinator = setup();
    const other = registrant('p-2');
    coordinator.register(other.reads);
    window.tick();
    window.focus();
    workspace.change((state) => {
      state.thread = { id: 't-9', cwd: '/workspace' };
    });
    assert.deepEqual(other.refreshes, []);
  });
});

describe('a registrant over the files query client', () => {
  test('a burst of requests coalesces into one reread after 250 ms', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    let reads = 0;
    const observer = new QueryObserver(client, {
      queryKey: ['files', 'p-1', 'tree', undefined],
      queryFn: async () => {
        reads += 1;
        return { status: 'ready' as const };
      },
    });
    const stop = observer.subscribe(() => undefined);
    await settle();
    assert.equal(reads, 1, 'the first read');

    const coordinator = setup();
    coordinator.register({
      projectId: 'p-1',
      active: () => true,
      refresh: ({ periodic }) => refreshSandbox(client, 'p-1', periodic),
    });
    for (let index = 0; index < 5; index += 1) coordinator.request('p-1');
    t.mock.timers.tick(249);
    await settle();
    assert.equal(reads, 1, 'nothing before the coalescing delay');
    t.mock.timers.tick(1);
    for (let index = 0; index < 5; index += 1) await settle();

    assert.equal(reads, 2, 'one reread for the whole burst');
    stop();
    coordinator.dispose();
    client.clear();
  });
});
