// The workspace shell, read the way a reader meets it.
// - T-2.1, S10: after phase 2 removed the global footer, neither the Project
//   view nor the Dashboard renders it, so nothing draws the
//   `layout.global-footer` region.
// - T-2.9: the behaviors that must survive the phase 2 rebuild of the window
//   (spec §2.1–2.6). They name what the reader sees (roles, accessible names,
//   text) and where the window is (its path), never the shell's structure,
//   and they stay out of what the rebuild changes: the Home tab, the global
//   footer, and where `ProjectPanelTabs` and the account status sit.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { NavigationV1 } from 'bundle/contracts';

import { INSET_CARD } from '../../src/client/components/templates/inset-card.js';
import type { Project, Thread } from '../../src/client/domain/workspace.js';
import { LayoutTabsV1 } from '../../src/contracts/index.js';
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

for (const path of [`/projects/${project.id}`, '/projects']) {
  test(`the workspace at ${path} renders no global footer`, async () => {
    rendered = await renderWorkspace({ projects: [project], path });

    // A count, not the element: inspecting a happy-dom node on failure
    // walks its whole window.
    assert.equal(
      rendered.root.querySelectorAll('[data-slot="workspace-global-footer"]')
        .length,
      0,
      'The global footer is still rendered.',
    );
  });
}

// T-2.9.1
test('selecting a Thread in the tree opens its route and shows its conversation', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    threads: [planThread, formThread],
    path: `/projects/${project.id}`,
  });
  // Opening the Project opens its main Thread, Plan, so Form is not shown yet.
  assert.ok(
    !standIns(rendered.root, 'chat-thread').some((element) =>
      normalized(element.textContent).includes(
        `Conversation: ${formThread.name}`,
      ),
    ),
    'Form is shown before it is selected.',
  );

  await click(only(rendered.root, '[role="treeitem"]', formThread.name));

  assert.equal(
    pathOf(rendered),
    `/projects/${project.id}/threads/${formThread.id}`,
  );
  const conversations = standIns(rendered.root, 'chat-thread');
  assert.equal(conversations.length, 1, 'No single conversation is shown.');
  assert.ok(
    normalized(conversations[0]?.textContent).includes(
      `Conversation: ${formThread.name}`,
    ),
    `The conversation is not Form's: ${normalized(conversations[0]?.textContent)}`,
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

/** The viewer's stand-ins for the files it shows, by what each reads. */
const shownFiles = (workspace: RenderedWorkspace): string[] =>
  standIns(workspace.root, 'files-viewer')
    .filter((element) => element.closest('[hidden]') === null)
    .map((element) => normalized(element.textContent));

// T-2.9.5. The viewer is already open on one file here; opening the first
// file, which adds the viewer's panel to a mounted group, is covered by
// "opening the first file shows the viewer" (render-workspace.ts stands in
// the `offsetLeft` react-resizable-panels orders panels by).
test('a file opened through layout.tabs/v1 gets a viewer tab and shows; closing the last tab removes the viewer', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    path: `/projects/${project.id}`,
    tabs: {
      [`project:${project.id}`]: [
        {
          id: 'file:README.md',
          title: 'README.md',
          tag: 'files-viewer',
          props: { path: 'README.md' },
          icon: 'file',
        },
      ],
    },
  });

  await rendered.services.use(LayoutTabsV1).open({
    id: 'file:src/index.ts',
    title: 'index.ts',
    tag: 'files-viewer',
    props: { path: 'src/index.ts' },
    icon: 'file',
  });
  await settle();

  assert.equal(rendered.errors().length, 0, 'Opening the file failed.');
  const tab = only(rendered.root, '[role="tab"]', 'index.ts');
  assert.equal(tab.getAttribute('aria-selected'), 'true');
  const shown = shownFiles(rendered);
  assert.ok(
    shown.length === 1 && shown[0]?.includes('src/index.ts') === true,
    `The viewer does not show src/index.ts alone: ${shown.join(' | ')}`,
  );

  await click(only(rendered.root, 'button', 'Close index.ts'));
  assert.equal(named(rendered.root, '[role="tab"]', 'index.ts').length, 0);
  assert.ok(
    shownFiles(rendered).some((text) => text.includes('README.md')),
    'Closing index.ts did not show README.md again.',
  );

  await click(only(rendered.root, 'button', 'Close README.md'));

  assert.equal(rendered.errors().length, 0, 'Closing the last tab failed.');
  assert.equal(named(rendered.root, '[role="tab"]', 'README.md').length, 0);
  assert.equal(
    standIns(rendered.root, 'files-viewer').length,
    0,
    'The viewer is still there after its last tab closed.',
  );
  assert.ok(
    named(rendered.root, '[role="treeitem"], button', 'New thread').length > 0,
    'The Project view is gone with the viewer.',
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

// T-2.9.8
test('the Screens pane renders below the Thread tree with its items', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    threads: [planThread, formThread],
    path: `/projects/${project.id}`,
  });

  const toggle = named(rendered.root, 'button', 'Expand Screens')[0];
  if (toggle !== undefined) await click(toggle);

  const screens = standIns(rendered.root, 'screen-sidebar');
  const [pane] = screens;
  assert.ok(
    screens.length === 1 && pane !== undefined,
    `Expected the Screens pane's items once, found ${screens.length}.`,
  );
  assert.equal(standIns(rendered.root, 'screen-group-action').length, 1);
  const items = [
    ...rendered.root.querySelectorAll<HTMLElement>('[role="treeitem"]'),
  ];
  assert.equal(items.length, 2, 'The Thread tree does not show both Threads.');
  assert.ok(
    items.every((item) => follows(item, pane)),
    'The Screens pane is not below the Thread tree.',
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

/** A viewer tab on README.md, open under the Project, as T-2.9.5 seeds it. */
const withViewer: LayoutFixture = {
  projects: [project],
  path: `/projects/${project.id}`,
  tabs: {
    [`project:${project.id}`]: [
      {
        id: 'file:README.md',
        title: 'README.md',
        tag: 'files-viewer',
        props: { path: 'README.md' },
        icon: 'file',
      },
    ],
  },
};

const conversationCard = (workspace: RenderedWorkspace): HTMLElement =>
  single(workspace.root, 'main[data-slot="sidebar-inset"]');

const tabBar = (workspace: RenderedWorkspace): HTMLElement =>
  single(workspace.root, 'nav[aria-label="Workspace tabs"]');

// T-2.13
test('the workspace canvas is the sidebar fill', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    path: `/projects/${project.id}`,
  });

  const layout = single(rendered.root, '[data-slot="workspace-layout"]');
  assert.ok(
    layout.classList.contains('bg-sidebar'),
    `The workspace layout is not on the sidebar canvas: ${layout.className}`,
  );
});

