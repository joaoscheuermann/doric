// The Dashboard after phase 2e (spec §2.8, T-2.7; contracts 2e §3, §5):
// - on `/projects` (and `/` at startup) the Dashboard sidebar is 280 px wide
//   and starts with the sidebar header's "Dashboard" button above "Search
//   projects"; "All settings" stays in its footer;
// - the Project tab bar, with the account status at its right end, is the top
//   row of the content column, not of the window, and it holds no
//   `layout.header` item (G13);
// - the home body (`/` reached through "New project", Figma `85:7726`) shows
//   the same Dashboard sidebar with no row selected, so no Dashboard form
//   keeps the macOS inset in the tab bar (UR1 over G3);
// - every form draws its content in an inset card (S34) and marks the
//   sidebar header's Dashboard button as the current page;
// - the sidebar search shows its shortcut as two keys (Figma `34:12218`);
// - Ctrl+F focuses the sidebar's search on the list and the home body's
//   own search on the home body (S13).

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { NavigationV1 } from 'bundle/contracts';

import { INSET_CARD } from '../../src/client/components/templates/inset-card.js';
import { searchShortcutKeys } from '../../src/client/domain/dashboard.js';
import type { Project } from '../../src/client/domain/workspace.js';
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

const follows = (earlier: Node, later: Node): boolean =>
  (earlier.compareDocumentPosition(later) &
    Node.DOCUMENT_POSITION_FOLLOWING) !==
  0;

const pathOf = (workspace: RenderedWorkspace): string | undefined =>
  workspace.services.use(NavigationV1).current()?.path;

const ASIDE = 'aside[aria-label="Dashboard navigation"]';
const TAB_BAR = 'nav[aria-label="Workspace tabs"]';
const SEARCH = 'input[aria-label="Search projects"]';
/** The tab bar's left padding: the macOS inset, else 8 px, else none. */
const INSET = ['pl-[var(--doric-safe-left,80px)]', 'pl-[8px]'];

const probe = { id: 'header-probe', tag: 'header-probe', order: 10 };

/** The three forms of the Dashboard and how each is reached. */
const forms = {
  '/projects': { path: '/projects', newTab: false },
  '/ at startup': { path: '/', newTab: false },
  '/ through New project': { path: '/projects', newTab: true },
} as const;
type Form = keyof typeof forms;

/** Renders the Dashboard in `form`, with a `layout.header` item seeded. */
const renderDashboard = async (form: Form): Promise<RenderedWorkspace> => {
  const { path, newTab } = forms[form];
  const fixture: LayoutFixture = {
    projects: [project],
    path,
    regions: { 'layout.header': [probe] },
  };
  const workspace = await renderWorkspace(fixture);
  if (newTab) {
    only(single(workspace.root, TAB_BAR), 'button', 'New project').click();
    await settle();
    assert.equal(pathOf(workspace), '/', 'New project did not open /.');
  }
  assert.equal(workspace.errors().length, 0, `Opening ${form} failed.`);
  return workspace;
};

/** Presses Ctrl+F as happy-dom delivers it: a keydown on the document. */
const pressCtrlF = async (): Promise<void> => {
  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  await settle();
};

// T-2.7: the Dashboard sidebar is 280 px wide
test('on /projects the Dashboard sidebar is 280 px wide', async () => {
  rendered = await renderDashboard('/projects');

  const sidebar = single(rendered.root, `${ASIDE} [data-slot="sidebar"]`);
  assert.ok(
    sidebar.classList.contains('w-[280px]'),
    `The Dashboard sidebar is not 280 px wide: ${sidebar.className}`,
  );
});

// T-2.7: the sidebar header's Dashboard button heads the Dashboard sidebar
for (const form of Object.keys(forms) as Form[]) {
  test(`on ${form} the Dashboard button precedes Search projects in the sidebar, and All settings stays`, async () => {
    rendered = await renderDashboard(form);

    const aside = single(rendered.root, ASIDE);
    const header = single(aside, '[data-slot="workspace-sidebar-header"]');
    const dashboard = only(header, 'button', 'Dashboard');
    const search = single(aside, SEARCH);
    assert.ok(
      follows(dashboard, search),
      'The Dashboard button does not come before Search projects.',
    );
    only(aside, 'button', 'All settings');
  });
}

// T-2.7, S13: Ctrl+F focuses the sidebar's search
test("on /projects Ctrl+F focuses the sidebar's Search projects field", async () => {
  rendered = await renderDashboard('/projects');

  const search = single(single(rendered.root, ASIDE), SEARCH);
  assert.ok(document.activeElement !== search, 'The search starts focused.');
  await pressCtrlF();

  assert.ok(
    document.activeElement === search,
    'Ctrl+F does not focus Search projects.',
  );
});

