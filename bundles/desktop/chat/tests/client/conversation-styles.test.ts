// The conversation's own stylesheet, read from disk: the live selection in the
// transcript is drawn in the theme's primary ink, with a `color-mix` of it as
// the background, so the words the reader selects read as the conversation's
// accent instead of the platform's default highlight.
//
// The bundle compiles no stylesheet test of its own, so this reads
// `src/client/styles.css` as the file the build ships and asserts the rule's
// own text.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const stylesheet = resolve(here, '../../../src/client/styles.css');

/**
 * The declaration blocks of every `::selection` rule scoped to the transcript
 * editor: the selector's own text and the declarations between its braces.
 */
const selectionRules = (
  sheet: string,
): { readonly selector: string; readonly body: string }[] => {
  const rules: { selector: string; body: string }[] = [];
  const pattern =
    /([^{}]*\[data-lexical-editor\][^{}]*::selection[^{}]*)\{([^{}]*)\}/g;
  for (const match of sheet.matchAll(pattern)) {
    rules.push({ selector: match[1] ?? '', body: match[2] ?? '' });
  }
  return rules;
};

test('the transcript draws a live selection in the primary ink over a color-mix of it', async () => {
  const sheet = await readFile(stylesheet, 'utf8');
  const rules = selectionRules(sheet);

  assert.equal(rules.length, 1, 'one selection rule scoped to the editor');
  const [rule] = rules;
  assert.ok(rule);

  const color = /(?:^|;)\s*color\s*:\s*([^;]+);/m.exec(rule.body)?.[1]?.trim();
  assert.equal(color, 'var(--primary)');

  const background = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+);/m
    .exec(rule.body)?.[1]
    ?.trim();
  assert.ok(background, 'the rule paints the selection background');
  assert.match(background, /color-mix\(/);
  assert.match(background, /var\(--primary\)/);
});