// T-2.13
test('the conversation is drawn as an inset card', async () => {
  const classes = INSET_CARD;
  rendered = await renderWorkspace({
    projects: [project],
    path: `/projects/${project.id}`,
  });

  assert.deepEqual(
    missingClasses(conversationCard(rendered), classes),
    [],
    'The conversation card lacks INSET_CARD classes.',
  );
});

// T-2.13
test('an open viewer is drawn as an inset card', async () => {
  const classes = INSET_CARD;
  rendered = await renderWorkspace(withViewer);

  const viewer = single(rendered.root, 'section[aria-label="Viewer"]');
  assert.deepEqual(
    missingClasses(viewer, classes),
    [],
    'The viewer card lacks INSET_CARD classes.',
  );
});

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

// One header row: the tab bar keeps "New project", and its right end holds
// the `layout.header` items. While the Files column is open the account
// status sits in the Files header (contracts 2d-2 §2.3, S27).
test('the tab bar keeps New project and ends with the header items; Account is in the open Files header', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    projectTabs: [project],
    path: `/projects/${project.id}`,
    regions: {
      'layout.header': [{ id: 'header-probe', tag: 'header-probe', order: 10 }],
    },
  });

  const bar = tabBar(rendered);
  only(bar, 'button', 'New project');
  const end = single(bar, '[data-slot="project-tab-actions"]');
  only(
    single(rendered.root, '[data-slot="workspace-files-header"]'),
    'button',
    'Account',
  );
  assert.equal(
    standIns(end, 'header-probe').length,
    1,
    'The layout.header item is not at the tab bar right end.',
  );
});

// G12, T-2.9.9 (band) and the layout half of T-2.5
test('the conversation footer band is regular weight, borderless and draws layout.footer', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    path: `/projects/${project.id}`,
    regions: {
      'layout.footer': [{ id: 'footer-probe', tag: 'footer-probe', order: 10 }],
    },
  });

  const footer = single(rendered.root, '[data-slot="workspace-footer"]');
  assert.ok(
    footer.classList.contains('font-normal') &&
      !footer.classList.contains('font-light'),
    `The footer band is not regular weight: ${footer.className}`,
  );
  assert.ok(
    !footer.classList.contains('border-t'),
    'The footer band has a top border.',
  );
  assert.equal(
    standIns(footer, 'footer-probe').length,
    1,
    'The layout.footer item is not in the footer band.',
  );
});

