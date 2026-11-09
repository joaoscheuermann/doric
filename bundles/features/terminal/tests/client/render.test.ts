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
