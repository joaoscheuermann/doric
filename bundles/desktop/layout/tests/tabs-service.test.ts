// layout.tabs/v1 as another bundle calls it: tabs belong to the active owner
// (the route's Thread, else the selected Project), an open id only focuses,
// closing disposes the element, and without an owner opening is refused.

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { ContractError } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';

import { tabOwnerOf } from '../src/client/domain/route-selection.js';
import { emptyTabs } from '../src/client/domain/workspace-tabs.js';
import { createLayoutTabs } from '../src/client/services/layout-tabs.js';
import { workspaceTabsStore } from '../src/client/stores/workspace-tabs.js';
import { LayoutTabsV1 } from '../src/contracts/index.js';

class FakeUi {
  readonly created: { tag: string; props?: unknown }[] = [];
  readonly disposed: object[] = [];

  create(tag: string, props?: Readonly<Record<string, unknown>>): object {
    const element = { tag, props };
    this.created.push(element);
    return element;
  }

  dispose(element: object): void {
    this.disposed.push(element);
  }
}

const setup = (initialOwner: string | undefined) => {
  const ui = new FakeUi();
  let owner = initialOwner;
  const harness = createTestServices({
    bundle: { id: 'probe' },
    provide: [createLayoutTabs({ ui, owner: () => owner })],
  });
  return {
    ui,
    tabs: harness.services.use(LayoutTabsV1),
    setOwner: (next: string | undefined) => {
      owner = next;
    },
    tabsOf: (key: string) =>
      workspaceTabsStore.getState().threads[key] ?? emptyTabs,
    dispose: harness.dispose,
  };
};

beforeEach(() => {
  workspaceTabsStore.setState({ threads: {} });
});

describe('layout.tabs/v1', () => {
  test('opens an element tab in the owner tabs and selects it', async () => {
    const { ui, tabs, tabsOf, dispose } = setup('thread-1');

    await tabs.open({
      id: 'web',
      title: 'Preview',
      tag: 'web-view',
      props: { url: 'https://example.test' },
    });

    const state = tabsOf('thread-1');
    assert.equal(state.selected, 'web');
    const tab = state.items.find((item) => item.id === 'web');
    assert.equal(tab?.kind, 'element');
    assert.equal(tab?.kind === 'element' ? tab.title : undefined, 'Preview');
    assert.deepEqual(ui.created, [
      { tag: 'web-view', props: { url: 'https://example.test' } },
    ]);
    await dispose();
  });

  test('an open id only focuses the tab', async () => {
    const { ui, tabs, tabsOf, dispose } = setup('thread-1');
    await tabs.open({ id: 'a', title: 'A', tag: 'x-a' });
    await tabs.open({ id: 'b', title: 'B', tag: 'x-b' });

    await tabs.open({ id: 'a', title: 'A again', tag: 'x-a' });

    assert.equal(tabsOf('thread-1').selected, 'a');
    assert.equal(tabsOf('thread-1').items.length, 2);
    assert.equal(ui.created.length, 2);
    await dispose();
  });

  test('tabs stay with the owner that opened them', async () => {
    const { tabs, setOwner, tabsOf, dispose } = setup('thread-1');
    await tabs.open({ id: 'a', title: 'A', tag: 'x-a' });

    setOwner('project:project-1');
    await tabs.open({ id: 'b', title: 'B', tag: 'x-b' });

    assert.deepEqual(
      tabsOf('thread-1').items.map((tab) => tab.id),
      ['a'],
    );
    assert.deepEqual(
      tabsOf('project:project-1').items.map((tab) => tab.id),
      ['b'],
    );
    await dispose();
  });

  test('closing a tab disposes its element and selects the last remaining tab', async () => {
    const { ui, tabs, tabsOf, dispose } = setup('thread-1');
    await tabs.open({ id: 'a', title: 'A', tag: 'x-a' });
    await tabs.open({ id: 'b', title: 'B', tag: 'x-b' });

    await tabs.close({ id: 'b' });

    assert.deepEqual(ui.disposed, [ui.created[1]]);
    assert.deepEqual(
      tabsOf('thread-1').items.map((tab) => tab.id),
      ['a'],
    );
    assert.equal(tabsOf('thread-1').selected, 'a');
    await dispose();
  });

  test('focus selects an open tab and ignores an unknown one', async () => {
    const { tabs, tabsOf, dispose } = setup('thread-1');
    await tabs.open({ id: 'a', title: 'A', tag: 'x-a' });
    await tabs.open({ id: 'b', title: 'B', tag: 'x-b' });

    await tabs.focus({ id: 'a' });
    await tabs.focus({ id: 'missing' });

    assert.equal(tabsOf('thread-1').selected, 'a');
    await dispose();
  });

  test('focusing or reopening the selected tab notifies no subscriber', async () => {
    const { tabs, tabsOf, dispose } = setup('thread-1');
    await tabs.open({ id: 'a', title: 'A', tag: 'x-a' });
    let heard = 0;
    const subscription = tabs.subscribe(() => {
      heard += 1;
    });

    await tabs.focus({ id: 'a' });
    await tabs.open({ id: 'a', title: 'A', tag: 'x-a' });

    assert.equal(heard, 0);
    assert.equal(tabsOf('thread-1').selected, 'a');
    subscription.dispose();
    await dispose();
  });

  test('without a Thread or a Project, opening is refused as unavailable', async () => {
    const { ui, tabs, dispose } = setup(undefined);

    await assert.rejects(
      tabs.open({ id: 'a', title: 'A', tag: 'x-a' }),
      (error: unknown) =>
        error instanceof ContractError &&
        error.code === 'unavailable' &&
        error.message === 'No thread or project is selected.',
    );
    assert.equal(ui.created.length, 0);
    await dispose();
  });
});

describe('tab owner', () => {
  const threadRoute = {
    path: '/projects/p1/threads/t1',
    pattern: '/projects/:projectId/threads/:threadId',
    params: { projectId: 'p1', threadId: 't1' },
  };

  test("the route's Thread owns the tabs", () => {
    assert.equal(tabOwnerOf(threadRoute, 'p2'), 't1');
  });

  test('the Project route gives the Project ownership', () => {
    assert.equal(
      tabOwnerOf(
        {
          path: '/projects/p1',
          pattern: '/projects/:projectId',
          params: { projectId: 'p1' },
        },
        'p1',
      ),
      'project:p1',
    );
  });

  test('without either there is no owner', () => {
    assert.equal(
      tabOwnerOf({ path: '/', pattern: '/', params: {} }, undefined),
      undefined,
    );
  });
});
