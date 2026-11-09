// The layout's ◆ menu entries and the viewer tab menu (§4.4 A1–A4, S15;
// T-4.4.1 for A1–A4, T-4.4.9), as the reader meets them in the workspace:
// - a viewer tab's context menu shows the entries its opener stated
//   (`layout.tabs/v1@1.2.0` `menu`), a separator, then "Close tab"; a tab
//   opened without `menu` shows only "Close tab";
// - A1 "Open in new tab" on a Thread row opens the Thread in a viewer tab and
//   selects it, while the conversation column keeps its Thread;
// - A2 "Open project" leads a Dashboard row's menu and opens the Project;
// - A3 "New thread" on a Project tab selects the Project and starts a draft;
// - A4 "Color" on a Project tab colors the Project's tab and Dashboard row.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { NavigationV1 } from 'bundle/contracts';

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
  test("shows the opener's entries, a separator, then Close tab", async () => {
    await render({ path: planPath });
    const ran: string[] = [];
    const tabs = await tabsService();
    await tabs.open({
      id: 'terminal:1',
      title: 'npm test',
      tag: 'terminal-view',
      menu: [
        { id: 'copy', label: 'Copy command', run: () => ran.push('copy') },
        {
          id: 'kill',
          label: 'Kill terminal',
          destructive: true,
          run: () => ran.push('kill'),
        },
      ],
    });
    await settle();

    await openMenu(viewerTab('terminal:1'));

    assert.deepEqual(labels(), ['Copy command', 'Kill terminal', 'Close tab']);
    const [, kill, close] = entries();
    assert.equal(kill?.dataset.variant, 'destructive');
    assert.notEqual(close?.dataset.variant, 'destructive');
    const separator = document.querySelector(
      '[data-slot="context-menu-content"] [data-slot="context-menu-separator"]',
    );
    assert.ok(separator, 'No separator above Close tab.');
    assert.ok(
      (kill?.compareDocumentPosition(separator) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      'The separator is not between the entries and Close tab.',
    );
    await pick('Kill terminal');
    assert.deepEqual(ran, ['kill']);
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