// §2.8, G4, G13: the tab bar is the content column's top row
for (const form of Object.keys(forms) as Form[]) {
  test(`on ${form} the content column holds the window's one tab bar, which ends with Account and no layout.header item`, async () => {
    rendered = await renderDashboard(form);

    assert.equal(
      rendered.root.querySelectorAll(TAB_BAR).length,
      1,
      'The window has no single tab bar.',
    );
    const content = single(rendered.root, 'div[data-slot="dashboard-content"]');
    const bar = single(content, TAB_BAR);
    const aside = rendered.root.querySelector(ASIDE);
    assert.ok(
      aside === null || !aside.contains(bar),
      'The tab bar is inside the Dashboard sidebar.',
    );
    only(single(bar, '[data-slot="project-tab-actions"]'), 'button', 'Account');
    assert.equal(
      rendered.root.querySelectorAll('[data-story-placeholder="header-probe"]')
        .length,
      0,
      'A layout.header item shows on the Dashboard.',
    );
  });
}

/** The sidebar rows drawn as selected. */
const selectedRows = (aside: ParentNode): string[] =>
  [...aside.querySelectorAll('[data-sidebar="menu-button"][data-active]')].map(
    nameOf,
  );

// UR1, Figma `85:7726`: the home body shows the Dashboard sidebar, no row
// selected; its own search still takes Ctrl+F
test('on / through New project the Dashboard sidebar shows with no row selected, and Ctrl+F focuses the home Search projects field', async () => {
  rendered = await renderDashboard('/ through New project');

  const aside = single(rendered.root, ASIDE);
  single(aside, SEARCH);
  only(aside, 'button', 'All projects');
  assert.deepEqual(selectedRows(aside), [], 'A sidebar row is selected on /.');
  const content = single(rendered.root, 'div[data-slot="dashboard-content"]');
  const search = single(content, SEARCH);
  await pressCtrlF();

  assert.ok(
    document.activeElement === search,
    'Ctrl+F does not focus the home Search projects field.',
  );
});

// `85:7520`: All projects is the selected row on the list
test('on /projects All projects is the one selected sidebar row', async () => {
  rendered = await renderDashboard('/projects');

  assert.deepEqual(selectedRows(single(rendered.root, ASIDE)), [
    'All projects',
  ]);
});

// G3, UR1: every Dashboard form has the sidebar before the tab bar, so none
// keeps the macOS inset
for (const [form, inset] of [
  ['/ through New project', false],
  ['/projects', false],
  ['/ at startup', false],
] as const) {
  test(`on ${form} the tab bar ${inset ? 'keeps' : 'has no'} left inset`, async () => {
    rendered = await renderDashboard(form);

    const bar = single(rendered.root, TAB_BAR);
    const insetClasses = INSET.filter((name) => bar.classList.contains(name));
    if (inset) {
      assert.ok(
        insetClasses.length === 1 && !bar.classList.contains('pl-0'),
        `The home body's tab bar has no left inset: ${bar.className}`,
      );
    } else {
      assert.ok(
        insetClasses.length === 0 && bar.classList.contains('pl-0'),
        `The tab bar beside the sidebar keeps a left inset: ${bar.className}`,
      );
    }
  });
}

// T-2.7, G3: "New project" from /projects opens the home body even though the
// core outlet mounts a new `layout-workspace` for `/` (the route pattern
// changes from `/projects`, `core/src/client/elements/outlet.ts:3-4`); the
// doric-e2e harness found All projects there instead.
test('New project on /projects opens the home body after the outlet remounts the workspace for /', async () => {
  rendered = await renderDashboard('/projects');
  only(single(rendered.root, TAB_BAR), 'button', 'New project').click();
  await settle();
  assert.equal(pathOf(rendered), '/', 'New project did not open /.');

  await rendered.remount();

  assert.equal(pathOf(rendered), '/', 'The remount left /.');
  assert.equal(rendered.errors().length, 0, 'The remounted view failed.');
  const content = single(rendered.root, 'div[data-slot="dashboard-content"]');
  only(content, 'button', 'Browse all projects');
  assert.equal(
    content.querySelectorAll(SEARCH).length,
    1,
    "The remounted / has no home body's Search projects field.",
  );
  assert.deepEqual(
    selectedRows(single(rendered.root, ASIDE)),
    [],
    'The remounted / shows All projects, not the home body.',
  );
});

