// layout.tabs/v2 (S15, T-4.4.7 layout part, T-4.4.9): a tab carries the
// menu entries its opener states, and `retitle` changes an open tab's title,
// since `open` with an open id only selects it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, test } from 'node:test';

import { isContractError } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import { createElement, type ReactElement } from 'react';

import { emptyTabs } from '../src/client/domain/workspace-tabs.js';
import { createLayoutTabs } from '../src/client/services/layout-tabs.js';
import { workspaceTabsStore } from '../src/client/stores/workspace-tabs.js';
import { LayoutTabsV2 } from '../src/contracts/index.js';

const ui = {
  create: (tag: string): object => ({ tag }),
  dispose: (): void => undefined,
};

const setup = (owner: string | undefined = 'thread-1') => {
  workspaceTabsStore.getState().setOwner(owner);
  const harness = createTestServices({
    bundle: { id: 'probe' },
    provide: [createLayoutTabs({ ui })],
  });
  return {
    tabs: harness.services.use(LayoutTabsV2),
    tabOf: (key: string, id: string) =>
      (workspaceTabsStore.getState().threads[key] ?? emptyTabs).items.find(
        (item) => item.id === id,
      ),
    dispose: harness.dispose,
  };
};

const invalidInput = (error: unknown): boolean =>
  isContractError(error) && error.code === 'invalid_input';

const titleOf = (tab: ReturnType<ReturnType<typeof setup>['tabOf']>) =>
  tab?.kind === 'element' ? tab.title : undefined;

beforeEach(() => {
  workspaceTabsStore.setState({ threads: {} });
});

describe('layout.tabs/v2 menu', () => {
  test('a tab keeps the menu entries it was opened with, in order', async () => {
    const { tabs, tabOf, dispose } = setup();
    const ran: string[] = [];

    await tabs.open({
      id: 'terminal:1',
      title: 'npm test',
      tag: 'terminal-view',
      menu: [
        { id: 'rename', label: 'Rename', run: () => ran.push('rename') },
        {
          id: 'kill',
          label: 'Kill terminal',
          destructive: true,
          run: () => ran.push('kill'),
        },
      ],
    });

    const tab = tabOf('thread-1', 'terminal:1');
    const menu = tab?.kind === 'element' ? (tab.menu ?? []) : [];
    assert.deepEqual(
      menu.map(({ label, destructive }) => ({ label, destructive })),
      [
        { label: 'Rename', destructive: undefined },
        { label: 'Kill terminal', destructive: true },
      ],
    );
    for (const item of menu) item.run();
    assert.deepEqual(ran, ['rename', 'kill']);
    await dispose();
  });

  test('a menu entry whose run is not a function fails invalid_input', async () => {
    const { tabs, tabOf, dispose } = setup();

    await assert.rejects(
      async () =>
        tabs.open({
          id: 'file:a',
          title: 'a.ts',
          tag: 'file-view',
          menu: [
            {
              id: 'reveal',
              label: 'Reveal in Files',
              run: 'reveal' as unknown as () => void,
            },
          ],
        }),
      invalidInput,
    );
    assert.equal(tabOf('thread-1', 'file:a'), undefined);
    await dispose();
  });

  test('a menu entry keeps the React element it gives as its icon', async () => {
    const { tabs, tabOf, dispose } = setup();
    const icon = createElement('svg', { 'data-probe': 'reveal' });

    await tabs.open({
      id: 'file:a',
      title: 'a.ts',
      tag: 'file-view',
      menu: [
        { id: 'reveal', label: 'Reveal in Files', icon, run: () => undefined },
      ],
    });

    const tab = tabOf('thread-1', 'file:a');
    const menu = tab?.kind === 'element' ? (tab.menu ?? []) : [];
    assert.equal(menu[0]?.icon, icon);
    await dispose();
  });

  for (const [name, icon] of [
    ['an icon name', 'folder-open'],
    ['a component', () => null],
    ['a plain object', { type: 'svg', props: {} }],
  ] as const) {
    test(`a menu entry whose icon is ${name} fails invalid_input`, async () => {
      const { tabs, tabOf, dispose } = setup();

      await assert.rejects(
        async () =>
          tabs.open({
            id: 'file:a',
            title: 'a.ts',
            tag: 'file-view',
            menu: [
              {
                id: 'reveal',
                label: 'Reveal in Files',
                icon: icon as unknown as ReactElement,
                run: () => undefined,
              },
            ],
          }),
        invalidInput,
      );
      assert.equal(tabOf('thread-1', 'file:a'), undefined);
      await dispose();
    });
  }
});

