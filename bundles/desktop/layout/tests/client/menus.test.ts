// The layout's ◆ menu entries and the viewer tab menu (§4.4 A1–A4, S15;
// T-4.4.1 for A1–A4, T-4.4.9), as the reader meets them in the workspace:
// - a viewer tab's context menu shows the opener's non-destructive entries
//   (`layout.tabs/v1@1.2.0` `menu`), a separator, "Close tab", then the
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

import { NavigationV1 } from 'bundle/contracts';
import { createElement } from 'react';

import type { Project, Thread } from '../../src/client/domain/workspace.js';
import type { LayoutFixture } from '../../stories/support/layout-host.js';
import {
  type RenderedWorkspace,
  renderWorkspace,
  settle,
} from './support/render-workspace.js';

const project: Project = {
  id: '6f1c2a3e-4b5d-4e6f-8a7b-1c2d3e4f5a6b',
  name: 'Checkout redesign',
  state: 'ready',
  configRevision: 1,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-09T10:00:00.000Z',
};

const docs: Project = {
  id: 'b7d4e2f1-8c3a-4d5e-9f6a-2b1c3d4e5f6a',
  name: 'Docs site',
  state: 'ready',
  configRevision: 1,
  createdAt: '2026-11-02T10:00:00.000Z',
  updatedAt: '2026-11-08T10:00:00.000Z',
};

const thread = (id: string, name: string, projectId = project.id): Thread => ({
  id,
  projectId,
  name,
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '2026-11-09T09:00:00.000Z',
  updatedAt: '2026-11-09T09:30:00.000Z',
});

const plan = thread(
  '3d1e5f7a-9b2c-4d6e-8f0a-1b3c5d7e9f2a',
  'Plan the checkout',
);
const audit = thread(
  '5a7c9e1b-3d5f-4b7d-9f1a-3c5e7a9b1d3f',
  'Accessibility audit',
);
const guide = thread(
  '9c1e3a5b-7d9f-4b1d-8f3a-5c7e9a1b3d5f',
  'Write the guide',
  docs.id,
);

const TAB_BAR = 'nav[aria-label="Workspace tabs"]';
const VIEWER_TABS = '[aria-label="Files, changes, terminals and threads"]';
const planPath = `/projects/${project.id}/threads/${plan.id}`;

let rendered: RenderedWorkspace | undefined;

afterEach(() => {
  rendered?.cleanup();
  rendered = undefined;
  document.body.replaceChildren();
});

const render = async (fixture: LayoutFixture): Promise<RenderedWorkspace> => {
  rendered = await renderWorkspace({
    projects: [project, docs],
    projectTabs: [project, docs],
    threads: [plan, audit, guide],
    ...fixture,
  });
  return rendered;
};

const normalized = (text: string | null | undefined): string =>
  (text ?? '').replace(/\s+/g, ' ').trim();

/** `/projects/<id>`, alone or followed by one of its Threads. */
const projectRoute = (target: Project): RegExp =>
  new RegExp(`^/projects/${target.id}(/threads/[^/]+)?$`);

const pathOf = (workspace: RenderedWorkspace): string | undefined =>
  workspace.services.use(NavigationV1).current()?.path;

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

const projectTab = (id: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(
    `${TAB_BAR} [data-tab-id="${id}"]`,
  );
  assert.ok(found, `No Project tab ${id}.`);
  return found;
};

const threadRow = (name: string): HTMLElement => {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="treeitem"]'),
  ].find((row) => normalized(row.textContent).startsWith(name));
  assert.ok(found, `No Thread row ${name}.`);
  return found;
};

