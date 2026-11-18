// The viewer tab menu (S15, T-4.4.9), as the reader meets it in the frame.
// The ◆ menu entries of the navigation (§4.4 A1–A4) moved with it to the
// `workspace` bundle in step 4(c)
// (`bundles/desktop/workspace/tests/client/menus.test.ts`). Of the list below
// this file keeps the first item:
// - a viewer tab's context menu shows the opener's non-destructive entries
//   (`layout.tabs/v2` `menu`), a separator, "Close tab", then the
//   opener's destructive entries behind a separator; a tab opened without
//   `menu` shows only "Close tab"; an entry's `icon` leads it;
// - A1 "Open in new tab" on a main Thread row ("Open in viewer" on a
//   sub-thread or agent Thread row) opens the Thread in a viewer tab and
//   selects it, while the conversation column keeps its Thread;
// - A2 "Open project" leads a Dashboard row's menu and opens the Project;
// - A3 "New thread" on a Project tab selects the Project and starts a draft;
// - A4 "Color" on a Project tab colors the Project's tab and Dashboard row;
// - the groups of each menu follow Figma `layout/ContextMenu` (29:5570): Open
//   → Create → Edit → Copy → Close → Destructive, destructive last behind a
//   separator, and entries that would do nothing are hidden, not disabled.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { createElement } from 'react';

import type { LayoutFixture } from '../../stories/support/layout-host.js';
import { navigationStandIns } from '../../stories/support/tabs.js';
import {
  type RenderedShell,
  renderShell,
  settle,
} from './support/render-shell.js';

const projectId = '6f1c2a3e-4b5d-4e6f-8a7b-1c2d3e4f5a6b';
const plan = { id: '3d1e5f7a-9b2c-4d6e-8f0a-1b3c5d7e9f2a' };

const VIEWER_TABS = '[aria-label="Files, changes, terminals and threads"]';
const planPath = `/projects/${projectId}/threads/${plan.id}`;

let rendered: RenderedShell | undefined;

afterEach(() => {
  rendered?.cleanup();
  rendered = undefined;
  document.body.replaceChildren();
});

/** The frame on the plan Thread's route, with the navigation's stand-ins and its tab owner. */
const render = async (fixture: LayoutFixture): Promise<RenderedShell> => {
  rendered = await renderShell({
    owner: plan.id,
    regions: navigationStandIns,
    ...fixture,
  });
  return rendered;
};

const normalized = (text: string | null | undefined): string =>
  (text ?? '').replace(/\s+/g, ' ').trim();

/** Right-clicks `target`, as a reader opens its context menu. */
const openMenu = async (target: Element): Promise<void> => {
  target.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    }),
  );
  await settle();
};

/** The open menu's entries, in order. */
const entries = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(
    '[data-slot="context-menu-content"] [role="menuitem"]',
  ),
];

const labels = (): string[] =>
  entries().map((entry) => normalized(entry.textContent));

/**
 * The open menu's entries split into the groups its separators draw, as
 * labels; the submenus it opens are not part of it.
 */
const groups = (): string[][] => {
  const content = document.querySelector('[data-slot="context-menu-content"]');
  assert.ok(content, 'No open context menu.');
  const result: string[][] = [[]];
  for (const node of content.querySelectorAll<HTMLElement>(
    '[role="menuitem"], [data-slot="context-menu-separator"]',
  )) {
    if (node.dataset.slot === 'context-menu-separator') result.push([]);
    else result.at(-1)?.push(normalized(node.textContent));
  }
  return result.filter((group) => group.length > 0);
};

const entry = (label: string): HTMLElement => {
  const found = entries().find(
    (item) => normalized(item.textContent) === label,
  );
  assert.ok(
    found,
    `No entry "${label}"; the menu holds ${labels().join(' | ')}`,
  );
  return found;
};

const pick = async (label: string): Promise<void> => {
  const entry = entries().find(
    (item) => normalized(item.textContent) === label,
  );
  assert.ok(
    entry,
    `No entry "${label}"; the menu holds ${labels().join(' | ')}`,
  );
  entry.click();
  await settle();
};

