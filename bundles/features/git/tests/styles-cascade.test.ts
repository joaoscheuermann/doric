// The git sheet loads in the settings window after the settings sheet (the
// Versioning section, WP-10N), so a shared class it emits (`inline-flex` of
// a button) must not land after the settings bar's `md:hidden`: the window's
// title bar draws one Back control, not two.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('the settings bar’s md:hidden still follows a button’s inline-flex', async () => {
  const css = await readFile(
    new URL('../../dist/client/styles.css', import.meta.url),
    'utf8',
  );
  const inline = css.indexOf('.inline-flex {');
  const hidden = css.indexOf('.md\\:hidden {');

  assert.ok(inline >= 0, 'the sheet emits inline-flex');
  assert.ok(hidden > inline, 'md:hidden follows inline-flex');
});
