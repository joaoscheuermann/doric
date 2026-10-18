// The settings sheet loads after the platform theme, so a utility both emit
// must keep the order one compiled stylesheet gives it: a field's `*:w-full`
// still stretches a choice picker's `w-fit` trigger across the row.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('a field stretches its picker trigger over the trigger’s own w-fit', async () => {
  const css = await readFile(
    new URL('../../dist/client/styles.css', import.meta.url),
    'utf8',
  );
  const fit = css.indexOf('.w-fit {');
  const stretch = css.indexOf(':is(.\\*\\:w-full > *)');

  assert.ok(fit >= 0, 'the sheet emits w-fit');
  assert.ok(stretch > fit, 'the field’s *:w-full follows w-fit');
});