const viewerTab = (id: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(
    `${VIEWER_TABS} [data-tab-id="${id}"]`,
  );
  assert.ok(found, `No viewer tab ${id}.`);
  return found;
};

const viewerTabIds = (): string[] =>
  [
    ...document.querySelectorAll<HTMLElement>(`${VIEWER_TABS} [data-tab-id]`),
  ].map((tab) => tab.dataset.tabId ?? '');

const tabsService = async () => {
  const { layoutServices } = await import(
    '../../src/client/services/layout-services.js'
  );
  const { LayoutTabsV2 } = await import('../../src/contracts/index.js');
  return layoutServices().use(LayoutTabsV2);
};

describe('the viewer tab menu', () => {
  test("shows the opener's entries, then Close tab, then its destructive entries last", async () => {
    await render({ path: planPath });
    const ran: string[] = [];
    const tabs = await tabsService();
    await tabs.open({
      id: 'terminal:1',
      title: 'npm test',
      tag: 'terminal-view',
      menu: [
        {
          id: 'kill',
          label: 'Kill terminal',
          destructive: true,
          run: () => ran.push('kill'),
        },
        { id: 'copy', label: 'Copy command', run: () => ran.push('copy') },
      ],
    });
    await settle();

    await openMenu(viewerTab('terminal:1'));

    assert.deepEqual(groups(), [
      ['Copy command'],
      ['Close tab'],
      ['Kill terminal'],
    ]);
    assert.equal(entry('Kill terminal').dataset.variant, 'destructive');
    assert.notEqual(entry('Close tab').dataset.variant, 'destructive');
    await pick('Kill terminal');
    assert.deepEqual(ran, ['kill']);
  });

  test('a terminal tab shows Close tab, then Kill terminal behind a separator', async () => {
    await render({ path: planPath });
    const tabs = await tabsService();
    await tabs.open({
      id: 'terminal:1',
      title: 'npm test',
      tag: 'terminal-view',
      menu: [
        {
          id: 'kill',
          label: 'Kill terminal',
          destructive: true,
          run: () => undefined,
        },
      ],
    });
    await settle();

    await openMenu(viewerTab('terminal:1'));

    assert.deepEqual(groups(), [['Close tab'], ['Kill terminal']]);
  });

  test("an entry's icon leads it; an entry without one aligns with the labels", async () => {
    await render({ path: planPath });
    const tabs = await tabsService();
    await tabs.open({
      id: 'file:a',
      title: 'a.ts',
      tag: 'file-view',
      menu: [
        {
          id: 'reveal',
          label: 'Reveal in Files',
          icon: createElement('svg', { 'data-probe': 'reveal' }),
          run: () => undefined,
        },
        { id: 'copy', label: 'Copy path', run: () => undefined },
      ],
    });
    await settle();

    await openMenu(viewerTab('file:a'));

    const reveal = entry('Reveal in Files');
    assert.ok(
      reveal.querySelector('svg[data-probe="reveal"]'),
      'Reveal in Files does not show its icon.',
    );
    assert.equal(
      reveal.firstElementChild?.getAttribute('data-probe'),
      'reveal',
    );
    assert.ok(
      entry('Copy path').hasAttribute('data-inset'),
      'Copy path, without an icon, is not inset.',
    );
  });

  test('a tab opened without menu shows only Close tab, which closes it', async () => {
    await render({
      path: planPath,
      tabs: {
        [plan.id]: [
          { id: 'file:a', title: 'a.ts', tag: 'file-view' },
          { id: 'file:b', title: 'b.ts', tag: 'file-view' },
        ],
      },
    });

    await openMenu(viewerTab('file:a'));

    assert.deepEqual(labels(), ['Close tab']);
    assert.equal(
      document.querySelector(
        '[data-slot="context-menu-content"] [data-slot="context-menu-separator"]',
      ),
      null,
    );
    await pick('Close tab');
    assert.deepEqual(viewerTabIds(), ['file:b']);
  });
});
