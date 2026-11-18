// The Dashboard after phase 2e (spec §2.8, T-2.7; contracts 2e §3, §5), as
// `workspace` draws it since bundle isolation 4(c) (moved from the layout's
// `tests/client/dashboard-shell.test.ts`; the frame's 280 px column and the
// content column's canvas stayed there). The elements mount in the shell's
// slots as `renderWorkspace` mounts them:
// - `workspace-sidebar` starts with the sidebar header's "Dashboard" button
//   above "Search projects"; `workspace-sidebar-footer` draws the data items
//   of `workspace.dashboard.footer` (T4.8): a button per item, its icon
//   element before its label, executing its command with its input once per
//   pick; a malformed item is not drawn and is reported once (`:762`);
// - the Project tab bar ends with the `shell.window.actions` region on the
//   Dashboard and holds no `shell.header.actions` item (G13, decision O1);
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

import { NavigationV1, RegionsV1 } from 'bundle/contracts';

import { searchShortcutKeys } from '../../src/client/domain/dashboard.js';
import type { Project } from '../../src/client/domain/workspace.js';
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

/** The elements of the shell's slots, each in its own container. */
const ASIDE = '[data-slot-name="shell.sidebar"]';
const FOOTER = '[data-slot-name="shell.sidebar.footer"]';
const CONTENT = '[data-slot-name="shell.page"]';
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

