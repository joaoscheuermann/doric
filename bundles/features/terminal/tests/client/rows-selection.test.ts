// The terminal rows element as the layout mounts it under a Thread (spec
// docs/designs/sidebar-alignment.md §11.4, D23; T-5.6b): a terminal row is
// selected while the route names the element's Thread and the selected tab
// (`layout.tabs/v1.current()`) is that terminal's tab, `terminal:<id>`. The
// element subscribes to the tabs only while its Thread has terminals.
//
// The store, `layout.workspace/v1`, `layout.tabs/v1` and `navigation/v1` are
// fakes the test drives; happy-dom renders the element.

import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { afterEach, describe, test } from 'node:test';

import type { Disposable, Services } from 'bundle/contracts';
import type { ReactElementInstance } from 'desktop/ui/react-element';

import type { Terminal } from '../../src/client/domain/terminals.js';
import type { TerminalClient } from '../../src/client/elements.js';
import type { TerminalStore } from '../../src/client/store.js';
import { installWindow, settle } from './support/render.js';

// `elements.tsx` reaches the terminal view, which imports xterm's stylesheet;
// Node loads no CSS, so a stylesheet loads as an empty module here
// (`module.registerHooks`, Node 22.15+; the repository's @types/node predates
// it). Registered before `elements.tsx` is imported below.
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

// React DOM and the bundle's client modules load after the window.
installWindow();
const { defineTerminalElements } = await import('../../src/client/elements.js');
const tabModule = await import('../../src/client/tab.js');

const PROJECT = 'project-1';
const THREAD_A = 'thread-a';
const THREAD_B = 'thread-b';
const THREAD_C = 'thread-c';

const terminal = (id: string, threadId: string): Terminal => ({
  id,
  projectId: PROJECT,
  threadId,
  origin: 'user',
  command: `command-${id}`,
  cwd: '/workspace',
  startedAt: '2026-11-10T10:00:00.000Z',
  timeoutMs: null,
  state: 'running',
  pty: true,
});

const unused = (): never => {
  throw new Error('The test does not call this.');
};

/** A `TerminalStore` whose list the test sets and whose listeners it calls. */
const fakeStore = () => {
  let list: readonly Terminal[] = [
    terminal('t1', THREAD_A),
    terminal('t2', THREAD_A),
    terminal('t3', THREAD_B),
  ];
  const listeners = new Set<() => void>();
  const store: TerminalStore = {
    follow: unused,
    unfollow: unused,
    terminals: () => list,
    threadTerminals: (threadId) =>
      list.filter((item) => item.threadId === threadId),
    create: unused,
    stop: unused,
    rename: unused,
    subscribe: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    dispose: () => undefined,
  };
  return {
    store,
    /** Replaces the list and tells the subscribers. */
    set: (next: readonly Terminal[]): void => {
      list = next;
      for (const listener of [...listeners]) listener();
    },
    list: (): readonly Terminal[] => list,
  };
};

/** What the `Services` fake serves; a missing contract is not available. */
interface Peers {
  readonly tabs?: boolean;
  readonly navigation?: boolean;
}

