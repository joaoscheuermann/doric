// The frame's page form, as the Dashboard is drawn in it (spec §2.8, T-2.7;
// contracts 2e §3, §5): while `shell.page` holds an item the sidebar column
// is 280 px wide, and the content column is the sidebar canvas with no left
// border (S34). Since bundle isolation 4(c) the Dashboard, its
// sidebar and its tab bar are the `workspace` bundle's elements and draw here
// as the stand-ins of their slots; their cases moved to
// `bundles/desktop/workspace/tests/client/dashboard-shell.test.ts`.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import type { LayoutFixture } from '../../stories/support/layout-host.js';
import { dashboardStandIns } from '../../stories/support/tabs.js';
import { type RenderedShell, renderShell } from './support/render-shell.js';

let rendered: RenderedShell | undefined;

afterEach(() => {
  rendered?.cleanup();
  rendered = undefined;
  document.body.replaceChildren();
});

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

const ASIDE = 'aside[aria-label="Dashboard navigation"]';

/** The page form on the two paths the Dashboard is reached at. */
const forms = {
  '/projects': '/projects',
  '/': '/',
} as const;
type Form = keyof typeof forms;

/** Renders the frame's page form: `shell.page` and the navigation's slots hold stand-ins. */
const renderPage = async (form: Form): Promise<RenderedShell> => {
  const fixture: LayoutFixture = {
    path: forms[form],
    regions: dashboardStandIns,
  };
  const shell = await renderShell(fixture);
  assert.equal(shell.errors().length, 0, `Opening ${form} failed.`);
  return shell;
};

// T-2.7: the Dashboard sidebar is 280 px wide
test('on /projects the Dashboard sidebar is 280 px wide', async () => {
  rendered = await renderPage('/projects');

  const sidebar = single(rendered.root, `${ASIDE} [data-slot="sidebar"]`);
  assert.ok(
    sidebar.classList.contains('w-[280px]'),
    `The Dashboard sidebar is not 280 px wide: ${sidebar.className}`,
  );
});

// S34, UR1 (`85:7726`, `85:7520`): the content column is the sidebar
// canvas with no left border. The inset card inside it is drawn by the
// Dashboard (`dashboard.tsx`, `workspace`'s since 4(c)) and is asserted there.
for (const form of Object.keys(forms) as Form[]) {
  test(`on ${form} the content column is on the sidebar canvas with no left border`, async () => {
    rendered = await renderPage(form);

    const content = single(rendered.root, 'div[data-slot="dashboard-content"]');
    assert.ok(
      content.classList.contains('bg-window-frame'),
      `The content column is not on the sidebar canvas: ${content.className}`,
    );
    assert.equal(
      content.querySelectorAll('.border-l').length,
      0,
      'The Dashboard content keeps a left border.',
    );
  });
}
