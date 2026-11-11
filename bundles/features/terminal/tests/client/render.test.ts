// The terminal rows under a Thread of the sidebar tree rendered in happy-dom
// over the stories' fixtures. Smoke test of the client test setup (Part 4.4b).

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import type { Terminal } from '../../src/client/domain/terminals.js';
import { type Rendered, render, settle } from './support/render.js';

let rendered: Rendered | undefined;

afterEach(() => {
  rendered?.cleanup();
  rendered = undefined;
});

test('each terminal is a row that opens it, with its stop or discard action', async () => {
  const opened: Terminal[] = [];
  const stopped: string[] = [];
  rendered = await render(async () => {
    const { createElement } = await import('react');
    const { SidebarMenu, SidebarScope } = await import('desktop/ui/sidebar');
    const { TerminalRows } = await import(
      '../../src/client/rows/terminal-rows.js'
    );
    const { terminals } = await import('../../stories/support/fixtures.js');
    return createElement(
      SidebarScope,
      null,
      createElement(
        SidebarMenu,
        null,
        createElement(TerminalRows, {
          terminals,
          depth: 1,
          onOpen: (terminal: Terminal) => opened.push(terminal),
          onStop: (id: string) => stopped.push(id),
        }),
      ),
    );
  });
  const { root } = rendered;

  const rows = [...root.querySelectorAll<HTMLElement>('li')];
  assert.equal(rows.length, 3);
  assert.ok(rows[0]?.textContent?.includes('npm run dev --workspace apps/web'));
  assert.deepEqual(
    [...root.querySelectorAll('button[aria-label]')].map((button) =>
      button.getAttribute('aria-label'),
    ),
    ['Stop terminal', 'Stop terminal', 'Discard terminal'],
  );

  rows[2]?.querySelector<HTMLElement>('button:not([aria-label])')?.click();
  root
    .querySelector<HTMLElement>('button[aria-label="Discard terminal"]')
    ?.click();
  await settle();

  assert.deepEqual(
    opened.map((terminal) => terminal.id),
    ['term_user_shell'],
  );
  assert.deepEqual(stopped, ['term_user_shell']);
});

/** Renders the stories' terminal rows under one Thread, optionally renamable. */
const renderFixtureRows = (
  onRename?: (id: string, name: string | null) => Promise<void>,
): Promise<Rendered> =>
  render(async () => {
    const { createElement } = await import('react');
    const { SidebarMenu, SidebarScope } = await import('desktop/ui/sidebar');
    const { TerminalRows } = await import(
      '../../src/client/rows/terminal-rows.js'
    );
    const { terminals } = await import('../../stories/support/fixtures.js');
    return createElement(
      SidebarScope,
      null,
      createElement(
        SidebarMenu,
        null,
        createElement(TerminalRows, { terminals, depth: 1, onRename }),
      ),
    );
  });

/** Asserts `container` holds one 16 px terminal lead slot with the terminal icon. */
const assertTerminalLead = (container: Element, where: string): void => {
  const leads = container.querySelectorAll('[data-slot="terminal-lead"]');
  assert.equal(leads.length, 1, `${where}: one terminal lead slot`);
  const lead = leads[0] as Element;
  assert.ok(lead.classList.contains('size-4'), `${where}: a 16 px lead slot`);
  assert.equal(
    lead.querySelectorAll('svg.lucide-terminal').length,
    1,
    `${where}: the lead slot holds the terminal icon`,
  );
};

test('T-1.2: each terminal row leads with the terminal icon in a 16 px slot', async () => {
  rendered = await renderFixtureRows();
  const buttons = [
    ...rendered.root.querySelectorAll<HTMLElement>(
      'li button:not([aria-label])',
    ),
  ];
  assert.equal(buttons.length, 3);
  for (const [index, button] of buttons.entries()) {
    assertTerminalLead(button, `row ${index}`);
    assert.equal(
      button.querySelectorAll(':scope > svg').length,
      0,
      `row ${index}: no icon outside the lead slot`,
    );
  }
});

test('T-1.2b: the open rename field leads with the terminal icon in a 16 px slot', async () => {
  rendered = await renderFixtureRows(async () => undefined);
  const row = rendered.root.querySelector<HTMLElement>(
    'li button:not([aria-label])',
  );
  assert.ok(row, 'No terminal row.');
  row.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    }),
  );
  await settle();
  const rename = [
    ...document.querySelectorAll<HTMLElement>(
      '[data-slot="context-menu-content"] [role="menuitem"]',
    ),
  ].find((item) => item.textContent?.trim() === 'Rename');
  assert.ok(rename, 'No Rename in the row menu.');
  rename.click();
  await settle();

  const field = rendered.root.querySelector(
    'input[aria-label="Terminal name"]',
  );
  const item = field?.closest('li');
  assert.ok(item, 'No Terminal name field.');
  assertTerminalLead(item, 'rename field');
});
