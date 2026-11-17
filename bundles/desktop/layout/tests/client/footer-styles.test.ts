// The layout's own stylesheet, read from disk: the conversation footer band
// gets its height (`--chat-footer-height`), fill and blur from an unlayered
// rule keyed on its `data-slot` (conversation-footer spec, D2, D13 and §3),
// not from utilities the layout's sheet does not emit.
//
// happy-dom lays nothing out, so this reads `src/client/styles.css` as the
// file the build ships and asserts the rules' own text. The helpers are local
// copies of chat's `conversation-styles.test.ts`: the bundles share no test
// helper module.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const stylesheet = resolve(here, '../../../src/client/styles.css');

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
          property.trim().replace(/^background$/, 'background-color'),
          value.join(':').replace(/\s+/g, ' ').trim(),
        ] as const;
      }),
  );

/** The sheet without its comments. */
const uncommented = (sheet: string): string =>
  sheet.replace(/\/\*[\s\S]*?\*\//g, '');

/** The plain rules of a stretch of the sheet: selectors and declarations. */
const rulesIn = (
  text: string,
): { readonly selectors: string[]; readonly body: Map<string, string> }[] =>
  [...uncommented(text).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: (match[1] ?? '')
      .split(',')
      .map((part) => part.replace(/\s+/g, ' ').trim()),
    body: declarations(match[2] ?? ''),
  }));

/** What the rules of a stretch declare for one selector, the later winning. */
const declared = (text: string, selector: string): Map<string, string> =>
  new Map(
    rulesIn(text)
      .filter((rule) => rule.selectors.includes(selector))
      .flatMap((rule) => [...rule.body]),
  );

// conversation-footer T-3
test('the conversation footer band is as tall as --chat-footer-height, the background at 70 % under a 2 px blur, in an unlayered rule', async () => {
  const sheet = await readFile(stylesheet, 'utf8');

  assert.ok(
    !uncommented(sheet).includes('@layer'),
    'The layout sheet puts a rule in a cascade layer.',
  );
  assert.deepEqual(
    declared(sheet, "[data-slot='workspace-footer']"),
    new Map([
      ['height', 'var(--chat-footer-height)'],
      [
        'background-color',
        'color-mix(in oklab, var(--background) 70%, transparent)',
      ],
      ['backdrop-filter', 'blur(2px)'],
    ]),
  );
});
