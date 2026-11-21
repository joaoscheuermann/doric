// The workspace's navigation, read the way a reader meets it (moved from the
// layout's `tests/client/shell.test.ts` in bundle isolation 4(c)): the
// sidebar's content, the Project tabs, the Dashboard and the routes, mounted
// in the shell's slots as `renderWorkspace` mounts them. The frame's own
// cases stayed in `bundles/desktop/layout/tests/client/shell.test.ts`.
//
// - T-2.1, S10: after phase 2 removed the global footer, neither the Project
//   view nor the Dashboard renders it, so nothing draws the
//   `layout.global-footer` region.
// - T-2.9: the behaviors that must survive the phase 2 rebuild of the window
//   (spec §2.1–2.6). They name what the reader sees (roles, accessible names,
//   text) and where the window is (its path), never the shell's structure,
//   and they stay out of what the rebuild changes: the Home tab, the global
//   footer, and where `ProjectPanelTabs` and the account status sit.
// - T-1.5 (sidebar alignment §5): an Untitled Thread wears the Untitled icon
//   on its last crumb and its tab; a tab whose Thread the tree lacks keeps
//   the main bubble.
// - T-3.2–T-3.5 (sidebar alignment §9): the column is search, the Thread
//   region (tree scroller, New Thread button), then the registered panes at
//   the bottom; no Threads pane, nothing resizes in the stack.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  NavigationV1,
  type RegionItem,
  RegionsV1,
  type RouteMatch,
  type RouteRegistration,
  type Services,
  UiV1,
} from 'bundle/contracts';
import type { RuntimeRecords } from 'runtime/contracts';

import type { Project, Thread } from '../../src/client/domain/workspace.js';
import type { WorkspaceFixture } from '../../stories/support/workspace-host.js';
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
  id: '0b7d9c1e-2f3a-4b5c-9d8e-7f6a5b4c3d2e',
  name: 'Docs site',
  state: 'ready',
  configRevision: 1,
  createdAt: '2026-11-02T10:00:00.000Z',
  updatedAt: '2026-11-08T10:00:00.000Z',
};

const billing: Project = {
  id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  name: 'Billing service',
  state: 'ready',
  configRevision: 1,
  createdAt: '2026-11-03T10:00:00.000Z',
  updatedAt: '2026-11-07T10:00:00.000Z',
};

const thread = (id: string, name: string): Thread => ({
  id,
  projectId: project.id,
  name,
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '2026-11-09T09:00:00.000Z',
  updatedAt: '2026-11-09T09:30:00.000Z',
});

const planThread = thread('3d1e5f7a-9b2c-4d6e-8f0a-1b3c5d7e9f2a', 'Plan');
const formThread = thread('7e9f1a3b-5c7d-4e9f-a1b3-c5d7e9f1a3b5', 'Form');

let rendered: RenderedWorkspace | undefined;

afterEach(() => {
  rendered?.cleanup();
  rendered = undefined;
  document.body.replaceChildren();
});

const normalized = (text: string | null | undefined): string =>
  (text ?? '').replace(/\s+/g, ' ').trim();

/** The accessible name of a control: its `aria-label`, else its text. */
const nameOf = (element: Element): string =>
  normalized(element.getAttribute('aria-label') ?? element.textContent);

/** The window's path, as the host's navigation holds it. */
const pathOf = (workspace: RenderedWorkspace): string | undefined =>
  workspace.services.use(NavigationV1).current()?.path;

/** The controls under `root` with `selector` whose accessible name is `name`. */
const named = (
  root: ParentNode,
  selector: string,
  name: string,
): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(selector)].filter(
    (element) => nameOf(element) === name,
  );

/** The one control with `selector` named `name`; fails naming what is there. */
const only = (
  root: ParentNode,
  selector: string,
  name: string,
): HTMLElement => {
  const found = named(root, selector, name);
  const [first] = found;
  assert.ok(
    found.length === 1 && first !== undefined,
    `Expected one ${selector} named "${name}", found ${found.length}; there are: ${[
      ...root.querySelectorAll(selector),
    ]
      .map(nameOf)
      .join(' | ')}`,
  );
  return first;
};

/** The Project tabs, by name, in the order the strip shows them. */
const projectTabNames = (
  workspace: RenderedWorkspace,
  candidates: readonly Project[],
): string[] => {
  const names = new Set(candidates.map((candidate) => candidate.name));
  return [...workspace.root.querySelectorAll('button')]
    .map(nameOf)
    .filter((name) => names.has(name));
};

/** The Project tab named `name`, the one control that carries that label. */
const projectTab = (workspace: RenderedWorkspace, name: string): HTMLElement =>
  only(workspace.root, 'button[aria-label]', name);

const isCurrent = (element: Element): boolean =>
  element.getAttribute('aria-current') === 'page';

/** The labelled stand-ins for another bundle's element `tag`. */
const standIns = (root: ParentNode, tag: string): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`[data-story-placeholder="${tag}"]`),
];

/** Whether `later` comes after `earlier` in the document. */
const follows = (earlier: Node, later: Node): boolean =>
  (earlier.compareDocumentPosition(later) &
    Node.DOCUMENT_POSITION_FOLLOWING) !==
  0;

const click = async (element: HTMLElement): Promise<void> => {
  element.click();
  await settle();
};

const key = async (
  element: HTMLElement,
  init: KeyboardEventInit,
): Promise<void> => {
  element.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
  );
  await settle();
};