/** Renders the Dashboard in `form`, with a `shell.header.actions` item seeded. */
const renderDashboard = async (form: Form): Promise<RenderedWorkspace> => {
  const { path, newTab } = forms[form];
  const fixture: WorkspaceFixture = {
    projects: [project],
    path,
    regions: { 'shell.header.actions': [probe] },
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

// T-2.7: the sidebar header's Dashboard button heads the Dashboard sidebar
for (const form of Object.keys(forms) as Form[]) {
  test(`on ${form} the Dashboard button precedes Search projects in the sidebar`, async () => {
    rendered = await renderDashboard(form);

    const aside = single(rendered.root, ASIDE);
    const header = single(aside, '[data-slot="workspace-sidebar-header"]');
    const dashboard = only(header, 'button', 'Dashboard');
    const search = single(aside, SEARCH);
    assert.ok(
      follows(dashboard, search),
      'The Dashboard button does not come before Search projects.',
    );
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

// §2.8, G13, decision O1: on the Dashboard the tab bar ends with the
// `shell.window.actions` region, which `workspace-project-tabs` writes, and
// holds no `shell.header.actions` item.
for (const form of Object.keys(forms) as Form[]) {
  test(`on ${form} the window's one tab bar ends with the shell.window.actions region and no shell.header.actions item`, async () => {
    rendered = await renderDashboard(form);

    const bar = single(rendered.root, TAB_BAR);
    const end = single(bar, '[data-slot="project-tab-actions"]');
    single(end, 'core-region[name="shell.window.actions"]');
    assert.equal(
      end.querySelectorAll('core-region[name="shell.header.actions"]').length,
      0,
      'The Dashboard tab bar writes the shell.header.actions region.',
    );
    assert.equal(
      rendered.root.querySelectorAll('[data-story-placeholder="header-probe"]')
        .length,
      0,
      'A shell.header.actions item shows on the Dashboard.',
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
  const content = single(rendered.root, CONTENT);
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
  const content = single(rendered.root, CONTENT);
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

// S34, UR1 (`85:7726`, `85:7520`): the Dashboard draws its content as an
// inset card with no padding of its own and the right and bottom insets, and
// with no left border; the canvas around it is the frame's.
const CARD = `${CONTENT} [data-slot="dashboard-card"]`;
// The inset card's look (the layout's `INSET_CARD`) without its padding, and
// the right and bottom insets.
const cardClasses =
  'flex min-h-0 flex-col overflow-hidden rounded-xl bg-background p-0 shadow-sm mr-2 mb-2';
for (const form of Object.keys(forms) as Form[]) {
  test(`on ${form} the content is an inset card with no left border`, async () => {
    rendered = await renderDashboard(form);

    const card = single(rendered.root, CARD);
    const missing = cardClasses
      .split(/\s+/)
      .filter((name) => name !== '' && !card.classList.contains(name));
    assert.deepEqual(missing, [], `The card lacks classes: ${card.className}`);
    assert.equal(
      single(rendered.root, CONTENT).querySelectorAll('.border-l').length,
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

  const content = single(rendered.root, CONTENT);
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

  const content = single(rendered.root, CONTENT);
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

// Bundle isolation step 4(a), change 7, decision O1 (OD38): the Dashboard is
// split into `workspace-sidebar` (its sidebar) and `workspace-dashboard` (its
// content column), two slot elements with roots of their own. The fields the
// two parts share (the search, the create form) live in `stores/dashboard.ts`,
// so what the reader does in one element shows in the other.

const docs: Project = {
  id: '0b7d9c1e-2f3a-4b5c-9d8e-7f6a5b4c3d2e',
  name: 'Docs site',
  state: 'ready',
  configRevision: 1,
  createdAt: '2026-11-02T10:00:00.000Z',
  updatedAt: '2026-11-08T10:00:00.000Z',
};

/** Types `text` into `input` as the reader does: React sees the new value. */
const type = async (input: HTMLInputElement, text: string): Promise<void> => {
  input.focus();
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set?.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
};

test("O1: on /projects the sidebar's New project, in workspace-sidebar, opens the create form in workspace-dashboard", async () => {
  rendered = await renderWorkspace({ projects: [project], path: '/projects' });
  const sidebar = single(rendered.root, 'workspace-sidebar');
  const content = single(rendered.root, 'workspace-dashboard');
  assert.equal(
    content.querySelectorAll('input[aria-label="Project name"]').length,
    0,
    'The create form shows before New project is pressed.',
  );

  only(sidebar, 'button', 'New project').click();
  await settle();

  single(content, 'input[aria-label="Project name"]');
  assert.equal(
    sidebar.querySelectorAll('input[aria-label="Project name"]').length,
    0,
    'The create form opened in the sidebar, not the content column.',
  );
});

test("O1: on /projects typing in the sidebar's Search projects, in workspace-sidebar, filters the list in workspace-dashboard", async () => {
  rendered = await renderWorkspace({
    projects: [project, docs],
    path: '/projects',
  });
  const sidebar = single(rendered.root, 'workspace-sidebar');
  const content = single(rendered.root, 'workspace-dashboard');
  assert.ok(
    normalized(content.textContent).includes(project.name),
    'The list does not show Checkout redesign before the search.',
  );

  await type(
    single(sidebar, SEARCH) as HTMLInputElement,
    docs.name.slice(0, 4),
  );

  const listed = normalized(
    single(rendered.root, 'workspace-dashboard').textContent,
  );
  assert.ok(listed.includes(docs.name), `The list lost Docs site: ${listed}`);
  assert.ok(
    !listed.includes(project.name),
    `The list still shows Checkout redesign: ${listed}`,
  );
});

// T4.8 (bundle isolation 4(c)): the data items of `workspace.dashboard.footer`,
// with a made-up registrant (`:2135`); `settings`' real item is tested in
// `settings`.

const probeItem = {
  id: 'probe',
  tag: 'probe-icon',
  props: { label: 'Probe', command: 'probe.open/v1', input: { n: 1 } },
};

const renderFooter = async (
  items: readonly {
    readonly id: string;
    readonly tag: string;
    readonly props?: Readonly<Record<string, unknown>>;
  }[],
): Promise<RenderedWorkspace> => {
  const workspace = await renderWorkspace({
    projects: [project],
    path: '/projects',
    regions: { 'workspace.dashboard.footer': items },
  });
  assert.equal(workspace.errors().length, 0, 'Opening /projects failed.');
  return workspace;
};

const footerButtons = (workspace: RenderedWorkspace): HTMLElement[] => [
  ...single(workspace.root, FOOTER).querySelectorAll<HTMLElement>('button'),
];

test('T4.8: a workspace.dashboard.footer item draws one button with its icon element before its label', async () => {
  rendered = await renderFooter([probeItem]);

  const buttons = footerButtons(rendered);
  assert.deepEqual(buttons.map(nameOf), ['Probe']);
  const [button] = buttons;
  assert.ok(button);
  const icon = button.querySelector('[data-story-placeholder="probe-icon"]');
  assert.ok(icon, 'The button does not hold the probe-icon element.');
  const text = [...button.querySelectorAll('*')].find(
    (element) =>
      element.children.length === 0 &&
      normalized(element.textContent) === 'Probe',
  );
  assert.ok(text, 'The button does not show its label.');
  assert.ok(follows(icon, text), 'The icon does not come before the label.');
});

test('T4.8: picking a footer item executes its command with its input once per pick', async () => {
  rendered = await renderFooter([probeItem]);
  const [button] = footerButtons(rendered);
  assert.ok(button);

  button.click();
  await settle();
  assert.deepEqual(rendered.executed(), [
    { command: 'probe.open/v1', input: { n: 1 } },
  ]);

  button.click();
  await settle();
  assert.deepEqual(rendered.executed(), [
    { command: 'probe.open/v1', input: { n: 1 } },
    { command: 'probe.open/v1', input: { n: 1 } },
  ]);
});

test('T4.8: a footer item with malformed props is not drawn and is reported once per id', async () => {
  const reports: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    reports.push(args);
  };
  try {
    rendered = await renderFooter([
      {
        id: 'no-label',
        tag: 'probe-icon',
        props: { command: 'probe.open/v1' },
      },
      {
        id: 'bad-command',
        tag: 'probe-icon',
        props: { label: 'Bad command', command: 42 },
      },
      {
        id: 'bad-input',
        tag: 'probe-icon',
        props: { label: 'Bad input', command: 'probe.open/v1', input: [] },
      },
      probeItem,
    ]);
    assert.deepEqual(footerButtons(rendered).map(nameOf), ['Probe']);

    // A change of the region draws again; the malformed items are not
    // reported a second time.
    const dispose = rendered.services
      .use(RegionsV1)
      .add('workspace.dashboard.footer', {
        id: 'later',
        tag: 'probe-icon',
        props: { label: 'Later', command: 'probe.later/v1' },
      });
    await settle();
    assert.deepEqual(footerButtons(rendered).map(nameOf), ['Probe', 'Later']);
    dispose.dispose();
    await settle();
  } finally {
    console.error = original;
  }

  assert.equal(reports.length, 3, 'Not one report per malformed item.');
  for (const report of reports) {
    assert.match(String(report[0]), /^Doric:/);
  }
});

test('T4.8, decision O6: with no workspace.dashboard.footer item the footer draws no button', async () => {
  rendered = await renderFooter([]);

  assert.deepEqual(footerButtons(rendered), []);
});