// G1: the handle between the conversation and the viewer is invisible and
// full height. Without layout in happy-dom, its classes are the only witness.
test('the handle before the viewer is a full-height transparent 8 px strip', async () => {
  rendered = await renderWorkspace(withViewer);

  const card = conversationCard(rendered);
  const [shown] = standIns(rendered.root, 'files-viewer');
  assert.ok(shown !== undefined, 'The viewer is not open.');
  const handle = [
    ...rendered.root.querySelectorAll<HTMLElement>(
      '[data-slot="resizable-handle"]',
    ),
  ]
    .filter((element) => !card.contains(element))
    .filter((element) => follows(card, element) && follows(element, shown))
    .at(-1);
  assert.ok(handle !== undefined, 'No handle between conversation and viewer.');
  assert.ok(
    !handle.classList.contains('-mt-10'),
    'The viewer handle still reaches up into the header row (-mt-10).',
  );
  assert.deepEqual(missingClasses(handle, 'bg-transparent w-2'), []);
});

// Contracts 2d-1 §1.8: the stale header organism is gone.
test('the old workspace header organism is deleted', () => {
  // The compiled test runs from `dist-tests/tests/client`; three levels up is
  // the bundle's root in the repository.
  const source = (path: string): string =>
    fileURLToPath(new URL(`../../../src/client/${path}`, import.meta.url));
  assert.ok(
    existsSync(source('components/organisms/project-tabs.tsx')),
    'The bundle source is not where this test looks.',
  );

  assert.equal(
    existsSync(source('components/organisms/workspace-header.tsx')),
    false,
    'workspace-header.tsx still exists.',
  );
});

// T-2.9.5 for the first file: before 2d-1, happy-dom's run of
// react-resizable-panels threw "Panel constraints not found" here.
test('opening the first file shows the viewer', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    path: `/projects/${project.id}`,
  });
  assert.equal(
    rendered.root.querySelectorAll('section[aria-label="Viewer"]').length,
    0,
    'A viewer is open before any file is.',
  );

  await rendered.services.use(LayoutTabsV1).open({
    id: 'file:README.md',
    title: 'README.md',
    tag: 'files-viewer',
    props: { path: 'README.md' },
    icon: 'file',
  });
  await settle();

  assert.deepEqual(
    rendered.errors().map((error) => String(error)),
    [],
    'Opening the first file failed.',
  );
  const viewer = single(rendered.root, 'section[aria-label="Viewer"]');
  assert.ok(
    standIns(viewer, 'files-viewer').some((element) =>
      normalized(element.textContent).includes('README.md'),
    ),
    'The viewer does not show README.md.',
  );
});

// Phase 2d-2: the Files column gets its own header and footer (spec §2.6,
// S9, S27; contracts 2d-2 §2.3–2.6). The header holds the view controls
// ("Project views"), the "Hide files" toggle and the account status while the
// column is open; collapsed, the toggle ("Show files") and the account status
// move to the tab bar's right end, after the `layout.header` items. The
// toggle is the stories' `<files-toggle>` stand-in (G6, story-elements.ts).

/** The Project views the app's `layout.panel` region lists (fake-host.ts). */
const panelViews = [
  {
    id: 'files',
    tag: 'files-tree',
    order: 100,
    props: { label: 'Files', icon: 'files' },
  },
  {
    id: 'changes',
    tag: 'git-changes',
    order: 200,
    props: { label: 'Changes', icon: 'file-diff' },
  },
];

/** A Project view with the panel's views and one `layout.header` item. */
const withHeaderItems = (fixture: LayoutFixture): LayoutFixture => ({
  ...fixture,
  regions: {
    'layout.panel': panelViews,
    'layout.header': [{ id: 'header-probe', tag: 'header-probe', order: 10 }],
  },
});

const filesHeaders = (workspace: RenderedWorkspace): HTMLElement[] => [
  ...workspace.root.querySelectorAll<HTMLElement>(
    '[data-slot="workspace-files-header"]',
  ),
];

const tabBarEnd = (workspace: RenderedWorkspace): HTMLElement =>
  single(tabBar(workspace), '[data-slot="project-tab-actions"]');