// T-2.9.1: selecting a Thread opens its route and marks its row; the
// conversation the route shows is the chat's element in the frame's outlet
// (step 4(c)), so the frame's tests assert it, not this one.
test('selecting a Thread in the tree opens its route and marks its row', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    threads: [planThread, formThread],
    path: `/projects/${project.id}`,
  });

  await click(only(rendered.root, '[role="treeitem"]', formThread.name));

  assert.equal(
    pathOf(rendered),
    `/projects/${project.id}/threads/${formThread.id}`,
  );
  assert.ok(
    only(rendered.root, '[role="treeitem"]', formThread.name).hasAttribute(
      'data-active',
    ),
    'The selected Thread row is not marked.',
  );
});

// T-2.9.2
test('opening a Project from the Dashboard adds its tab and selects it', async () => {
  rendered = await renderWorkspace({
    projects: [project, docs],
    path: '/projects',
  });
  assert.equal(
    named(rendered.root, 'button[aria-label]', docs.name).length,
    0,
    'Docs site has a tab before it is opened.',
  );

  const entries = [...rendered.root.querySelectorAll<HTMLElement>('button')]
    .filter((button) => normalized(button.textContent).includes(docs.name))
    .filter((button) => !button.hasAttribute('aria-label'));
  const [entry] = entries;
  assert.ok(entry !== undefined, 'The Dashboard does not list Docs site.');
  await click(entry);

  assert.equal(pathOf(rendered), `/projects/${docs.id}`);
  const tab = projectTab(rendered, docs.name);
  assert.ok(isCurrent(tab), 'The opened Project tab is not the selected one.');
});

// T-2.9.2: closing the selected tab selects the tab that took its place, its
// right-hand neighbour (`use-project-tabs.ts` `closeMany`).
test('closing the selected Project tab removes it and selects the next tab', async () => {
  rendered = await renderWorkspace({
    projects: [project, docs, billing],
    projectTabs: [project, docs, billing],
    path: `/projects/${docs.id}`,
  });
  assert.ok(isCurrent(projectTab(rendered, docs.name)));

  await click(only(rendered.root, 'button', `Close ${docs.name} tab`));

  assert.deepEqual(projectTabNames(rendered, [project, docs, billing]), [
    project.name,
    billing.name,
  ]);
  assert.equal(pathOf(rendered), `/projects/${billing.id}`);
  assert.ok(
    isCurrent(projectTab(rendered, billing.name)),
    'The tab after the closed one is not selected.',
  );
});

// T-2.9.2: the last tab has no right-hand neighbour, so the one before it is
// selected.
test('closing the selected last Project tab selects the tab before it', async () => {
  rendered = await renderWorkspace({
    projects: [project, docs, billing],
    projectTabs: [project, docs, billing],
    path: `/projects/${billing.id}`,
  });

  await click(only(rendered.root, 'button', `Close ${billing.name} tab`));

  assert.deepEqual(projectTabNames(rendered, [project, docs, billing]), [
    project.name,
    docs.name,
  ]);
  assert.equal(pathOf(rendered), `/projects/${docs.id}`);
  assert.ok(isCurrent(projectTab(rendered, docs.name)));
});

// T-2.9.3
test('Alt+Shift+Left and Alt+Shift+Right move the selected Project tab one place', async () => {
  rendered = await renderWorkspace({
    projects: [project, docs, billing],
    projectTabs: [project, docs, billing],
    path: `/projects/${docs.id}`,
  });
  const all = [project, docs, billing];

  await key(projectTab(rendered, docs.name), {
    key: 'ArrowRight',
    altKey: true,
    shiftKey: true,
  });
  assert.deepEqual(projectTabNames(rendered, all), [
    project.name,
    billing.name,
    docs.name,
  ]);

  await key(projectTab(rendered, docs.name), {
    key: 'ArrowLeft',
    altKey: true,
    shiftKey: true,
  });
  await key(projectTab(rendered, docs.name), {
    key: 'ArrowLeft',
    altKey: true,
    shiftKey: true,
  });
  assert.deepEqual(projectTabNames(rendered, all), [
    docs.name,
    project.name,
    billing.name,
  ]);
  assert.ok(
    isCurrent(projectTab(rendered, docs.name)),
    'The moved tab is no longer selected.',
  );
});

/** Double-clicks the Project tab named `name` and answers the name field. */
const openRename = async (
  workspace: RenderedWorkspace,
  name: string,
): Promise<HTMLElement> => {
  projectTab(workspace, name).dispatchEvent(
    new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
  );
  await settle();
  return only(workspace.root, '[role="textbox"]', 'Project name');
};

// T-2.9.4
test('double-clicking a Project tab renames it, and Enter saves the name', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    projectTabs: [project],
    path: `/projects/${project.id}`,
  });

  const field = await openRename(rendered, project.name);
  field.textContent = 'Checkout v2';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await key(field, { key: 'Enter' });

  assert.equal(
    named(rendered.root, '[role="textbox"]', 'Project name').length,
    0,
    'The name field is still open after Enter.',
  );
  assert.equal(
    named(rendered.root, 'button[aria-label]', project.name).length,
    0,
  );
  projectTab(rendered, 'Checkout v2');
});

