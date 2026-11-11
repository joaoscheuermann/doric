// The workspace shell, read the way a reader meets it.
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
import { existsSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { NavigationV1 } from 'bundle/contracts';

import { INSET_CARD } from '../../src/client/components/templates/inset-card.js';
import type { Project, Thread } from '../../src/client/domain/workspace.js';
import {
  LayoutPanelV2,
  LayoutStackV2,
  LayoutTabsV1,
} from '../../src/contracts/index.js';
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
  // 2e (T-2.8): the Project view's witness is the "New Thread" row; the
  // Threads pane's "New thread" plus it replaces is gone.
  assert.ok(
    named(rendered.root, '[role="treeitem"], button', 'New Thread').length > 0,
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

// One header row: the tab bar keeps "New project", and its right end holds
// the `layout.header` items. The account status sits in the Files header
// (contracts 2d-2 §2.3; part 2i, S36).
test('the tab bar keeps New project and ends with the header items; Account is in the Files header', async () => {
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
  // Figma `99:8035`: the picker and usage labels are `--foreground`; only
  // their "·" separators are muted, and those carry their own class.
  assert.ok(
    !footer.classList.contains('text-muted-foreground'),
    `The footer band mutes its items: ${footer.className}`,
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

// Check 2, item 5 (`99:8508`): the viewer opens with the prototype's 448 px
// card and the conversation takes the rest. happy-dom lays nothing out, so the
// panels report a width that adds up to a 1920 px window while this renders;
// react-resizable-panels then sizes each panel as a share of that width.
test('the viewer opens 448 px wide and the conversation takes the rest', async () => {
  // A first render installs happy-dom's window, whose `HTMLElement` this patches.
  (await renderWorkspace(withViewer)).cleanup();
  const windowWidth = 1920;
  const columns = 4; // sidebar, conversation, viewer, Files
  let owner: object | null = HTMLElement.prototype;
  while (
    owner !== null &&
    Object.getOwnPropertyDescriptor(owner, 'offsetWidth') === undefined
  ) {
    owner = Object.getPrototypeOf(owner);
  }
  const original =
    owner === null
      ? undefined
      : Object.getOwnPropertyDescriptor(owner, 'offsetWidth');
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement): number {
      return this.dataset.panel === undefined ? 0 : windowWidth / columns;
    },
  });
  try {
    rendered = await renderWorkspace(withViewer);

    const card = conversationCard(rendered);
    const viewer = single(rendered.root, 'section[aria-label="Viewer"]');
    const panelOf = (element: HTMLElement): HTMLElement => {
      const panel = element.closest<HTMLElement>('[data-panel]');
      assert.ok(panel !== null, 'The card is not inside a resizable panel.');
      return panel;
    };
    const width = (element: HTMLElement): number =>
      Math.round((Number(panelOf(element).style.flexGrow) / 100) * windowWidth);
    assert.equal(width(viewer), 448, 'The viewer does not open 448 px wide.');
    assert.equal(
      width(card),
      windowWidth - 280 - 448 - 328,
      'The conversation does not take the rest of the window.',
    );
  } finally {
    delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
    if (owner === HTMLElement.prototype && original !== undefined)
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', original);
  }
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
// S9; contracts 2d-2 §2.3–2.6). The header holds the view controls ("Project
// views") and the account status. Part 2i (S36, T-2.17): the column always
// shows; nothing hides or collapses it, and `layout.panel/v2` only selects
// the view it draws.

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

// §2.6, S36: the Files column's header
test('the Files header holds the Project views and Account; the tab bar holds neither', async () => {
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

/** The one Files header; fails if the column draws none or several. */
const filesHeader = (workspace: RenderedWorkspace): HTMLElement => {
  const headers = filesHeaders(workspace);
  const [first] = headers;
  assert.ok(
    headers.length === 1 && first !== undefined,
    `Expected one Files header, found ${headers.length}.`,
  );
  return first;
};

/** Whether the Project view control named `name` is the selected one. */
const isSelectedView = (header: HTMLElement, name: string): boolean =>
  only(header, 'button', name).getAttribute('aria-pressed') === 'true';

// Part 2i, T-2.17 (S36): nothing in the window hides the Files column, so no
// files-toggle is drawn and Account stays in the Files header; with a viewer
// tab open too (G17).
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
  test(`the window draws no files-toggle and one Account button, in the Files header, ${label}`, async () => {
    rendered = await renderWorkspace(withHeaderItems(fixture));

    assert.equal(
      rendered.root.querySelectorAll('files-toggle').length +
        standIns(rendered.root, 'files-toggle').length,
      0,
      'The window draws a files-toggle.',
    );
    for (const name of ['Hide files', 'Show files']) {
      assert.equal(
        named(rendered.root, 'button', name).length,
        0,
        `The window draws a "${name}" button.`,
      );
    }
    oneAccount(rendered, label);
    only(filesHeader(rendered), 'button', 'Account');
  });
}

// T-2.17: `layout.panel/v2` `select` only selects a view; the column stays.
test('layout.panel/v2 select selects the view and the Files column stays', async () => {
  rendered = await renderWorkspace(
    withHeaderItems({
      projects: [project],
      projectTabs: [project],
      path: `/projects/${project.id}`,
      panel: { active: 'changes' },
    }),
  );
  assert.ok(isSelectedView(filesHeader(rendered), 'Changes'));

  rendered.services.use(LayoutPanelV2).select('files');
  await settle();

  assert.equal(rendered.errors().length, 0, 'Selecting Files failed.');
  const header = filesHeader(rendered);
  assert.ok(isSelectedView(header, 'Files'), 'Files is not the selected view.');
  assert.ok(!isSelectedView(header, 'Changes'), 'Changes is still selected.');
  assert.equal(standIns(rendered.root, 'files-tree').length, 1);
  assert.equal(standIns(rendered.root, 'git-changes').length, 0);
  single(rendered.root, '[data-slot="workspace-files-footer"]');
});

// T-2.17, regression guard: choosing a view in the header keeps the column.
test('selecting the Changes tab draws the Changes view and keeps the Files header and footer', async () => {
  rendered = await renderWorkspace(
    withHeaderItems({
      projects: [project],
      projectTabs: [project],
      path: `/projects/${project.id}`,
    }),
  );

  await click(only(filesHeader(rendered), 'button', 'Changes'));

  assert.equal(rendered.errors().length, 0, 'Selecting Changes failed.');
  assert.ok(
    isSelectedView(filesHeader(rendered), 'Changes'),
    'Changes is not the selected view.',
  );
  assert.equal(standIns(rendered.root, 'git-changes').length, 1);
  assert.equal(standIns(rendered.root, 'files-tree').length, 0);
  single(rendered.root, '[data-slot="workspace-files-footer"]');
});

// T-2.17, UR28: without the files bundle `layout.panel` lists only Changes.
// The panel still selects `files`, which no item has, so it draws no view.
test('without the files bundle the Files header holds the Changes tab and Account only', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    projectTabs: [project],
    path: `/projects/${project.id}`,
    regions: {
      'layout.panel': panelViews.filter((view) => view.id === 'changes'),
    },
  });

  const header = filesHeader(rendered);
  only(header, 'button', 'Changes');
  only(header, 'button', 'Account');
  for (const name of ['Files', 'Hide files', 'Show files']) {
    assert.equal(
      named(header, 'button, [aria-label]', name).length,
      0,
      `The Files header holds "${name}".`,
    );
  }
  assert.equal(
    standIns(rendered.root, 'git-changes').length +
      standIns(rendered.root, 'files-tree').length,
    0,
    'The panel draws a view no selected item names.',
  );
});

// T-2.17 (S36), guard: the Files column's handle resizes but never collapses.
test('the Files column cannot be collapsed', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    projectTabs: [project],
    path: `/projects/${project.id}`,
  });

  const handle = [
    ...rendered.root.querySelectorAll<HTMLElement>(
      '[data-slot="resizable-handle"]',
    ),
  ].at(-1);
  assert.ok(handle !== undefined, 'The Files column has no handle.');
  assert.equal(
    handle.getAttribute('aria-disabled'),
    null,
    'The Files column handle is disabled.',
  );
  filesHeader(rendered);
  single(rendered.root, '[data-slot="workspace-files-footer"]');
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

/** The Project sidebar: the `sidebar` slot that holds "Search Threads". */
const projectSidebar = (root: ParentNode): HTMLElement => {
  const sidebar = root
    .querySelector('input[aria-label="Search Threads"]')
    ?.closest<HTMLElement>('[data-slot="sidebar"]');
  assert.ok(sidebar, 'No sidebar holds the "Search Threads" field.');
  return sidebar;
};

/** The stack's pane groups, in document order. */
const paneGroups = (root: ParentNode): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('[data-slot="sidebar-pane"]'),
];

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
test('the column reads search, the Thread tree, the New Thread button, then the panes', async () => {
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
  assert.deepEqual(missingClasses(button, 'w-full bg-secondary'), []);
  const panes = paneGroups(sidebar);
  assert.equal(panes.length, 1, 'The Screens pane has no group.');
  assert.ok(
    panes.every((pane) => follows(button, pane)),
    'A pane is not below the New Thread button.',
  );
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

// T-3.3
test('the stack has no resize handle and no resizable group', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    threads: [planThread, formThread],
    path: `/projects/${project.id}`,
  });
  const sidebar = projectSidebar(rendered.root);

  assert.equal(
    sidebar.querySelectorAll('[data-slot="resizable-handle"]').length,
    0,
    'The sidebar has a resize handle.',
  );
  assert.equal(
    sidebar.querySelectorAll('[data-slot="resizable-panel-group"]').length,
    0,
    'The sidebar has a resizable group.',
  );
});

