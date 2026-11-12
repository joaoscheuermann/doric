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

// Phase 5 (docs/designs/sidebar-alignment.md §11.4, D23, D25, D26): a terminal
// row takes the row fill and the inset outline on its item, its button draws no
// fill or ring, the selected row is the one `selectedId` names, and Stop
// reveals on keyboard focus only.
const UNSELECTED_FILL = [
  'rounded-[4px]',
  'hover:bg-[var(--paper-ghost-hover)]',
  'active:bg-[var(--paper-ghost-pressed)]',
] as const;
const SUB_BUTTON_RING = [
  'has-[[data-sidebar=menu-sub-button]:focus-visible]:outline-2',
  'has-[[data-sidebar=menu-sub-button]:focus-visible]:-outline-offset-2',
  'has-[[data-sidebar=menu-sub-button]:focus-visible]:outline-[var(--sidebar-ring)]',
] as const;
const INPUT_RING = [
  'has-[[data-slot=input]:focus-visible]:outline-2',
  'has-[[data-slot=input]:focus-visible]:-outline-offset-2',
  'has-[[data-slot=input]:focus-visible]:outline-[var(--sidebar-ring)]',
] as const;
const NO_FILL_BUTTON = [
  'bg-transparent',
  'hover:bg-transparent',
  'active:bg-transparent',
  'data-active:bg-transparent',
  'focus-visible:ring-0',
] as const;
const NOT_ON_NO_FILL_BUTTON = [
  'hover:bg-sidebar-accent',
  'active:bg-sidebar-accent',
  'data-active:bg-sidebar-accent',
  'focus-visible:ring-2',
  'hover:text-sidebar-foreground',
] as const;

const lacking = (element: Element, names: readonly string[]): string[] =>
  names.filter((name) => !element.classList.contains(name));
const carrying = (element: Element, names: readonly string[]): string[] =>
  names.filter((name) => element.classList.contains(name));

/** Renders the stories' three terminal rows with every action, and `selectedId`. */
const renderStatefulRows = (selectedId?: string): Promise<Rendered> =>
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
        createElement(TerminalRows, {
          terminals,
          depth: 1,
          onOpen: () => undefined,
          onStop: () => undefined,
          onRename: async () => undefined,
          ...(selectedId === undefined ? {} : { selectedId }),
        }),
      ),
    );
  });

/** The rows' items, in order; fails unless there are three. */
const items = (root: HTMLElement): HTMLElement[] => {
  const found = [
    ...root.querySelectorAll<HTMLElement>(
      '[data-slot="sidebar-menu-sub-item"]',
    ),
  ];
  assert.equal(found.length, 3, 'The rows do not render three items.');
  return found;
};

/** The one row button of `item`. */
const rowButton = (item: HTMLElement): HTMLElement => {
  const buttons = item.querySelectorAll<HTMLElement>(
    '[data-sidebar="menu-sub-button"]',
  );
  assert.equal(
    buttons.length,
    1,
    'The item does not hold exactly one row button.',
  );
  return buttons[0] as HTMLElement;
};

test('T-5.6: each item has the unselected fill and the sub-button ring; its one button is the no-fill button', async () => {
  rendered = await renderStatefulRows();
  for (const [index, item] of items(rendered.root).entries()) {
    assert.deepEqual(
      lacking(item, ['group/terminal', ...UNSELECTED_FILL, ...SUB_BUTTON_RING]),
      [],
      `row ${index}'s item`,
    );
    assert.deepEqual(
      carrying(item, ['bg-sidebar-accent']),
      [],
      `row ${index}'s item`,
    );
    const button = rowButton(item);
    assert.equal(button.getAttribute('data-slot'), 'context-menu-trigger');
    assert.deepEqual(
      lacking(button, NO_FILL_BUTTON),
      [],
      `row ${index}'s button`,
    );
    assert.deepEqual(
      carrying(button, NOT_ON_NO_FILL_BUTTON),
      [],
      `row ${index}'s button`,
    );
    assert.equal(
      button.hasAttribute('data-active'),
      false,
      `row ${index} is active`,
    );
    assert.equal(
      button.hasAttribute('aria-current'),
      false,
      `row ${index} is current`,
    );
  }
  assert.equal(
    rendered.root.querySelectorAll('[data-slot="sidebar-menu-sub-button"]')
      .length,
    0,
  );
});