// T-2.9.4
test('Escape in a Project tab rename keeps the old name', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    projectTabs: [project],
    path: `/projects/${project.id}`,
  });

  const field = await openRename(rendered, project.name);
  field.textContent = 'Checkout v2';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await key(field, { key: 'Escape' });

  assert.equal(
    named(rendered.root, '[role="textbox"]', 'Project name').length,
    0,
    'The name field is still open after Escape.',
  );
  projectTab(rendered, project.name);
  assert.equal(
    named(rendered.root, 'button[aria-label]', 'Checkout v2').length,
    0,
  );
});

// T-2.9.7 (G7)
test("a Thread's terminal rows mount under that Thread in the tree", async () => {
  rendered = await renderWorkspace({
    projects: [project],
    threads: [planThread, formThread],
    path: `/projects/${project.id}`,
    terminalRows: { [planThread.id]: 1 },
  });

  const rows = [...rendered.root.querySelectorAll('button')].filter(
    (button) => normalized(button.textContent) === 'npm run dev',
  );
  const [row] = rows;
  assert.ok(
    rows.length === 1 && row !== undefined,
    `Expected one terminal row, found ${rows.length}.`,
  );
  const owners = [
    ...rendered.root.querySelectorAll<HTMLElement>('[role="treeitem"]'),
  ].filter((item) => follows(item, row));
  assert.equal(
    nameOf(owners.at(-1) ?? rendered.root),
    planThread.name,
    'The terminal row does not sit under Plan.',
  );
});

// Phase 2d-1: the window rebuilt as full-height columns on the sidebar canvas
// (spec §2.1–2.5). These name the hooks the 2d-1 contracts promise: the
// canvas and card classes (T-2.13), the sidebar header's Dashboard button
// (T-2.7), the tab bar's right end, the conversation footer band (T-2.9.9) and
// the invisible viewer handle (G1). happy-dom computes no layout, so a look
// such as "a card" or "no line" is observable here only as the classes that
// draw it.

/** The classes of `classes` that `element` does not carry. */
const missingClasses = (element: Element, classes: string): string[] =>
  classes
    .split(/\s+/)
    .filter((name) => name !== '' && !element.classList.contains(name));

/** The one element under `root` that matches `selector`; fails if not one. */
const single = (root: ParentNode, selector: string): HTMLElement => {
  const found = [...root.querySelectorAll<HTMLElement>(selector)];
  const [first] = found;
  assert.ok(
    found.length === 1 && first !== undefined,
    `Expected one ${selector}, found ${found.length}.`,
  );
  return first;
};

// T-2.7, first clause
test('the Dashboard button in the sidebar header opens the Dashboard', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    projectTabs: [project],
    path: `/projects/${project.id}`,
  });

  const header = single(
    rendered.root,
    '[data-slot="workspace-sidebar-header"]',
  );
  await click(only(header, 'button', 'Dashboard'));

  assert.equal(pathOf(rendered), '/projects');
});

// UR1, Figma `99:8035`: in a Project the Dashboard button is not the current
// page (it is on `/` and `/projects`, dashboard-shell.test.ts)
test('in a Project the Dashboard button is not the current page', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    projectTabs: [project],
    path: `/projects/${project.id}`,
  });

  const header = single(
    rendered.root,
    '[data-slot="workspace-sidebar-header"]',
  );
  const button = only(header, 'button', 'Dashboard');
  assert.equal(button.getAttribute('aria-current'), null);
  assert.equal(button.hasAttribute('data-active'), false);
});

// T-2.7, first clause
test('the Project tab bar has no Dashboard tab', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    projectTabs: [project],
    path: `/projects/${project.id}`,
  });

  assert.equal(
    named(tabBar(rendered), 'button, [role="tab"], a', 'Dashboard').length,
    0,
    'The tab bar still has a Dashboard control.',
  );
});

// One header row: the Dashboard control exists once in the window.
test('the window names one control "Dashboard"', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    projectTabs: [project],
    path: `/projects/${project.id}`,
  });

  const dashboards = named(
    rendered.root,
    'button, a, [role], [aria-label]',
    'Dashboard',
  );
  assert.ok(
    dashboards.length <= 1,
    `"Dashboard" names ${dashboards.length} elements.`,
  );
});

const tabBar = (workspace: RenderedWorkspace): HTMLElement =>
  single(workspace.root, 'nav[aria-label="Workspace tabs"]');

/** A Project view with the panel's views and one `shell.header.actions` item. */
const withHeaderItems = (fixture: WorkspaceFixture): WorkspaceFixture => ({
  ...fixture,
  regions: {
    'shell.header.actions': [
      { id: 'header-probe', tag: 'header-probe', order: 10 },
    ],
  },
});

const tabBarEnd = (workspace: RenderedWorkspace): HTMLElement =>
  single(tabBar(workspace), '[data-slot="project-tab-actions"]');

// One header row: the tab bar keeps "New project", and its right end holds
// the `shell.header.actions` region, which `workspace-project-tabs` writes in
// a Project (step 4(c), decision O1).
test('the tab bar keeps New project and ends with the shell.header.actions region', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    projectTabs: [project],
    path: `/projects/${project.id}`,
    regions: {
      'shell.header.actions': [
        { id: 'header-probe', tag: 'header-probe', order: 10 },
      ],
    },
  });

  const bar = tabBar(rendered);
  only(bar, 'button', 'New project');
  const end = single(bar, '[data-slot="project-tab-actions"]');
  single(end, 'core-region[name="shell.header.actions"]');
  assert.equal(
    standIns(end, 'header-probe').length,
    1,
    'The shell.header.actions item is not at the tab bar right end.',
  );
});