// T-3.3, T-3.5: the Screens pane sits at the bottom with its header, and
// collapses to it.
test('the Screens pane sits at the bottom with its header, and collapses to it', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    threads: [planThread, formThread],
    path: `/projects/${project.id}`,
  });
  const sidebar = projectSidebar(rendered.root);
  const [pane] = paneGroups(sidebar);
  assert.ok(pane, 'The Screens pane has no group.');
  assert.equal(pane.getAttribute('data-pane-id'), 'screen-sidebar');
  const region = single(sidebar, '[data-slot="thread-region"]');
  assert.ok(
    !region.contains(pane) && follows(region, pane),
    'The Screens pane is not below the Thread region.',
  );
  assert.ok(
    [...sidebar.querySelectorAll('*')].every(
      (element) =>
        pane.contains(element) ||
        element.contains(pane) ||
        !follows(pane, element),
    ),
    'Something in the sidebar is below the Screens pane.',
  );
  assert.ok(
    pane.textContent?.includes('Screens'),
    'The Screens pane has no title.',
  );
  assert.equal(standIns(pane, 'screen-group-action').length, 1);

  await click(only(pane, 'button', 'Expand Screens'));
  assert.equal(standIns(pane, 'screen-sidebar').length, 1);

  await click(only(pane, 'button', 'Collapse Screens'));
  assert.equal(
    standIns(rendered.root, 'screen-sidebar').length,
    0,
    'Collapsing Screens keeps its content.',
  );
  assert.ok(
    pane.isConnected && pane.textContent?.includes('Screens'),
    'Collapsing Screens removes its header.',
  );

  await click(only(pane, 'button', 'Expand Screens'));
  assert.equal(standIns(pane, 'screen-sidebar').length, 1);
});