// S34, UR1 (`85:7726`, `85:7520`): the content is an inset card on the
// sidebar canvas, with no padding of its own and the right and bottom insets
const CARD = 'div[data-slot="dashboard-content"] [data-slot="dashboard-card"]';
const cardClasses = `${INSET_CARD.replace(/\bp-2\b/, 'p-0')} mr-2 mb-2`;
for (const form of Object.keys(forms) as Form[]) {
  test(`on ${form} the content is an inset card with no left border`, async () => {
    rendered = await renderDashboard(form);

    const card = single(rendered.root, CARD);
    const missing = cardClasses
      .split(/\s+/)
      .filter((name) => name !== '' && !card.classList.contains(name));
    assert.deepEqual(missing, [], `The card lacks classes: ${card.className}`);
    const content = single(rendered.root, 'div[data-slot="dashboard-content"]');
    assert.ok(
      content.classList.contains('bg-sidebar'),
      `The content column is not on the sidebar canvas: ${content.className}`,
    );
    assert.equal(
      content.querySelectorAll('.border-l').length,
      0,
      'The Dashboard content keeps a left border.',
    );
  });
}

// UR1, Figma `256:20963` (Dashboard=Active): the Dashboard button shows it is
// the current page on every Dashboard form
for (const form of Object.keys(forms) as Form[]) {
  test(`on ${form} the Dashboard button is the current page`, async () => {
    rendered = await renderDashboard(form);

    const header = single(
      rendered.root,
      '[data-slot="workspace-sidebar-header"]',
    );
    const button = only(header, 'button', 'Dashboard');
    assert.equal(button.getAttribute('aria-current'), 'page');
    assert.ok(
      button.hasAttribute('data-active'),
      'The Dashboard button has no data-active.',
    );
  });
}

// Figma `34:12218`: the sidebar search's shortcut is two keys
test('the sidebar search shows its shortcut as two keys', async () => {
  rendered = await renderDashboard('/projects');

  const aside = single(rendered.root, ASIDE);
  const keys = [...aside.querySelectorAll('[data-slot="kbd"]')].map((key) =>
    normalized(key.textContent),
  );
  assert.deepEqual(keys, [...searchShortcutKeys(navigator.platform)]);
});

// `85:7520`: the table's four columns share the width equally, and the
// header and rows line up with the page title (no overhang)
test('on /projects the four table columns are equal and the table aligns with the title', async () => {
  rendered = await renderDashboard('/projects');

  const content = single(rendered.root, 'div[data-slot="dashboard-content"]');
  const header = single(content, '[data-slot="dashboard-columns"]');
  const cells = [...header.children];
  assert.deepEqual(cells.map(nameOf), ['Name', 'Activity', 'Created', 'State']);
  for (const cell of cells) {
    assert.ok(
      cell.classList.contains('flex-1'),
      `Column ${nameOf(cell)} is not flex-1: ${cell.className}`,
    );
  }
  const row = single(content, '[data-project-id]');
  const rowCells = [...single(row, 'button').children];
  assert.equal(rowCells.length, 4, 'A row does not have four cells.');
  for (const cell of rowCells) {
    assert.ok(
      cell.classList.contains('flex-1'),
      `A row cell is not flex-1: ${cell.className}`,
    );
  }
  for (const element of [header, row]) {
    assert.ok(
      !element.classList.contains('-mx-[8px]'),
      `The table overhangs the title: ${element.className}`,
    );
  }
});

// Follow-up to phase 5 (2026-11-11): a project row's button draws a solid paper-focus outline on keyboard focus
test('T-5.20: on /projects a project row button has the solid keyboard focus outline', async () => {
  rendered = await renderDashboard('/projects');

  const content = single(rendered.root, 'div[data-slot="dashboard-content"]');
  const button = single(single(content, '[data-project-id]'), 'button');
  const expected = [
    'outline-none',
    'focus-visible:outline-solid',
    'focus-visible:outline-2',
    'focus-visible:outline-[var(--paper-focus)]',
  ];
  assert.deepEqual(
    expected.filter((name) => !button.classList.contains(name)),
    [],
    `The project row button lacks focus outline classes: ${button.className}`,
  );
});

// Contracts 2e §0.1: `/` reached without "New project" draws All projects.
test('a fresh start on / without New project still shows All projects with the Dashboard sidebar', async () => {
  rendered = await renderDashboard('/ at startup');

  assert.equal(pathOf(rendered), '/', 'The workspace did not start on /.');
  const aside = single(rendered.root, ASIDE);
  assert.equal(
    aside.querySelectorAll(SEARCH).length,
    1,
    "All projects' sidebar has no Search projects field.",
  );
});