// Check 2, item 9 (`99:8035`, `85:7520`): every Project tab is 172 px wide,
// and may shrink, down to its 100 px floor, before the strip scrolls.
test('every Project tab is 172 px wide and may shrink', async () => {
  rendered = await renderWorkspace({
    projects: [project, docs, billing],
    projectTabs: [project, docs, billing],
    path: `/projects/${project.id}`,
  });

  const tabs = [
    ...tabBar(rendered).querySelectorAll<HTMLElement>('[data-tab-id]'),
  ];
  assert.equal(tabs.length, 3, 'The tab bar does not show three Projects.');
  for (const tab of tabs) {
    assert.deepEqual(
      missingClasses(tab, 'w-[172px] min-w-[100px] shrink'),
      [],
      `The tab "${nameOf(tab)}" is not 172 px wide with a 100 px floor.`,
    );
    assert.ok(
      !tab.classList.contains('shrink-0'),
      `The tab "${nameOf(tab)}" cannot shrink.`,
    );
  }
});

// §2.6, S36: the tab bar's end holds the header items, and neither the Project
// views nor Account, which the frame draws in the Files header.
test('the tab bar end holds the shell.header.actions items and neither the Project views nor Account', async () => {
  rendered = await renderWorkspace(
    withHeaderItems({
      projects: [project],
      projectTabs: [project],
      path: `/projects/${project.id}`,
    }),
  );

  const end = tabBarEnd(rendered);
  assert.equal(
    end.querySelectorAll('[aria-label="Project views"]').length,
    0,
    'The tab bar still holds the Project views.',
  );
  assert.equal(
    named(end, 'button', 'Account').length,
    0,
    'The tab bar still holds Account.',
  );
  assert.equal(
    standIns(end, 'header-probe').length,
    1,
    'The shell.header.actions item left the tab bar.',
  );
});

// Phase 2e, T-2.8 (spec §2.2, contracts 2e §1): a "+ New Thread" button
// starts the inline root draft; nothing else in the sidebar is named "New
// thread" (T-3.2 below).

// T-2.8
test('pressing New Thread with a selected Project shows the new thread name field in the tree', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    threads: [planThread, formThread],
    path: `/projects/${project.id}`,
  });
  assert.equal(
    named(rendered.root, '[role="textbox"]', 'New thread name').length,
    0,
    'A new thread name field is open before New Thread is pressed.',
  );

  await click(only(rendered.root, 'button', 'New Thread'));

  assert.equal(rendered.errors().length, 0, 'Pressing New Thread failed.');
  const fields = [
    ...rendered.root.querySelectorAll<HTMLElement>('[role="textbox"]'),
  ].filter(
    (element) => element.getAttribute('aria-label') === 'New thread name',
  );
  assert.equal(fields.length, 1, 'No single "New thread name" field shows.');
  const items = [
    ...rendered.root.querySelectorAll<HTMLElement>('[role="treeitem"]'),
  ];
  assert.ok(
    fields[0] !== undefined &&
      items.length > 0 &&
      items.every((item) => follows(item, fields[0] as HTMLElement)),
    'The new thread name field is not at the end of the tree.',
  );
});

// Phase 5, T-5.11 (spec §11.6): the draft row takes the unselected fill and
// the textbox outline on the div that holds its field and guides.
test('T-5.11: the New Thread draft row has the unselected fill and the textbox ring', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    threads: [planThread, formThread],
    path: `/projects/${project.id}`,
  });
  await click(only(rendered.root, 'button', 'New Thread'));
  assert.equal(rendered.errors().length, 0, 'Pressing New Thread failed.');

  const field = only(rendered.root, '[role="textbox"]', 'New thread name');
  let holder: HTMLElement | null = field.parentElement;
  while (holder !== null && holder.tagName !== 'DIV')
    holder = holder.parentElement;
  assert.ok(holder !== null, 'The new thread name field is not inside a div.');
  const classes = [...holder.classList];
  assert.deepEqual(
    [
      'rounded-[4px]',
      'hover:bg-[var(--paper-ghost-hover)]',
      'active:bg-[var(--paper-ghost-pressed)]',
      'has-[[role=textbox]:focus-visible]:outline-2',
      'has-[[role=textbox]:focus-visible]:-outline-offset-2',
      'has-[[role=textbox]:focus-visible]:outline-[var(--sidebar-ring)]',
    ].filter((name) => !classes.includes(name)),
    [],
    `The draft row lacks its states: ${classes.join(' ')}`,
  );
  assert.ok(!classes.includes('bg-sidebar-accent'), classes.join(' '));
});

// Sidebar alignment phase 3 (spec §9, D8–D14): the column is the search
// field, then the Thread region (the tree's scroller and the New Thread
// button), then one group per registered pane at the bottom. There is no
// Threads pane and nothing in the stack resizes. happy-dom lays nothing out,
// so the caps and minimums are observable only as the classes that set them.
// Since bundle isolation 4(c) the stack's panes are the frame's, drawn below
// the `shell.sidebar` items: that half is the layout's (T-2.9.8 in
// `L/tests/client/shell.test.ts`).

