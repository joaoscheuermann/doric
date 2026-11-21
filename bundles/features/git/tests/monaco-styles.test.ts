// Bundle isolation 4(a) change 6 (coordinator decision OD38): the Monaco
// scrollbar rule left the layout's sheet for every bundle that draws a Monaco
// editor, so the git sheet states it itself, unlayered (Monaco's own CSS is
// unlayered and would win over a layered rule) and after its `@source` lines.
// The sheet is read from disk; the helpers are local copies of the layout's
// `footer-styles.test.ts`, since the bundles share no test helper module.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const sheet = readFileSync(join(packageRoot, 'src/client/styles.css'), 'utf8');

const slider =
  '.monaco-editor .monaco-scrollable-element > .scrollbar > .slider';

/** The sheet without its comments. */
const uncommented = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '');

/** One rule's declarations, by property, whitespace collapsed. */
const declarations = (body: string): Map<string, string> =>
  new Map(
    body
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => {
        const [property = '', ...value] = part.split(':');
        return [
          property.trim(),
          value.join(':').replace(/\s+/g, ' ').trim(),
        ] as const;
      }),
  );

/** The plain rules of the sheet: selector, declarations and offset. */
const rules = (text: string) =>
  [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: (match[1] ?? '')
      .replace(/@[^;]*;/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
    body: declarations(match[2] ?? ''),
    // The rule's own brace: the text before it may hold the sheet's @-lines.
    at: (match.index ?? 0) + (match[1] ?? '').length,
  }));

test('the git sheet states the Monaco scrollbar slider rule, unlayered, after its @source lines', () => {
  const text = uncommented(sheet);
  const rule = rules(text).find((candidate) => candidate.selector === slider);

  assert.ok(rule !== undefined, 'The git sheet has no Monaco slider rule.');
  assert.deepEqual(
    rule.body,
    new Map([
      ['background-clip', 'padding-box'],
      ['border', '1.5px solid transparent'],
      ['border-radius', '9999px'],
    ]),
  );
  assert.ok(
    rule.at > text.lastIndexOf('@source'),
    'The Monaco rule comes before an @source line.',
  );
  assert.ok(
    !text.includes('@layer'),
    'The git sheet puts a rule in a cascade layer.',
  );
});
