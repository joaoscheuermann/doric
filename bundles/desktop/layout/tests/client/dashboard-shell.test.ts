// The Dashboard after phase 2e (spec §2.8, T-2.7; contracts 2e §3, §5):
// - on `/projects` (and `/` at startup) the Dashboard sidebar is 280 px wide
//   and starts with the sidebar header's "Dashboard" button above "Search
//   projects"; "All settings" stays in its footer;
// - the Project tab bar, with the account status at its right end, is the top
//   row of the content column, not of the window, and it holds no
//   `layout.header` item (G13);
// - only the home body (`/` reached through "New project"), which has no
//   sidebar, keeps the macOS inset in the tab bar (G3);
// - Ctrl+F focuses whichever "Search projects" field is mounted (S13).

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { NavigationV1 } from 'bundle/contracts';

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
for (const form of ['/projects', '/ at startup'] as const) {
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

// T-2.7: the home body has no sidebar, and its own search takes Ctrl+F
test('on / through New project there is no sidebar, and Ctrl+F focuses the home Search projects field', async () => {
  rendered = await renderDashboard('/ through New project');

  assert.equal(
    rendered.root.querySelectorAll(ASIDE).length,
    0,
    'The home body has a Dashboard sidebar.',
  );
  const search = single(rendered.root, SEARCH);
  await pressCtrlF();

  assert.ok(
    document.activeElement === search,
    'Ctrl+F does not focus the home Search projects field.',
  );
});

// G3: only the home body keeps the macOS inset in the tab bar
for (const [form, inset] of [
  ['/ through New project', true],
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