/** The Project sidebar: the `workspace-sidebar` item that holds "Search Threads". */
const projectSidebar = (root: ParentNode): HTMLElement => {
  const sidebar = root
    .querySelector('input[aria-label="Search Threads"]')
    ?.closest<HTMLElement>('workspace-sidebar');
  assert.ok(sidebar, 'No workspace-sidebar holds the "Search Threads" field.');
  return sidebar;
};

/**
 * Renders the `ProjectSidebar` story `name` alone, as the `NoProject` case
 * below does, and calls `check` with its root; unmounts afterwards.
 */
const withStory = async (
  name: 'LoadingThreads' | 'RequestFailed' | 'SearchNoMatch',
  check: (root: HTMLElement) => void,
): Promise<void> => {
  // Rendering the workspace once installs happy-dom's window as the globals.
  (await renderWorkspace()).cleanup();
  const { createElement } = await import('react');
  const { flushSync } = await import('react-dom');
  const { createRoot } = await import('react-dom/client');
  const stories = await import(
    '../../stories/components/organisms/project-sidebar.stories.js'
  );
  const story = stories[name];
  const root = document.createElement('div');
  document.body.append(root);
  const react = createRoot(root);
  try {
    flushSync(() => react.render(createElement(() => story.render())));
    await settle();
    await settle();
    check(root);
  } finally {
    react.unmount();
  }
};

/** The Thread tree's scroller in `root`. */
const threadTree = (root: ParentNode): HTMLElement =>
  single(root, '[data-slot="thread-tree"]');

// T-3.2, replacing T-2.8's "the Threads pane header has no New thread control"
test('the column reads search, the Thread tree, then the New Thread button', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    threads: [planThread, formThread],
    path: `/projects/${project.id}`,
  });
  const sidebar = projectSidebar(rendered.root);
  const search = single(sidebar, 'input[aria-label="Search Threads"]');
  const tree = threadTree(sidebar);
  const button = only(sidebar, 'button', 'New Thread');
  const items = [...sidebar.querySelectorAll<HTMLElement>('[role="treeitem"]')];

  assert.ok(follows(search, tree), 'The tree is not below the search field.');
  assert.equal(items.length, 2, 'The tree does not show both Threads.');
  assert.ok(
    items.every((item) => tree.contains(item)),
    'A Thread row is outside the tree scroller.',
  );
  assert.ok(
    !tree.contains(button) && follows(tree, button),
    'The New Thread button does not follow the tree scroller.',
  );
  assert.ok(
    items.every((item) => follows(item, button)),
    'A Thread row comes after the New Thread button.',
  );
  assert.equal(normalized(button.textContent), '', 'New Thread has text.');
  assert.equal(button.querySelectorAll('svg').length, 1);
  assert.equal(button.querySelectorAll('svg.lucide-plus').length, 1);
  // The button takes the rows' ghost tokens: the row hover fill at rest and
  // the row pressed fill under the pointer, not the secondary colours.
  assert.deepEqual(
    missingClasses(
      button,
      'w-full bg-[var(--paper-ghost-hover)] hover:bg-[var(--paper-ghost-pressed)]',
    ),
    [],
  );
  for (const dropped of [
    'bg-secondary',
    'hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]',
  ]) {
    assert.equal(
      button.classList.contains(dropped),
      false,
      `New Thread keeps ${dropped}.`,
    );
  }
  assert.equal(
    named(sidebar, 'button, [aria-label]', 'New thread').length,
    0,
    'A control named "New thread" is still in the sidebar.',
  );
});

// T-3.2: the error alert is inside the tree scroller, above the rows.
test('a failed request is reported inside the tree scroller, above the rows', async () => {
  await withStory('RequestFailed', (root) => {
    const tree = threadTree(root);
    const alert = single(root, '[role="alert"]');
    const [first] = tree.querySelectorAll('[role="treeitem"]');
    assert.ok(tree.contains(alert), 'The alert is outside the tree scroller.');
    assert.ok(
      first !== undefined && follows(alert, first),
      'The alert is not above the rows.',
    );
    assert.ok(
      follows(tree, only(root, 'button', 'New Thread')),
      'The New Thread button is not below the tree scroller.',
    );
  });
});

// T-3.2: the skeleton rows are inside the tree scroller.
test('while the Threads load, the skeleton rows are inside the tree scroller', async () => {
  await withStory('LoadingThreads', (root) => {
    const tree = threadTree(root);
    const skeletons = root.querySelectorAll(
      '[data-slot="sidebar-menu-skeleton"]',
    );
    assert.ok(skeletons.length > 0, 'No skeleton rows while loading.');
    assert.equal(
      tree.querySelectorAll('[data-slot="sidebar-menu-skeleton"]').length,
      skeletons.length,
      'A skeleton row is outside the tree scroller.',
    );
  });
});

// T-3.2: "No threads match" ends the tree scroller, above the button.
test('a query that matches nothing ends the tree scroller with its notice', async () => {
  await withStory('SearchNoMatch', (root) => {
    const tree = threadTree(root);
    const notice = single(root, '[data-threads-empty]');
    assert.ok(tree.contains(notice), 'The notice is outside the scroller.');
    assert.ok(
      [...tree.querySelectorAll('*')].every(
        (element) => notice.contains(element) || !follows(notice, element),
      ),
      'Something in the tree scroller follows the notice.',
    );
    assert.ok(
      follows(tree, only(root, 'button', 'New Thread')),
      'The New Thread button is not below the tree scroller.',
    );
  });
});

