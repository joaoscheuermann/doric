// The account menu of the Project view (S26, T-2.2, T-2.15): the avatar named
// "Account" in the header opens a menu naming the reader, offering Settings
// and closing on the app's name, license and version. On an app without
// `doric.about/v1` the footer names the license alone, and nothing fails.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { READER_NAME } from 'desktop/ui/identity';

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

const projectView: LayoutFixture = {
  projects: [project],
  path: `/projects/${project.id}`,
};

let rendered: RenderedWorkspace | undefined;

afterEach(() => {
  rendered?.cleanup();
  rendered = undefined;
  document.body.replaceChildren();
});

const normalized = (text: string | null | undefined): string =>
  (text ?? '').replace(/\s+/g, ' ').trim();

/** The accessible name of a button: its `aria-label`, else its text. */
const nameOf = (element: Element): string =>
  normalized(element.getAttribute('aria-label') ?? element.textContent);

/** Presses `element` as a mouse does: pointer and mouse down, up, click. */
const press = async (element: HTMLElement): Promise<void> => {
  const init = {
    bubbles: true,
    cancelable: true,
    button: 0,
    pointerId: 1,
    pointerType: 'mouse',
  };
  element.dispatchEvent(new PointerEvent('pointerdown', init));
  element.dispatchEvent(new MouseEvent('mousedown', init));
  element.dispatchEvent(new PointerEvent('pointerup', init));
  element.dispatchEvent(new MouseEvent('mouseup', init));
  element.click();
  await settle();
};

/** Presses the header's "Account" button and answers the menu it opened. */
const openAccountMenu = async (
  workspace: RenderedWorkspace,
): Promise<HTMLElement> => {
  const buttons = [...workspace.root.querySelectorAll<HTMLElement>('button')];
  const account = buttons.find((button) => nameOf(button) === 'Account');
  assert.ok(
    account !== undefined,
    `No button named "Account" in the Project view; buttons: ${buttons
      .map(nameOf)
      .join(' | ')}`,
  );
  await press(account);
  const menu = document.querySelector<HTMLElement>('[role="menu"]');
  assert.ok(menu !== null, 'Pressing "Account" opened no menu.');
  return menu;
};

/** Whether some element under `root` reads exactly `text`. */
const reads = (root: Element, text: string): boolean =>
  [...root.querySelectorAll('*')].some(
    (element) => normalized(element.textContent) === text,
  );

test('the account menu names the reader, the local account, the app and its version', async () => {
  rendered = await renderWorkspace(projectView);

  const menu = await openAccountMenu(rendered);

  for (const text of [
    READER_NAME,
    'Local account',
    'Doric',
    'MIT License · v0.0.1',
  ]) {
    assert.ok(
      reads(menu, text),
      `The menu does not read "${text}": ${normalized(menu.textContent)}`,
    );
  }
});

test('Settings in the account menu opens the settings window', async () => {
  rendered = await renderWorkspace(projectView);

  const menu = await openAccountMenu(rendered);
  const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const settings = items.find(
    (item) => normalized(item.textContent) === 'Settings',
  );
  assert.ok(
    settings !== undefined,
    `No "Settings" item in the account menu: ${items
      .map((item) => normalized(item.textContent))
      .join(' | ')}`,
  );
  await press(settings);

  assert.ok(
    rendered.executed().includes('core.open-settings/v1'),
    `Executed: ${rendered.executed().join(', ')}`,
  );
});

test('without doric.about/v1 the footer names the license alone and nothing logs an error', async (t) => {
  const error = t.mock.method(console, 'error', () => undefined);
  rendered = await renderWorkspace({
    ...projectView,
    absent: ['doric.about/v1'],
  });

  const menu = await openAccountMenu(rendered);

  assert.ok(
    reads(menu, 'Doric'),
    `The menu does not read "Doric": ${normalized(menu.textContent)}`,
  );
  assert.ok(
    reads(menu, 'MIT License'),
    `The menu does not read "MIT License" alone: ${normalized(menu.textContent)}`,
  );
  assert.ok(
    !normalized(menu.textContent).includes(' · v'),
    `The menu shows a version: ${normalized(menu.textContent)}`,
  );
  assert.deepEqual(
    error.mock.calls.map((call) => call.arguments),
    [],
  );
});

test('a workspace bound after one with the version shows none without doric.about/v1', async () => {
  rendered = await renderWorkspace(projectView);
  const first = await openAccountMenu(rendered);
  assert.ok(
    reads(first, 'MIT License · v0.0.1'),
    `The first menu shows no version: ${normalized(first.textContent)}`,
  );
  rendered.cleanup();

  rendered = await renderWorkspace({
    ...projectView,
    absent: ['doric.about/v1'],
  });
  const menu = await openAccountMenu(rendered);

  assert.ok(
    reads(menu, 'MIT License'),
    `The menu does not read "MIT License" alone: ${normalized(menu.textContent)}`,
  );
});
