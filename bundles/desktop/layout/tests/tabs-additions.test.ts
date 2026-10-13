// layout.tabs/v1@1.1.0 (R-9.3): a tab's trigger carries the icon, aria label
// and tooltip it was opened with; a tab is closed in a named owner without a
// selection; `current` is the active owner's selected tab with the props it
// was opened with; and subscribers hear tab and owner changes. A terminal
// element tab does not keep the sandbox refresh going, as a built-in
// terminal tab never did.

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { createTestServices } from 'bundle/testing';

import {
  emptyTabs,
  readsSandbox,
} from '../src/client/domain/workspace-tabs.js';
import { createLayoutTabs } from '../src/client/services/layout-tabs.js';
import { workspaceTabsStore } from '../src/client/stores/workspace-tabs.js';
import { LayoutTabsV1 } from '../src/contracts/index.js';

const ui = {
  disposed: [] as object[],
  create: (tag: string, props?: Readonly<Record<string, unknown>>) => ({
    tag,
    props,
  }),
  dispose(element: object) {
    this.disposed.push(element);
  },
};

const setup = (initialOwner: string | undefined) => {
  let owner = initialOwner;
  const ownerListeners = new Set<() => void>();
  const harness = createTestServices({
    bundle: { id: 'files' },
    provide: [
      createLayoutTabs({
        ui,
        owner: () => owner,
        watchOwner: (listener) => {
          ownerListeners.add(listener);
          return () => ownerListeners.delete(listener);
        },
      }),
    ],
  });
  return {
    tabs: harness.services.use(LayoutTabsV1),
    setOwner: (next: string | undefined) => {
      owner = next;
      for (const listener of ownerListeners) listener();
    },
    tabsOf: (key: string) =>
      workspaceTabsStore.getState().threads[key] ?? emptyTabs,
    dispose: harness.dispose,
  };
};

beforeEach(() => {
  workspaceTabsStore.setState({ threads: {} });
  ui.disposed = [];
});

describe('layout.tabs/v1@1.1.0', () => {
  test('opens and disposes a thread tab through the public contract', async () => {
    const { tabs, tabsOf, dispose } = setup('parent');
    await tabs.open({
      id: 'thread:child',
      title: 'Child',
      tag: 'chat-thread-panel',
      icon: 'thread',
      props: { projectId: 'project', threadId: 'child' },
    });
    const tab = tabsOf('parent').items[0];
    assert.equal(tab?.kind === 'element' && tab.icon, 'thread');
    await tabs.close({ id: 'thread:child', threadId: 'parent' });
    assert.equal(tabsOf('parent').items.length, 0);
    assert.deepEqual(ui.disposed, tab?.kind === 'element' ? [tab.element] : []);
    await dispose();
  });

  test('the tab keeps the icon, aria label, tooltip and props it was opened with', async () => {
    const { tabs, tabsOf, dispose } = setup('t1');

    await tabs.open({
      id: JSON.stringify(['diff', 'p1', '/workspace', 'src/a.ts']),
      title: 'a.ts',
      tag: 'git-file-diff',
      props: { projectId: 'p1', repository: '/workspace', path: 'src/a.ts' },
      icon: 'file-diff',
      ariaLabel: 'a.ts changes',
      tooltip: 'src/a.ts',
    });

    const tab = tabsOf('t1').items[0];
    assert.equal(tab?.kind, 'element');
    if (tab?.kind !== 'element') return;
    assert.equal(tab.icon, 'file-diff');
    assert.equal(tab.ariaLabel, 'a.ts changes');
    assert.equal(tab.tooltip, 'src/a.ts');
    assert.deepEqual(tab.props, {
      projectId: 'p1',
      repository: '/workspace',
      path: 'src/a.ts',
    });
    await dispose();
  });

  test('a tab closes in the owner it names, even with nothing selected', async () => {
    const { tabs, setOwner, tabsOf, dispose } = setup('t1');
    await tabs.open({
      id: 'terminal:x',
      title: 'npm test',
      tag: 'terminal-view',
      icon: 'terminal',
    });
    setOwner(undefined);

    await tabs.close({ id: 'terminal:x', threadId: 't1' });

    assert.deepEqual(tabsOf('t1').items, []);
    assert.equal(ui.disposed.length, 1);
    await dispose();
  });

  test('current is the selected tab of the active owner', async () => {
    const { tabs, setOwner, dispose } = setup('t1');
    assert.equal(tabs.current(), undefined);

    await tabs.open({
      id: 'file:src/a.ts',
      title: 'a.ts',
      tag: 'files-file-view',
      props: { projectId: 'p1', path: 'src/a.ts' },
      icon: 'file',
    });
    await tabs.open({ id: 'plain', title: 'Plain', tag: 'x-plain' });
    assert.deepEqual(tabs.current(), { id: 'plain' });

    await tabs.focus({ id: 'file:src/a.ts' });
    assert.deepEqual(tabs.current(), {
      id: 'file:src/a.ts',
      props: { projectId: 'p1', path: 'src/a.ts' },
    });

    setOwner('project:p1');
    assert.equal(tabs.current(), undefined);
    await dispose();
  });

  test('subscribers hear tab and owner changes until they dispose', async () => {
    const { tabs, setOwner, dispose } = setup('t1');
    let heard = 0;
    const subscription = tabs.subscribe(() => {
      heard += 1;
    });

    await tabs.open({ id: 'a', title: 'A', tag: 'x-a' });
    const afterOpen = heard;
    setOwner('t2');
    const afterOwner = heard;
    subscription.dispose();
    await tabs.open({ id: 'b', title: 'B', tag: 'x-b' });
    setOwner('t1');

    assert.ok(afterOpen > 0);
    assert.ok(afterOwner > afterOpen);
    assert.equal(heard, afterOwner);
    await dispose();
  });
});

describe('sandbox-reading tabs', () => {
  test('file, diff and other element tabs read the sandbox; terminals and threads do not', () => {
    assert.equal(
      readsSandbox({ id: 'f', kind: 'file', path: 'a', projectId: 'p' }),
      true,
    );
    assert.equal(
      readsSandbox({ id: 't', kind: 'terminal', terminalId: 'x' }),
      false,
    );
    const element = {
      id: 'e',
      kind: 'element' as const,
      title: 'E',
      element: {},
    };
    assert.equal(readsSandbox(element), true);
    assert.equal(readsSandbox({ ...element, icon: 'file-diff' }), true);
    assert.equal(readsSandbox({ ...element, icon: 'terminal' }), false);
    assert.equal(readsSandbox({ ...element, icon: 'thread' }), false);
  });
});