test('T-5.6: the row selectedId names has the selected fill, data-active and aria-current; the others do not', async () => {
  const { testRun } = await import('../../stories/support/fixtures.js');
  rendered = await renderStatefulRows(testRun.id);
  const rows = items(rendered.root);
  const selected = rows.find((item) =>
    item.textContent?.includes(testRun.command),
  );
  assert.ok(selected, 'No row for the selected terminal.');
  assert.deepEqual(
    lacking(selected, [
      'rounded-[4px]',
      'bg-sidebar-accent',
      ...SUB_BUTTON_RING,
    ]),
    [],
  );
  assert.deepEqual(
    [...selected.classList].filter((name) => name.startsWith('hover:bg-[')),
    [],
  );
  const button = rowButton(selected);
  assert.ok(
    button.hasAttribute('data-active'),
    'The selected button has no data-active.',
  );
  assert.equal(button.getAttribute('aria-current'), 'true');

  for (const item of rows.filter((row) => row !== selected)) {
    assert.deepEqual(lacking(item, UNSELECTED_FILL), []);
    assert.deepEqual(carrying(item, ['bg-sidebar-accent']), []);
    assert.equal(rowButton(item).hasAttribute('data-active'), false);
    assert.equal(rowButton(item).hasAttribute('aria-current'), false);
  }
});

test('T-5.13: every item has the input ring, and the open rename input draws no ring of its own', async () => {
  rendered = await renderStatefulRows();
  for (const [index, item] of items(rendered.root).entries()) {
    assert.deepEqual(lacking(item, INPUT_RING), [], `row ${index}'s item`);
  }
  const first = items(rendered.root)[0] as HTMLElement;
  rowButton(first).dispatchEvent(
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

  const field = rendered.root.querySelector<HTMLElement>(
    'input[aria-label="Terminal name"]',
  );
  assert.ok(field, 'No Terminal name field.');
  const item = field.closest('[data-slot="sidebar-menu-sub-item"]');
  assert.ok(item, 'The field is not inside a row item.');
  assert.deepEqual(lacking(item, INPUT_RING), []);
  assert.deepEqual(
    lacking(field, ['focus-visible:ring-0', 'focus-visible:border-ring']),
    [],
  );
  assert.deepEqual(carrying(field, ['focus-visible:ring-3']), []);
});

test('T-5.14: Stop reveals on hover or keyboard focus, and no row reveals on focus-within', async () => {
  rendered = await renderStatefulRows();
  const stops = [
    ...rendered.root.querySelectorAll<HTMLElement>(
      'button[aria-label="Stop terminal"], button[aria-label="Discard terminal"]',
    ),
  ];
  assert.equal(stops.length, 3);
  for (const stop of stops) {
    assert.deepEqual(
      lacking(stop, [
        'group-hover/terminal:opacity-100',
        'group-has-[:focus-visible]/terminal:opacity-100',
      ]),
      [],
    );
  }
  const focusWithin = [...rendered.root.querySelectorAll('*')].flatMap(
    (element) =>
      [...element.classList].filter((name) =>
        name.startsWith('group-focus-within/terminal:'),
      ),
  );
  assert.deepEqual(focusWithin, []);
});

test('T-5.6: Stop takes the paper hover square and the action outline, and drops its own ring', async () => {
  rendered = await renderStatefulRows();
  const stops = [
    ...rendered.root.querySelectorAll<HTMLElement>(
      'button[aria-label="Stop terminal"], button[aria-label="Discard terminal"]',
    ),
  ];
  assert.equal(stops.length, 3);
  for (const stop of stops) {
    const label = stop.getAttribute('aria-label');
    assert.deepEqual(
      lacking(stop, [
        'hover:bg-[var(--paper-ghost-pressed)]',
        'dark:hover:bg-[var(--paper-ghost-pressed)]',
        'focus-visible:outline-solid',
        'focus-visible:outline-2',
        'focus-visible:outline-[var(--sidebar-ring)]',
        'focus-visible:ring-0',
      ]),
      [],
      `${label} lacks the paper hover square or the action outline.`,
    );
    assert.deepEqual(
      carrying(stop, [
        'hover:bg-muted',
        'dark:hover:bg-muted/50',
        'focus-visible:ring-3',
      ]),
      [],
      `${label} keeps the ghost button's own hover or ring.`,
    );
  }
});
