// layout.tabs/v2 as another bundle calls it: tabs belong to the active owner
// (the route's Thread, else the selected Project), an open id only focuses,
// closing disposes the element, and without an owner opening is refused.
// Bundle isolation 4a (T4.3, T4.4): the owner is named through `setOwner`,
// and `close` and `retitle` can reach every owner. Change 6: the layout's
// contracts no longer state `layout.tabs/v1` or `layout.panel/v2`.

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { ContractError, isContractError } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';

import { tabOwnerOf } from '../src/client/domain/route-selection.js';
import { emptyTabs } from '../src/client/domain/workspace-tabs.js';
import { createLayoutTabs } from '../src/client/services/layout-tabs.js';
import { workspaceTabsStore } from '../src/client/stores/workspace-tabs.js';
import * as contracts from '../src/contracts/index.js';

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
  workspaceTabsStore.getState().setOwner(initialOwner);
  const harness = createTestServices({
    bundle: { id: 'probe' },
    provide: [createLayoutTabs({ ui })],
  });
  const v2 = harness.services.use(contracts.LayoutTabsV2);
  return {
    ui,
    tabs: v2,
    v2,
    setOwner: (next: string | undefined) => {
      workspaceTabsStore.getState().setOwner(next);
    },
    tabsOf: (key: string) =>
      workspaceTabsStore.getState().threads[key] ?? emptyTabs,
    titleOf: (key: string, id: string) => {
      const tab = (
        workspaceTabsStore.getState().threads[key] ?? emptyTabs
      ).items.find((item) => item.id === id);
      return tab?.kind === 'element' ? tab.title : undefined;
    },
    dispose: harness.dispose,
  };
};

beforeEach(() => {
  workspaceTabsStore.setState({ threads: {} });
});

describe('layout.tabs/v2 open, focus and close', () => {
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

describe('layout.tabs/v2', () => {
  test('setOwner switches the set of tabs current answers from (T4.3)', async () => {
    const { v2, dispose } = setup(undefined);

    v2.setOwner({ owner: 'a' });
    await v2.open({ id: 'x', title: 'X', tag: 'x-view' });
    v2.setOwner({ owner: 'b' });
    const inB = v2.current();
    v2.setOwner({ owner: 'a' });

    assert.equal(inB, undefined);
    assert.equal(v2.current()?.id, 'x');
    await dispose();
  });

  test('with no owner set, opening is refused as unavailable (T4.3)', async () => {
    const { ui, v2, dispose } = setup('a');

    v2.setOwner({});

    await assert.rejects(
      v2.open({ id: 'x', title: 'X', tag: 'x-view' }),
      (error: unknown) =>
        error instanceof ContractError &&
        error.code === 'unavailable' &&
        error.message === 'No thread or project is selected.',
    );
    assert.equal(ui.created.length, 0);
    await dispose();
  });

  test('setting the current owner again notifies no subscriber (T4.3)', async () => {
    const { v2, dispose } = setup(undefined);
    v2.setOwner({ owner: 'a' });
    let heard = 0;
    const subscription = v2.subscribe(() => {
      heard += 1;
    });

    v2.setOwner({ owner: 'a' });

    assert.equal(heard, 0);
    subscription.dispose();
    await dispose();
  });

  test('a request carrying the v1 icon is refused as invalid input (T4.5)', async () => {
    const { ui, v2, dispose } = setup('a');

    await assert.rejects(
      async () =>
        v2.open({
          id: 'x',
          title: 'X',
          tag: 'x-view',
          icon: 'thread',
        } as unknown as Parameters<typeof v2.open>[0]),
      (error: unknown) =>
        isContractError(error) && error.code === 'invalid_input',
    );
    assert.equal(ui.created.length, 0);
    await dispose();
  });
});

describe('layout.tabs/v2 across owners (T4.4)', () => {
  const twoOwners = async () => {
    const harness = setup(undefined);
    harness.v2.setOwner({ owner: 'b' });
    await harness.v2.open({ id: 't', title: 'T', tag: 'x-view' });
    harness.v2.setOwner({ owner: 'a' });
    await harness.v2.open({ id: 't', title: 'T', tag: 'x-view' });
    return harness;
  };

  test('retitle with everyOwner retitles the tab in every owner', async () => {
    const { v2, titleOf, dispose } = await twoOwners();

    await v2.retitle({ id: 't', title: 'N', everyOwner: true });

    assert.equal(titleOf('a', 't'), 'N');
    assert.equal(titleOf('b', 't'), 'N');
    await dispose();
  });

  test('close with everyOwner closes the tab in every owner and disposes both elements', async () => {
    const { ui, v2, tabsOf, dispose } = await twoOwners();

    await v2.close({ id: 't', everyOwner: true });

    assert.deepEqual(tabsOf('a').items, []);
    assert.deepEqual(tabsOf('b').items, []);
    assert.equal(ui.disposed.length, 2);
    assert.ok(ui.created.every((element) => ui.disposed.includes(element)));
    await dispose();
  });

  test('with threadId, only that owner tab changes', async () => {
    const { ui, v2, tabsOf, titleOf, dispose } = await twoOwners();

    await v2.retitle({ id: 't', title: 'N', threadId: 'b' });
    assert.equal(titleOf('a', 't'), 'T');
    assert.equal(titleOf('b', 't'), 'N');

    await v2.close({ id: 't', threadId: 'b' });
    assert.deepEqual(
      tabsOf('a').items.map((tab) => tab.id),
      ['t'],
    );
    assert.deepEqual(tabsOf('b').items, []);
    assert.deepEqual(ui.disposed, [ui.created[0]]);
    await dispose();
  });

  test('with neither, only the active owner tab changes', async () => {
    const { ui, v2, tabsOf, titleOf, dispose } = await twoOwners();

    await v2.retitle({ id: 't', title: 'N' });
    assert.equal(titleOf('a', 't'), 'N');
    assert.equal(titleOf('b', 't'), 'T');

    await v2.close({ id: 't' });
    assert.deepEqual(tabsOf('a').items, []);
    assert.deepEqual(
      tabsOf('b').items.map((tab) => tab.id),
      ['t'],
    );
    assert.deepEqual(ui.disposed, [ui.created[1]]);
    await dispose();
  });
});

describe('the layout contracts (bundle isolation 4a, change 6)', () => {
  test('state neither layout.tabs/v1 nor layout.panel/v2', () => {
    const removed = [
      'LayoutTabsV1',
      'LegacyLayoutTabs',
      'legacyTabRequestSchema',
      'legacyLayoutTabsMethods',
      'LayoutPanelV2',
    ];

    assert.deepEqual(
      removed.filter((name) => name in contracts),
      [],
      'The layout contracts still export the old ids.',
    );
    assert.deepEqual(
      Object.values(contracts)
        .map((value) =>
          typeof value === 'object' && value !== null && 'id' in value
            ? (value as { id: unknown }).id
            : undefined,
        )
        .filter((id) => id === 'layout.tabs/v1' || id === 'layout.panel/v2'),
      [],
      'A contract reference still names layout.tabs/v1 or layout.panel/v2.',
    );
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