// T-3.4
test('a pane is capped at 40% and keeps its header; the Thread region keeps 40 px and the button', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    threads: [planThread, formThread],
    path: `/projects/${project.id}`,
  });
  const sidebar = projectSidebar(rendered.root);
  const panes = paneGroups(sidebar);
  assert.equal(panes.length, 1, 'The Screens pane has no group.');
  for (const pane of panes)
    assert.deepEqual(missingClasses(pane, 'max-h-[40%] min-h-7'), []);

  const [pane] = panes;
  assert.ok(pane);
  await click(only(pane, 'button', 'Expand Screens'));
  const content = single(pane, '[data-slot="sidebar-group-content"]');
  assert.deepEqual(missingClasses(content, 'min-h-0 overflow-y-auto'), []);

  const region = single(sidebar, '[data-slot="thread-region"]');
  assert.deepEqual(missingClasses(region, 'flex-1 min-h-10'), []);
  const tree = threadTree(region);
  assert.deepEqual(missingClasses(tree, 'min-h-0 overflow-y-auto'), []);
  const button = only(region, 'button', 'New Thread');
  assert.deepEqual(missingClasses(button, 'shrink-0'), []);
  assert.equal(button.hidden, false, 'New Thread is hidden.');
  assert.ok(
    !button.classList.contains('hidden'),
    'New Thread is hidden by its classes.',
  );
});

