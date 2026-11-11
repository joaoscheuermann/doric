// T-5.12 (docs/designs/sidebar-alignment.md §11.6, U15): the mcp bundle's
// sheet is minimal. It scans no file (`source(none)`) and names exactly its
// phase 5 classes in one `@source inline(…)`, so it re-emits no class that
// would move another bundle's rule in the cascade of a window that loads
// every bundle sheet.

import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { test } from 'node:test';

/** The bundle's list in §11.6, in order. */
const TOKENS = [
  'rounded-[4px]',
  'hover:bg-[color-mix(in_oklch,var(--sidebar-accent)_50%,var(--sidebar))]',
  'active:bg-[color-mix(in_oklch,var(--sidebar-accent)_80%,var(--sidebar))]',
  'has-[[data-slot=sidebar-menu-button]:focus-visible]:ring-2',
  'has-[[data-slot=sidebar-menu-button]:focus-visible]:ring-inset',
  'has-[[data-slot=sidebar-menu-button]:focus-visible]:ring-sidebar-ring',
  'bg-transparent',
  'hover:bg-transparent',
  'active:bg-transparent',
  'data-active:bg-transparent',
  'focus-visible:ring-0',
  'group-has-[:focus-visible]/menu-item:pointer-events-auto',
  'group-has-[:focus-visible]/menu-item:opacity-100',
  'group-has-[:focus-visible]/menu-item:opacity-0',
  'group-has-[:focus-visible]/menu-item:right-7',
];

const source = new URL('../../src/client/styles.css', import.meta.url);
const built = new URL('../../dist/client/styles.css', import.meta.url);

test('the source sheet scans no file and lists exactly the bundle’s phase 5 classes', async () => {
  const css = await readFile(source, 'utf8');
  assert.ok(
    css.includes('source(none)'),
    'the sheet does not turn off the scan',
  );

  const lines = css
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('@source'));
  assert.equal(lines.length, 1, `the sheet has ${lines.length} @source lines`);
  const inline = /^@source inline\('([^']*)'\);$/u.exec(lines[0] ?? '');
  assert.ok(inline, `the @source line is not an inline list: ${lines[0]}`);
  assert.deepEqual((inline[1] ?? '').split(' '), TOKENS);
});

test('the built sheet is small, holds the row states and none of the known conflicts', async () => {
  const { size } = await stat(built);
  assert.ok(size < 8192, `the built sheet is ${size} bytes`);
  const css = await readFile(built, 'utf8');
  assert.ok(
    css.includes('color-mix(in oklch'),
    'the sheet emits no color-mix fill',
  );
  assert.ok(
    css.includes(':has(:is([data-slot=sidebar-menu-button]:focus-visible))'),
    'the sheet emits no menu-button ring',
  );
  for (const conflict of [
    '.border {',
    '.transition-transform {',
    '.hover\\:text-foreground:hover',
    '.inline-flex {',
  ]) {
    assert.ok(!css.includes(conflict), `the sheet re-emits ${conflict}`);
  }
});