/** Whether `root` holds the "Project views" controls, Files and Changes. */
const holdsProjectViews = (root: ParentNode): boolean =>
  root.querySelectorAll('[aria-label="Project views"]').length === 1 &&
  named(root, '[aria-label]', 'Files').length === 1 &&
  named(root, '[aria-label]', 'Changes').length === 1;

/** Asserts that the window has exactly one "Account" button. */
const oneAccount = (workspace: RenderedWorkspace, when: string): void => {
  const accounts = named(workspace.root, 'button', 'Account');
  assert.equal(
    accounts.length,
    1,
    `${when}: the window has ${accounts.length} "Account" buttons.`,
  );
};

// T-2.5, layout half
test('layout.panel.footer items render in the Files footer, layout.footer items in the conversation band', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    path: `/projects/${project.id}`,
    regions: {
      'layout.panel.footer': [
        { id: 'panel-footer-probe', tag: 'panel-footer-probe', order: 10 },
      ],
      'layout.footer': [{ id: 'footer-probe', tag: 'footer-probe', order: 10 }],
    },
  });

  const filesFooter = single(
    rendered.root,
    '[data-slot="workspace-files-footer"]',
  );
  assert.equal(
    standIns(filesFooter, 'panel-footer-probe').length,
    1,
    'The layout.panel.footer item is not in the Files footer.',
  );
  assert.equal(
    standIns(filesFooter, 'footer-probe').length,
    0,
    'The layout.footer item is in the Files footer.',
  );
  const band = single(rendered.root, '[data-slot="workspace-footer"]');
  assert.equal(
    standIns(band, 'footer-probe').length,
    1,
    'The layout.footer item is not in the conversation band.',
  );
  assert.equal(
    standIns(band, 'panel-footer-probe').length,
    0,
    'The layout.panel.footer item is in the conversation band.',
  );
});

// §2.6, S27: the open Files column's header
test('the open Files header holds the Project views, Hide files and Account; the tab bar holds neither', async () => {
  rendered = await renderWorkspace(
    withHeaderItems({
      projects: [project],
      projectTabs: [project],
      path: `/projects/${project.id}`,
    }),
  );

  const header = single(rendered.root, '[data-slot="workspace-files-header"]');
  assert.ok(
    holdsProjectViews(header),
    `The Files header lacks the Project views; it names: ${[
      ...header.querySelectorAll('[aria-label]'),
    ]
      .map(nameOf)
      .join(' | ')}`,
  );
  only(header, 'button', 'Hide files');
  only(header, 'button', 'Account');

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
    'The layout.header item left the tab bar.',
  );
});

// T-2.6, S27; with a viewer tab open too (G17)
for (const [label, fixture] of [
  [
    'without a viewer',
    {
      projects: [project],
      projectTabs: [project],
      path: `/projects/${project.id}`,
    },
  ],
  ['with a viewer tab open', { ...withViewer, projectTabs: [project] }],
] as const) {
  test(`hiding and showing Files moves its toggle and Account between the Files header and the tab bar, ${label}`, async () => {
    rendered = await renderWorkspace(withHeaderItems(fixture));
    oneAccount(rendered, 'Files open');

    const header = single(
      rendered.root,
      '[data-slot="workspace-files-header"]',
    );
    await click(only(header, 'button', 'Hide files'));

    assert.equal(rendered.errors().length, 0, 'Hiding Files failed.');
    assert.equal(
      filesHeaders(rendered).length,
      0,
      'The Files header is still shown after Hide files.',
    );
    oneAccount(rendered, 'Files hidden');
    const end = tabBarEnd(rendered);
    const [probe] = standIns(end, 'header-probe');
    assert.ok(probe !== undefined, 'The layout.header item left the tab bar.');
    const show = only(end, 'button', 'Show files');
    const account = only(end, 'button', 'Account');
    assert.ok(
      follows(probe, show) && follows(probe, account),
      'Show files and Account do not come after the layout.header items.',
    );

    await click(show);

    assert.equal(rendered.errors().length, 0, 'Showing Files failed.');
    const reopened = single(
      rendered.root,
      '[data-slot="workspace-files-header"]',
    );
    only(reopened, 'button', 'Hide files');
    only(reopened, 'button', 'Account');
    assert.equal(
      named(tabBarEnd(rendered), 'button', 'Show files').length +
        named(tabBarEnd(rendered), 'button', 'Account').length,
      0,
      'Show files or Account stayed in the tab bar after Show files.',
    );
    oneAccount(rendered, 'Files shown again');
  });
}