describe('layout.tabs/v2 retitle', () => {
  test('changes the title of an open tab of the active owner', async () => {
    const { tabs, tabOf, dispose } = setup();
    await tabs.open({ id: 'terminal:1', title: 'npm test', tag: 'x-term' });

    await tabs.retitle({ id: 'terminal:1', title: 'Tests' });

    assert.equal(titleOf(tabOf('thread-1', 'terminal:1')), 'Tests');
    await dispose();
  });

  test('changes the tab of the owner threadId names, without a selection', async () => {
    workspaceTabsStore.getState().open('thread-2', {
      kind: 'element',
      id: 'terminal:1',
      tag: 'terminal-rows',
      title: 'npm test',
      element: {},
    });
    const { tabs, tabOf, dispose } = setup(undefined);

    await tabs.retitle({
      id: 'terminal:1',
      title: 'Tests',
      threadId: 'thread-2',
    });

    assert.equal(titleOf(tabOf('thread-2', 'terminal:1')), 'Tests');
    await dispose();
  });

  test('without such a tab it does nothing', async () => {
    const { tabs, dispose } = setup();
    await tabs.open({ id: 'a', title: 'A', tag: 'x-a' });
    const before = workspaceTabsStore.getState().threads;

    await tabs.retitle({ id: 'missing', title: 'B' });

    assert.equal(workspaceTabsStore.getState().threads, before);
    await dispose();
  });

  test('an input property beyond id, title and threadId fails invalid_input', async () => {
    const { tabs, tabOf, dispose } = setup();
    await tabs.open({ id: 'a', title: 'A', tag: 'x-a' });

    await assert.rejects(
      async () =>
        tabs.retitle({ id: 'a', title: 'B', color: 'red' } as unknown as {
          id: string;
          title: string;
        }),
      invalidInput,
    );
    assert.equal(titleOf(tabOf('thread-1', 'a')), 'A');
    await dispose();
  });
});

describe('the layout manifest', () => {
  test('provides layout.tabs/v2@2.0.0 and layout.panel/v3@3.0.0 (neither layout.tabs/v1 nor layout.panel/v1 or v2), layout.conversation/v1@1.0.0, layout.sidebar/v1@1.1.0 and layout.stack/v2@2.0.0 (not v1) at version 4.2.0, requires neither runtime/v1 nor runtime.threads/v1, and takes runtime.records/v1 as optional (T-1.10, T-2.11, T-3.8, T-5.7, conversation-footer T-4, thread-archive, bundle isolation AC3.1, S12, step 4(a) changes 6 and 7)', () => {
    const manifest = JSON.parse(
      readFileSync('bundles/desktop/layout/manifest.json', 'utf8'),
    ) as {
      version: string;
      provides: string[];
      requires: string[];
      optional: string[];
    };

    assert.equal(manifest.version, '4.2.0');
    assert.ok(
      !manifest.requires.some(
        (entry) =>
          entry.startsWith('runtime/v1@') ||
          entry.startsWith('runtime.threads/v1@'),
      ),
      'The layout still requires runtime/v1 or runtime.threads/v1.',
    );
    assert.deepEqual(manifest.optional, [
      'core.open-settings/v1',
      'runtime.records/v1',
    ]);
    assert.ok(manifest.provides.includes('layout.stack/v2@2.0.0'));
    assert.ok(
      !manifest.provides.some((entry) => entry.startsWith('layout.stack/v1@')),
      'The layout still provides layout.stack/v1.',
    );
    assert.ok(
      !manifest.provides.some((entry) => entry.startsWith('layout.tabs/v1@')),
      'The layout still provides layout.tabs/v1.',
    );
    assert.ok(manifest.provides.includes('layout.sidebar/v1@1.1.0'));
    assert.ok(!manifest.provides.includes('layout.sidebar/v1@1.0.0'));
    assert.ok(
      !manifest.provides.some((entry) => entry.startsWith('layout.panel/v2@')),
      'The layout still provides layout.panel/v2.',
    );
    assert.ok(!manifest.provides.includes('layout.panel/v1@1.0.0'));
    assert.ok(manifest.provides.includes('layout.tabs/v2@2.0.0'));
    assert.ok(manifest.provides.includes('layout.panel/v3@3.0.0'));
    assert.ok(manifest.provides.includes('layout.conversation/v1@1.0.0'));
  });
});