const fakeServices = ({ tabs = true, navigation = true }: Peers = {}) => {
  let route: string = THREAD_A;
  let selectedTab:
    | { readonly id: string; readonly props?: Record<string, unknown> }
    | undefined;
  const tabListeners = new Set<() => void>();
  const routeListeners = new Set<(match: unknown) => void>();
  const match = () => ({
    path: `/projects/${PROJECT}/threads/${route}`,
    pattern: '/projects/:projectId/threads/:threadId',
    params: { projectId: PROJECT, threadId: route },
  });

  const record = (id: string) =>
    [THREAD_A, THREAD_B, THREAD_C].includes(id)
      ? { id, projectId: PROJECT }
      : undefined;
  const apis: Record<string, unknown> = {
    'layout.workspace/v1': {
      thread: (id: string) => record(id),
      selectedThread: () => record(route),
      subscribe: (): Disposable => ({ dispose: () => undefined }),
    },
  };
  if (tabs) {
    apis['layout.tabs/v1'] = {
      open: unused,
      close: unused,
      retitle: unused,
      current: () => selectedTab,
      subscribe: (listener: () => void): Disposable => {
        tabListeners.add(listener);
        return { dispose: () => tabListeners.delete(listener) };
      },
    };
  }
  if (navigation) {
    apis['navigation/v1'] = {
      register: unused,
      navigate: unused,
      back: unused,
      forward: unused,
      history: () => ({ canGoBack: false, canGoForward: false }),
      current: () => match(),
      chain: () => [],
      subscribe: (listener: (match: unknown) => void): Disposable => {
        routeListeners.add(listener);
        return { dispose: () => routeListeners.delete(listener) };
      },
    };
  }

  const idOf = (contract: unknown): string =>
    (contract as { readonly id?: string }).id ?? '';
  const services = {
    provide: () => ({ dispose: () => undefined }),
    use: (contract: unknown) => {
      const api = apis[idOf(contract)];
      if (api === undefined)
        throw new Error(`No provider for ${idOf(contract)}.`);
      return api;
    },
    whenAvailable: (
      contract: unknown,
      callback: (api: unknown, provider: unknown) => unknown,
    ): Disposable => {
      const api = apis[idOf(contract)];
      if (api === undefined) return { dispose: () => undefined };
      const cleanup = callback(api, { bundleId: 'layout', version: '3.0.2' });
      return {
        dispose: () => {
          if (typeof cleanup === 'function') (cleanup as () => void)();
        },
      };
    },
  } as unknown as Services;

  return {
    services,
    /** The listeners `layout.tabs/v1.subscribe` holds now. */
    tabListenerCount: (): number => tabListeners.size,
    setRoute: (threadId: string): void => {
      route = threadId;
    },
    setTab: (tab: typeof selectedTab): void => {
      selectedTab = tab;
    },
    /** Calls the tab and route listeners, as the layout does after a change. */
    notify: async (): Promise<void> => {
      for (const listener of [...routeListeners]) listener(match());
      for (const listener of [...tabListeners]) listener();
      await settle();
    },
  };
};

const mounted: ReactElementInstance[] = [];
let probe = 0;

afterEach(async () => {
  for (const element of mounted.splice(0)) element.remove();
  await settle();
});

/** Mounts the rows element for `threadId`, as the layout's `ElementHost` does. */
const mountRows = async (
  services: Services,
  store: TerminalStore,
  threadId: string,
): Promise<ReactElementInstance> => {
  const client: TerminalClient = {
    api: {} as TerminalClient['api'],
    watches: {} as TerminalClient['watches'],
    store,
    open: () => undefined,
  };
  const Rows = defineTerminalElements(client).rows;
  const name = `terminal-rows-probe-${probe++}`;
  // A subclass per mount: a constructor is registered under one name only.
  window.customElements.define(name, class extends Rows {} as never);
  const element = document.createElement(
    name,
  ) as unknown as ReactElementInstance;
  element.services = services;
  (element as unknown as { 'thread-id': string })['thread-id'] = threadId;
  document.body.append(element);
  mounted.push(element);
  await settle();
  return element;
};

const items = (element: HTMLElement): HTMLElement[] => [
  ...element.querySelectorAll<HTMLElement>(
    '[data-slot="sidebar-menu-sub-item"]',
  ),
];

/** The item of terminal `id` under `element`; fails unless there is one. */
const item = (element: HTMLElement, id: string): HTMLElement => {
  const found = items(element).filter((candidate) =>
    candidate.textContent?.includes(`command-${id}`),
  );
  assert.equal(
    found.length,
    1,
    `Expected one row for ${id}, found ${found.length}.`,
  );
  return found[0] as HTMLElement;
};

const isSelected = (row: HTMLElement): boolean =>
  row.classList.contains('bg-sidebar-accent');

const buttonOf = (row: HTMLElement): HTMLElement => {
  const button = row.querySelector<HTMLElement>(
    '[data-sidebar="menu-sub-button"]',
  );
  assert.ok(button, 'The row has no button.');
  return button;
};

/** Asserts A's two rows render and neither is selected. */
const assertNoneSelected = (element: HTMLElement, when: string): void => {
  assert.equal(
    items(element).length,
    2,
    `${when}: A's two rows do not render.`,
  );
  for (const id of ['t1', 't2']) {
    const row = item(element, id);
    assert.equal(isSelected(row), false, `${when}: ${id} is selected.`);
    assert.equal(
      buttonOf(row).hasAttribute('aria-current'),
      false,
      `${when}: ${id} is current.`,
    );
  }
};