// Sidebar alignment (spec: docs/designs/sidebar-alignment.md §9.5,
// pane headers): the pane header's action is revealed
// only while the header is hovered or holds focus, as a Thread row's are.
test('a pane header reveals its action only while it is hovered or holds focus', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    threads: [planThread, formThread],
    path: `/projects/${project.id}`,
  });
  const [pane] = paneGroups(projectSidebar(rendered.root));
  assert.ok(pane, 'The Screens pane has no group.');
  const label = single(pane, '[data-slot="sidebar-group-label"]');
  const header = label.parentElement;
  assert.ok(header !== null, 'The pane label has no header wrapper.');
  assert.deepEqual(
    missingClasses(header, 'group/pane-header relative shrink-0'),
    [],
  );

  const [action] = standIns(pane, 'screen-group-action');
  assert.ok(action, 'The Screens pane has no header action.');
  // The reveal sits on the action's own wrapper, a child of the header; the
  // element host (`ElementHost`, `display: contents`) may sit between them.
  let wrapper: HTMLElement | null = action.parentElement;
  while (
    wrapper !== null &&
    wrapper !== header &&
    wrapper.parentElement !== header
  )
    wrapper = wrapper.parentElement;
  assert.ok(
    wrapper !== null && wrapper !== header,
    'The header action is not inside the pane header.',
  );
  assert.deepEqual(
    missingClasses(
      wrapper,
      'pointer-events-none opacity-0 group-hover/pane-header:opacity-100 group-hover/pane-header:pointer-events-auto group-focus-within/pane-header:opacity-100 group-focus-within/pane-header:pointer-events-auto',
    ),
    [],
    'The header action is not revealed on the header hover or focus.',
  );
  assert.equal(wrapper.parentElement, header);
});

// T-3.5
test('layout.stack/v2 lists only the registered panes, with no Threads pane', async () => {
  rendered = await renderWorkspace({
    projects: [project],
    threads: [planThread, formThread],
    path: `/projects/${project.id}`,
  });

  assert.deepEqual(
    rendered.services
      .use(LayoutStackV2)
      .panes()
      .map((pane: { readonly id: string }) => pane.id),
    ['screen-sidebar'],
  );
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

/**
 * The workspace at Plan with a conversation tab on each of `threads`, named by
 * the Project `projectId` (Checkout redesign unless a case says otherwise).
 */
const withThreadTabs = (
  threads: readonly Thread[],
  projectId: string = project.id,
): LayoutFixture => ({
  projects: [project],
  threads: [planThread, untitledThread],
  path: `/projects/${project.id}/threads/${planThread.id}`,
  tabs: {
    [planThread.id]: threads.map((tabThread) => ({
      id: `thread:${tabThread.id}`,
      title: tabThread.name || 'Untitled',
      tag: 'chat-thread-panel',
      icon: 'thread' as const,
      props: { projectId, threadId: tabThread.id },
    })),
  },
});

test("T-1.5: an Untitled Thread's tab wears the Untitled icon", async () => {
  rendered = await renderWorkspace(withThreadTabs([untitledThread]));

  const tab = only(rendered.root, '[role="tab"]', 'Untitled');
  assert.equal(
    tab.querySelectorAll('svg.lucide-message-circle-dashed').length,
    1,
    'The Untitled tab does not wear the Untitled icon.',
  );
});

test('T-1.5: the tab of a Thread missing from the tree keeps the main bubble', async () => {
  // The tab names a Thread of Docs site, a Project whose Threads the window
  // never loaded: the tab stays open, and the tree cannot say what it is.
  const missing = thread('1f3b5d7f-9a1c-4e3b-8d5f-7a9c1e3b5d7f', 'Gone');
  rendered = await renderWorkspace(withThreadTabs([missing], docs.id));

  const tab = only(rendered.root, '[role="tab"]', 'Gone');
  assert.equal(
    tab.querySelectorAll('svg.lucide-message-circle').length,
    1,
    'The tab of a missing Thread does not wear the main bubble.',
  );
  assert.equal(
    tab.querySelectorAll('svg.lucide-message-circle-dashed').length,
    0,
    'The tab of a missing Thread wears the Untitled icon.',
  );
});