// T-2.8. The workspace always selects the Project its path names, and sends
// any other path to the Dashboard, so the sidebar without a selected Project
// is rendered alone, as its `NoProject` story draws it.
test('New Thread is disabled while no Project is selected', async () => {
  // Rendering the workspace once installs happy-dom's window as the globals.
  (await renderWorkspace()).cleanup();
  const { createElement } = await import('react');
  const { flushSync } = await import('react-dom');
  const { createRoot } = await import('react-dom/client');
  const { NoProject } = await import(
    '../../stories/components/organisms/project-sidebar.stories.js'
  );
  const root = document.createElement('div');
  document.body.append(root);
  const react = createRoot(root);
  try {
    flushSync(() => react.render(createElement(() => NoProject.render())));
    await settle();

    const row = only(root, 'button', 'New Thread');
    assert.ok(
      row.hasAttribute('disabled'),
      'New Thread is enabled without a selected Project.',
    );
  } finally {
    react.unmount();
  }
});

// T-1.5 (spec §5, U2): an Untitled Thread wears the Untitled icon
// (`message-circle-dashed`) on every surface that names it by its kind icon.
const untitledThread: Thread = {
  ...thread('8b0d2f4a-6c8e-4a0b-9d2f-4a6c8e0b2d4f', ''),
  parentThreadId: planThread.id,
};

test("T-1.5: the breadcrumb's last crumb wears the Untitled icon for an Untitled Thread", async () => {
  // Rendering the workspace once installs happy-dom's window as the globals.
  (await renderWorkspace()).cleanup();
  const { createElement } = await import('react');
  const { flushSync } = await import('react-dom');
  const { createRoot } = await import('react-dom/client');
  const { ThreadBreadcrumb } = await import(
    '../../src/client/components/molecules/thread-breadcrumb.js'
  );
  const root = document.createElement('div');
  document.body.append(root);
  const react = createRoot(root);
  try {
    flushSync(() =>
      react.render(
        createElement(ThreadBreadcrumb, {
          project,
          path: [planThread, untitledThread],
          onSelectProject: () => undefined,
          onSelectThread: () => undefined,
        }),
      ),
    );
    await settle();

    const pages = root.querySelectorAll('[data-slot="breadcrumb-page"]');
    assert.equal(pages.length, 1, 'The breadcrumb has no single last crumb.');
    assert.equal(
      pages[0]?.querySelectorAll('svg.lucide-message-circle-dashed').length,
      1,
      'The last crumb does not wear the Untitled icon.',
    );
  } finally {
    react.unmount();
  }
});

// Bundle isolation step 4(a), change 7 ---------------------------------------
// - O2: `layout/contracts` names the five new slots, and the layout fills
//   `shell.sidebar` and `shell.titlebar.tabs` in every window, and
//   `shell.page` and `shell.sidebar.footer` while the route is `/` or
//   `/projects`. Since step 4(b) `account` fills `shell.window.actions`.
// - T4.2: the frame is in the page form exactly while `shell.page` holds an
//   item; `/projects` and `/projects/:projectId` are children of `/`, and the
//   second's element, `workspace-project-empty`, draws the empty state.
// - T4.6: the sidebar column reads `shell.sidebar`, the stack panes
//   (conversation form only), the quarantine notice, then
//   `shell.sidebar.footer`.
// - O1 (OD38): the navigation's slot elements are separate roots; its state
//   lives in stores, and its once-per-window effects run in `workspace-sidebar`
//   alone.

/** A Thread route of `project`, where the conversation form is drawn. */
const planPath = `/projects/${project.id}/threads/${planThread.id}`;

/** The layout activated on a fake host whose routes, elements and region items are recorded. */
interface RecordedActivation {
  /** Every route the layout registered, in order. */
  readonly routes: readonly RouteRegistration[];
  /** Every element the layout asked `ui/v1` to create, in order. */
  readonly created: readonly {
    readonly tag: string;
    readonly props?: Readonly<Record<string, unknown>>;
  }[];
  /** The tags of the items the layout holds in `region` now, in add order. */
  tags(region: string): readonly string[];
  /** Moves the host's navigation to `path`, as the window's router does. */
  navigate(path: string): void;
  deactivate(): Promise<void>;
}

/**
 * Activates the layout alone, with no window mounted, on the stories' fake
 * host for `path`: `navigation/v1` `register`, `ui/v1` `create` and
 * `regions/v1` `add` are recorded on their way to the host.
 */