const tabsService = async () => {
  const { layoutServices } = await import(
    '../../src/client/services/layout-services.js'
  );
  const { LayoutTabsV1 } = await import('../../src/contracts/index.js');
  return layoutServices().use(LayoutTabsV1);
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
          { id: 'file:a', title: 'a.ts', tag: 'file-view', icon: 'file' },
          { id: 'file:b', title: 'b.ts', tag: 'file-view', icon: 'file' },
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

describe('the Thread menu', () => {
  const subThread: Thread = {
    ...thread('7e9f1a3b-5c7d-4e9f-a1b3-c5d7e9f1a3b5', 'Build the form'),
    parentThreadId: plan.id,
  };
  const agentThread: Thread = {
    ...thread('2c4e6a8b-0d1f-4a3c-8e5b-7d9f1b3c5e7a', 'Validate inputs'),
    parentThreadId: plan.id,
    origin: 'agent',
  };
  const renderTree = () =>
    render({ path: planPath, threads: [plan, subThread, agentThread, audit] });

  test('a main Thread: Open and Create, then Copy thread ID, then Delete', async () => {
    await render({ path: planPath });

    await openMenu(threadRow('Plan the checkout'));

    assert.deepEqual(groups(), [
      ['Open in new tab', 'New sub-thread in Plan the checkout'],
      ['Copy thread ID'],
      ['Delete thread'],
    ]);
  });

  test('a sub-thread opens in the viewer, and its row opens the Thread there', async () => {
    const workspace = await renderTree();

    await openMenu(threadRow('Build the form'));

    assert.deepEqual(groups(), [
      ['Open in viewer'],
      ['Copy thread ID'],
      ['Delete thread'],
    ]);
    await pick('Open in viewer');
    assert.equal(viewerTab(`thread:${subThread.id}`).dataset.active, 'true');
    assert.equal(pathOf(workspace), planPath);
  });

  test('an agent Thread opens in the viewer and copies its ID', async () => {
    await renderTree();

    await openMenu(threadRow('Validate inputs'));

    assert.deepEqual(groups(), [['Open in viewer'], ['Copy thread ID']]);
  });
});

describe('the Project tab menu', () => {
  test('the first tab: New thread, Rename, Color, then every Close entry', async () => {
    await render({ path: planPath });

    await openMenu(projectTab(project.id));

    assert.deepEqual(groups(), [
      ['New thread', 'Rename', 'Color'],
      [
        'Close tab',
        'Close other tabs',
        'Close tabs to the right',
        'Close all tabs',
      ],
    ]);
    assert.ok(
      entry('Close other tabs').hasAttribute('data-inset'),
      'Close other tabs, without an icon, is not inset.',
    );
  });

  test('the last tab hides Close tabs to the right instead of disabling it', async () => {
    await render({ path: planPath });

    await openMenu(projectTab(docs.id));

    assert.deepEqual(groups(), [
      ['New thread', 'Rename', 'Color'],
      ['Close tab', 'Close other tabs', 'Close all tabs'],
    ]);
    assert.ok(
      entries().every((item) => !item.hasAttribute('data-disabled')),
      'An entry is drawn disabled.',
    );
  });

  test('the only tab hides Close other tabs and Close tabs to the right', async () => {
    await render({ path: planPath, projectTabs: [project] });

    await openMenu(projectTab(project.id));

    assert.deepEqual(groups(), [
      ['New thread', 'Rename', 'Color'],
      ['Close tab', 'Close all tabs'],
    ]);
  });
});

describe('the Dashboard row menu', () => {
  test('Open project, Color, then Delete project behind a separator', async () => {
    await render({ path: '/projects', projectTabs: [] });
    const row = document.querySelector<HTMLElement>(
      `[data-project-id="${docs.id}"]`,
    );
    assert.ok(row, 'No Dashboard row for Docs site.');

    await openMenu(row);

    assert.deepEqual(groups(), [
      ['Open project'],
      ['Color'],
      ['Delete project'],
    ]);
  });
});

describe('A1 Open in new tab', () => {
  test('opens the Thread in a selected viewer tab; the column keeps its Thread', async () => {
    const workspace = await render({ path: planPath });

    await openMenu(threadRow('Accessibility audit'));
    await pick('Open in new tab');

    const tab = viewerTab(`thread:${audit.id}`);
    assert.equal(normalized(tab.textContent), 'Accessibility audit');
    assert.equal(tab.dataset.active, 'true');
    assert.equal(pathOf(workspace), planPath);
    assert.ok(
      threadRow('Plan the checkout').hasAttribute('data-active'),
      'The column no longer shows Plan the checkout.',
    );
  });
});

describe('A2 Open project', () => {
  test("leads the Dashboard row's menu and opens the Project", async () => {
    const workspace = await render({ path: '/projects', projectTabs: [] });
    const row = document.querySelector<HTMLElement>(
      `[data-project-id="${docs.id}"]`,
    );
    assert.ok(row, 'No Dashboard row for Docs site.');

    await openMenu(row);
    assert.equal(labels()[0], 'Open project');
    await pick('Open project');

    // The Project's route: the Project opens on the Thread it resumes.
    assert.match(pathOf(workspace) ?? '', projectRoute(docs));
    const tab = projectTab(docs.id);
    assert.equal(tab.dataset.active, 'true');
  });
});

describe('A3 New thread', () => {
  test('selects the Project and starts a draft in its Threads group', async () => {
    const workspace = await render({ path: planPath });

    await openMenu(projectTab(docs.id));
    await pick('New thread');

    assert.match(pathOf(workspace) ?? '', projectRoute(docs));
    assert.equal(projectTab(docs.id).dataset.active, 'true');
    assert.ok(
      document.querySelector('[aria-label="New thread name"]'),
      'No draft row in the Threads group.',
    );
  });

  test('from the Dashboard opens the Project with the draft', async () => {
    const workspace = await render({ path: '/projects' });

    await openMenu(projectTab(docs.id));
    await pick('New thread');

    assert.match(pathOf(workspace) ?? '', projectRoute(docs));
    assert.ok(
      document.querySelector('[aria-label="New thread name"]'),
      'No draft row in the Threads group.',
    );
  });

  test('in the shown Project ends a search, so the draft row shows', async () => {
    await render({ path: planPath });
    const search = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search Threads"]',
    );
    assert.ok(search, 'No Search Threads field.');
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    setValue?.call(search, 'audit');
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    assert.equal(search.value, 'audit');

    await openMenu(projectTab(project.id));
    await pick('New thread');

    assert.equal(search.value, '');
    assert.ok(
      document.querySelector('[aria-label="New thread name"]'),
      'No draft row in the Threads group.',
    );
  });
});

describe('A4 Color', () => {
  test("shows the picked color on the Project's tab and Dashboard row", async () => {
    await render({ path: '/projects' });

    await openMenu(projectTab(docs.id));
    const color = entries().find(
      (entry) => normalized(entry.textContent) === 'Color',
    );
    assert.ok(color, `No Color entry; the menu holds ${labels().join(' | ')}`);
    color.click();
    await settle();
    const blue = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ].find((item) => normalized(item.textContent) === 'Blue');
    assert.ok(blue, 'No Blue in the Color submenu.');
    blue.click();
    await settle();

    assert.ok(
      projectTab(docs.id).querySelector('.bg-blue-500'),
      'The tab does not show blue.',
    );
    assert.ok(
      document.querySelector(`[data-project-id="${docs.id}"] .bg-blue-500`),
      'The Dashboard row does not show blue.',
    );
  });
});