describe('the terminal tab id', () => {
  test('terminalIdOfTab is the inverse of terminalTabId', () => {
    const { terminalIdOfTab, terminalTabId } = tabModule;
    assert.equal(
      typeof terminalIdOfTab,
      'function',
      'tab.ts exports no terminalIdOfTab.',
    );
    assert.equal(terminalIdOfTab('terminal:t1'), 't1');
    assert.equal(terminalIdOfTab(terminalTabId('term_vitest')), 'term_vitest');
  });

  test('terminalIdOfTab answers undefined for another tab, no tab, or an empty terminal id', () => {
    const { terminalIdOfTab } = tabModule;
    assert.equal(
      typeof terminalIdOfTab,
      'function',
      'tab.ts exports no terminalIdOfTab.',
    );
    assert.equal(terminalIdOfTab('file:a.ts'), undefined);
    assert.equal(terminalIdOfTab(undefined), undefined);
    assert.equal(terminalIdOfTab('terminal:'), undefined);
  });
});

describe('T-5.6b: the selected terminal row follows the route and the selected tab', () => {
  test("route A with t1's tab selected: t1 is selected and current, t2 is not", async () => {
    const { store } = fakeStore();
    const peers = fakeServices();
    peers.setTab({ id: 'terminal:t1' });
    const element = await mountRows(peers.services, store, THREAD_A);

    assert.equal(items(element).length, 2, "A's two rows do not render.");
    const t1 = item(element, 't1');
    assert.ok(isSelected(t1), 't1 is not selected.');
    assert.equal(buttonOf(t1).getAttribute('aria-current'), 'true');
    const t2 = item(element, 't2');
    assert.equal(isSelected(t2), false, 't2 is selected.');
    assert.equal(buttonOf(t2).hasAttribute('aria-current'), false);
  });

  test('the route moving to B clears the selection, and moving back to A restores it', async () => {
    const { store } = fakeStore();
    const peers = fakeServices();
    peers.setTab({ id: 'terminal:t1' });
    const element = await mountRows(peers.services, store, THREAD_A);

    peers.setRoute(THREAD_B);
    await peers.notify();
    assertNoneSelected(element, 'route B');

    peers.setRoute(THREAD_A);
    await peers.notify();
    assert.ok(
      isSelected(item(element, 't1')),
      't1 is not selected again on route A.',
    );
  });

  test('route A with a file tab, an empty terminal tab or no tab selects no row', async () => {
    const { store } = fakeStore();
    const peers = fakeServices();
    const element = await mountRows(peers.services, store, THREAD_A);
    for (const tab of [{ id: 'file:a.ts' }, { id: 'terminal:' }, undefined]) {
      peers.setTab(tab);
      await peers.notify();
      assertNoneSelected(element, `tab ${tab?.id ?? 'none'}`);
    }
  });

  test('without layout.tabs/v1, or without navigation/v1, no row is selected', async () => {
    for (const missing of [{ tabs: false }, { navigation: false }] as const) {
      const { store } = fakeStore();
      const peers = fakeServices(missing);
      peers.setTab({ id: 'terminal:t1' });
      const element = await mountRows(peers.services, store, THREAD_A);
      assertNoneSelected(element, JSON.stringify(missing));
    }
  });

  test('a Thread subscribes to the tabs only while it has terminals', async () => {
    const fake = fakeStore();
    const peers = fakeServices();
    peers.setRoute(THREAD_C);
    const element = await mountRows(peers.services, fake.store, THREAD_C);
    assert.equal(
      items(element).length,
      0,
      'C renders a row without terminals.',
    );
    assert.equal(
      peers.tabListenerCount(),
      0,
      'C subscribes to the tabs without terminals.',
    );

    fake.set([...fake.list(), terminal('t4', THREAD_C)]);
    await settle();
    assert.equal(items(element).length, 1, "C does not render t4's row.");
    assert.equal(
      peers.tabListenerCount(),
      1,
      'C does not subscribe once it has a terminal.',
    );

    fake.set(fake.list().filter((candidate) => candidate.id !== 't4'));
    await settle();
    assert.equal(items(element).length, 0, "C still renders t4's row.");
    assert.equal(
      peers.tabListenerCount(),
      0,
      'C keeps its subscription without terminals.',
    );
  });
});