const activateRecorded = async (path: string): Promise<RecordedActivation> => {
  // Rendering the workspace once installs happy-dom's window as the globals.
  (await renderWorkspace()).cleanup();
  const { createFakeHost } = await import('../../stories/support/fake-host.js');
  const { activate } = await import('../../src/client/index.js');
  const host = createFakeHost({ projects: [project], path });
  const inner = host.services;
  const navigation = inner.use(NavigationV1);
  const ui = inner.use(UiV1);
  const regions = inner.use(RegionsV1);

  const routes: RouteRegistration[] = [];
  const created: {
    tag: string;
    props?: Readonly<Record<string, unknown>>;
  }[] = [];
  const live = new Map<string, { readonly item: RegionItem }[]>();
  const recorded: Record<string, unknown> = {
    [NavigationV1.id]: {
      ...navigation,
      register: (route: RouteRegistration) => {
        routes.push(route);
        return navigation.register(route);
      },
    },
    [UiV1.id]: {
      ...ui,
      create: (tag: string, props?: Readonly<Record<string, unknown>>) => {
        created.push(props === undefined ? { tag } : { tag, props });
        return ui.create(tag, props);
      },
    },
    [RegionsV1.id]: {
      ...regions,
      add: (region: string, item: RegionItem) => {
        const entry = { item };
        live.set(region, [...(live.get(region) ?? []), entry]);
        const added = regions.add(region, item);
        return {
          dispose: () => {
            live.set(
              region,
              (live.get(region) ?? []).filter((other) => other !== entry),
            );
            added.dispose();
          },
        };
      },
    },
  };
  const services = {
    ...inner,
    use: (contract: { readonly id: string }) =>
      recorded[contract.id] ?? inner.use(contract as never),
  } as unknown as Services;
  const cleanup = activate({ services });
  return {
    routes,
    created,
    tags: (region) => (live.get(region) ?? []).map(({ item }) => item.tag),
    navigate: (next) => navigation.navigate(next),
    deactivate: async () => {
      await cleanup();
    },
  };
};

/** The one route registered for `path`; fails naming what was registered. */
const routeOf = (
  activation: RecordedActivation,
  path: string,
): RouteRegistration => {
  const found = activation.routes.filter((route) => route.path === path);
  const [first] = found;
  assert.ok(
    found.length === 1 && first !== undefined,
    `Expected one route ${path}, found ${found.length}; registered: ${activation.routes
      .map((route) => route.path)
      .join(' | ')}`,
  );
  return first;
};

const matchOf = (
  path: string,
  pattern: string,
  params: Record<string, string> = {},
): RouteMatch => ({ path, pattern, params }) as RouteMatch;

// O2 (moved to `workspace` in step 4(c), decision O11): the navigation's
// four elements, and the two slots that follow the route; `workspace` adds
// nothing to shell.window.actions.
test('workspace fills shell.sidebar and shell.titlebar.tabs always, nothing in shell.window.actions, and shell.page and shell.sidebar.footer only on / and /projects', async () => {
  const activation = await activateRecorded('/projects');
  try {
    for (const path of [
      '/projects',
      `/projects/${project.id}`,
      '/',
      planPath,
      '/projects',
    ]) {
      activation.navigate(path);
      const onDashboard = path === '/' || path === '/projects';
      assert.deepEqual(
        {
          'shell.sidebar': activation.tags('shell.sidebar'),
          'shell.titlebar.tabs': activation.tags('shell.titlebar.tabs'),
          'shell.window.actions': activation.tags('shell.window.actions'),
          'shell.page': activation.tags('shell.page'),
          'shell.sidebar.footer': activation.tags('shell.sidebar.footer'),
        },
        {
          'shell.sidebar': ['workspace-sidebar'],
          'shell.titlebar.tabs': ['workspace-project-tabs'],
          'shell.window.actions': [],
          'shell.page': onDashboard ? ['workspace-dashboard'] : [],
          'shell.sidebar.footer': onDashboard
            ? ['workspace-sidebar-footer']
            : [],
        },
        `The workspace's slot items on ${path}.`,
      );
    }
  } finally {
    await activation.deactivate();
  }
});

// T4.2
test("T4.2: /projects and /projects/:projectId are registered as children of /, which is the shell's", async () => {
  const activation = await activateRecorded('/');
  try {
    assert.deepEqual(
      activation.routes.filter((route) => route.path === '/'),
      [],
      "workspace registers the shell's / route.",
    );
    assert.equal(routeOf(activation, '/projects').parent, '/');
    assert.equal(routeOf(activation, '/projects/:projectId').parent, '/');
  } finally {
    await activation.deactivate();
  }
});

// T4.2
test('T4.2: /projects creates workspace-projects-route, and /projects/:projectId creates workspace-project-empty with its Project id', async () => {
  const activation = await activateRecorded('/');
  try {
    routeOf(activation, '/projects').create(matchOf('/projects', '/projects'));
    assert.deepEqual(
      activation.created.at(-1)?.tag,
      'workspace-projects-route',
      'The /projects route does not create workspace-projects-route.',
    );

    routeOf(activation, '/projects/:projectId').create(
      matchOf(`/projects/${project.id}`, '/projects/:projectId', {
        projectId: project.id,
      }),
    );
    const empty = activation.created.at(-1);
    assert.equal(
      empty?.tag,
      'workspace-project-empty',
      'The /projects/:projectId route does not create workspace-project-empty.',
    );
    assert.equal(empty?.props?.projectId, project.id);
  } finally {
    await activation.deactivate();
  }
});

/** Creates `tag` through the window's `ui/v1`, as the outlet does, and mounts it. */
const mountCreated = async (
  workspace: RenderedWorkspace,
  tag: string,
  props?: Readonly<Record<string, unknown>>,
): Promise<HTMLElement> => {
  const element = workspace.services
    .use(UiV1)
    .create(tag, props) as HTMLElement;
  const outlet = document.createElement('div');
  document.body.append(outlet);
  outlet.append(element);
  await settle();
  return outlet;
};

const EMPTY_TEXT = 'Start a thread or select one from the sidebar.';

// T4.2
test("T4.2: workspace-project-empty draws the Project's name, the text and New thread", async () => {
  rendered = await renderWorkspace({
    projects: [project],
    path: `/projects/${project.id}`,
  });

  const empty = await mountCreated(rendered, 'workspace-project-empty', {
    projectId: project.id,
  });

  const text = normalized(empty.textContent);
  assert.ok(text.includes(project.name), `No Project name in: ${text}`);
  assert.ok(text.includes(EMPTY_TEXT), `No empty-state text in: ${text}`);
  assert.ok(!text.includes('No project selected'), text);
  only(empty, 'button', 'New thread');
});

// T4.2
test('T4.2: for a Project the mirror does not hold, workspace-project-empty draws "No project selected" and no button', async () => {
  const missing = 'c0ffee00-0000-4000-8000-000000000000';
  rendered = await renderWorkspace({
    projects: [project],
    path: `/projects/${missing}`,
  });

  const empty = await mountCreated(rendered, 'workspace-project-empty', {
    projectId: missing,
  });

  const text = normalized(empty.textContent);
  assert.ok(text.includes('No project selected'), `No title in: ${text}`);
  assert.ok(text.includes(EMPTY_TEXT), `No empty-state text in: ${text}`);
  assert.equal(
    named(empty, 'button', 'New thread').length,
    0,
    'The empty state offers New thread for a Project the mirror lacks.',
  );
});

// T4.2: `/projects` is covered by the page form; its element draws nothing.
test('T4.2: workspace-projects-route draws nothing', async () => {
  rendered = await renderWorkspace({ projects: [project], path: '/projects' });

  const route = await mountCreated(rendered, 'workspace-projects-route');

  assert.equal(normalized(route.textContent), '');
  assert.equal(
    route.querySelectorAll('*').length,
    1,
    'workspace-projects-route draws something inside itself.',
  );
});

// O1 (OD38) -------------------------------------------------------------------

/** The navigation's elements the frame draws in the page form, one per slot. */
const pageFormElements = [
  'workspace-sidebar',
  'workspace-sidebar-footer',
  'workspace-project-tabs',
  'workspace-dashboard',
];

/** The navigation's elements the frame draws in the conversation form. */
const conversationFormElements = [
  'workspace-sidebar',
  'workspace-project-tabs',
];

/** Each tag in `tags` is drawn exactly once in the window. */
const assertMountedOnce = (
  workspace: RenderedWorkspace,
  tags: readonly string[],
): void => {
  assert.deepEqual(
    Object.fromEntries(
      tags.map((tag) => [tag, workspace.root.querySelectorAll(tag).length]),
    ),
    Object.fromEntries(tags.map((tag) => [tag, 1])),
    'The navigation elements are not each drawn once.',
  );
};

// O1: the Projects load (`use-workspace.ts`'s mount effect) runs once per
// window, in `workspace-sidebar`, however many navigation elements mount.
test('O1: on /projects the four navigation elements mount and the Projects load once', async () => {
  rendered = await renderWorkspace({
    projects: [project, docs],
    path: '/projects',
  });
  const records: RuntimeRecords = rendered.records;
  const reload = records.reload.bind(records);
  let loads = 0;
  records.reload = (input, call) => {
    if (input.target === 'projects') loads += 1;
    return reload(input, call);
  };

  await rendered.remount();

  assertMountedOnce(rendered, pageFormElements);
  assert.equal(loads, 1, `The window loaded its Projects ${loads} times.`);
});

// O1: following the selected Project runs once per window as well.
test('O1: in a Thread the navigation elements mount and the selected Project is followed once', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    threads: [planThread],
    path: planPath,
  });
  const records: RuntimeRecords = rendered.records;
  const follow = records.follow.bind(records);
  const following = new Set<{ readonly projectId: string }>();
  records.follow = (input, call) => {
    const token = { projectId: input.projectId };
    following.add(token);
    const followed = follow(input, call);
    return {
      dispose: () => {
        following.delete(token);
        followed.dispose();
      },
    };
  };

  await rendered.remount();

  assertMountedOnce(rendered, conversationFormElements);
  assert.deepEqual(
    [...following].map(({ projectId }) => projectId),
    [project.id],
    'The selected Project is not followed exactly once.',
  );
});

// O1: the Project tabs live in a module store, so a Project opened in
// `workspace-dashboard` shows its tab in `workspace-project-tabs`, and the tab stays
// when the frame changes form.
test('O1: a Project opened in workspace-dashboard gets its tab in workspace-project-tabs, and keeps it when the forms switch', async () => {
  rendered = await renderWorkspace({
    projects: [project, docs],
    path: '/projects',
  });
  const content = single(rendered.root, 'workspace-dashboard');
  const [entry] = [...content.querySelectorAll<HTMLElement>('button')]
    .filter((button) => normalized(button.textContent).includes(docs.name))
    .filter((button) => !button.hasAttribute('aria-label'));
  assert.ok(
    entry !== undefined,
    'workspace-dashboard does not list Docs site.',
  );

  await click(entry);

  assert.equal(pathOf(rendered), `/projects/${docs.id}`);
  const tabs = single(rendered.root, 'workspace-project-tabs');
  assert.ok(
    isCurrent(only(tabs, 'button[aria-label]', docs.name)),
    'The Docs site tab in workspace-project-tabs is not the current one.',
  );

  rendered.services.use(NavigationV1).navigate('/projects');
  await settle();

  assert.equal(rendered.root.querySelectorAll('workspace-dashboard').length, 1);
  only(
    single(rendered.root, 'workspace-project-tabs'),
    'button[aria-label]',
    docs.name,
  );
});
