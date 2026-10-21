// The conversation's own stylesheet, read from disk: the live selection in the
// transcript is drawn in the theme's primary ink, with a `color-mix` of it as
// the background, so the words the reader selects read as the conversation's
// accent instead of the platform's default highlight, and a comment's words
// keep those colours; and the mark each turn wears in the gutter has one size,
// centred on its block's first line, room to stand whole in a narrow pane, and
// moves to the comments that open its block.
//
// happy-dom lays nothing out and the bundle compiles no stylesheet test of its
// own, so this reads `src/client/styles.css` as the file the build ships and
// asserts the rules' own text.

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

/** The declarations of the sheet's `::highlight(<name>)` rule, else `undefined`. */
const highlightRule = (sheet: string, name: string): string | undefined =>
  new RegExp(`::highlight\\(${name}\\)\\s*\\{([^{}]*)\\}`).exec(sheet)?.[1];

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

test('the words a comment is about keep the live selection’s colours', async () => {
  const sheet = await readFile(stylesheet, 'utf8');
  const [selection] = selectionRules(sheet);
  const highlight = highlightRule(sheet, 'chat-comment');

  assert.ok(selection);
  assert.ok(highlight, 'the sheet paints the comment highlight');
  assert.deepEqual(declarations(highlight), declarations(selection.body));
});

/** The sheet without its comments. */
const uncommented = (sheet: string): string =>
  sheet.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every selector of the sheet, one per comma-separated part. */
const selectors = (sheet: string): string[] =>
  [...uncommented(sheet).matchAll(/([^{};@]+)\{/g)]
    .flatMap((match) => (match[1] ?? '').split(','))
    .map((part) => part.replace(/\s+/g, ' ').trim());

test('the reader’s gutter mark leaves the prompt’s ::before to its placeholder', async () => {
  const sheet = await readFile(stylesheet, 'utf8');
  // The prompt wears the reader's mark (`data-turn-avatar='user'`) and shows
  // its placeholder in `::before`: no rule may draw the mark there.
  const claimed = selectors(sheet).filter((selector) =>
    /\[data-turn-avatar(='user')?\]::before$/.test(selector),
  );

  assert.deepEqual(claimed, []);
  assert.ok(
    selectors(sheet).some((selector) =>
      selector.endsWith("[data-turn-avatar='user']::after"),
    ),
    'the reader’s mark is drawn in ::after',
  );
});

/** The body of the sheet's `@container (max-width: 54rem)` block. */
const narrowBlock = (sheet: string): string => {
  const text = uncommented(sheet);
  const start = text.indexOf('@container (max-width: 54rem)');
  assert.ok(start >= 0, 'the sheet has a narrow-pane block');
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === '{') depth += 1;
    if (text[at] === '}') depth -= 1;
    if (depth === 0) return text.slice(open + 1, at);
  }
  return text.slice(open + 1);
};

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

/** A length in rem, as the sheet states it. */
const rem = (value: string | undefined): number => {
  const match = /^(-?[\d.]+)rem$/.exec(value ?? '');
  assert.ok(match, `a length in rem: ${value}`);
  return Number(match[1]);
};

const MARKS = [
  ".conversation-scroll [data-lexical-editor] > [data-turn-avatar='agent']::before",
  ".conversation-scroll [data-lexical-editor] > [data-turn-avatar='user']::after",
  ".conversation-scroll [data-lexical-editor] > [data-turn-avatar='agent']::after",
];

/** The conversation's line: `text-sm`, 1.25rem tall. */
const LINE = 1.25;

/** The size every mark wears, in every pane. */
const MARK = 1.375;

test('every gutter mark wears one size, centred on the first line of its block, in any pane', async () => {
  const sheet = await readFile(stylesheet, 'utf8');
  const narrow = narrowBlock(sheet);
  const wide = uncommented(sheet).replace(narrow, '');

  for (const mark of MARKS) {
    const base = declared(wide, mark);
    const top = rem(base.get('inset-block-start'));
    const size = rem(base.get('block-size'));
    assert.equal(size, MARK, `${mark} is the small mark`);
    assert.equal(rem(base.get('inline-size')), MARK);
    assert.equal(top + size / 2, LINE / 2, `${mark} centres on the line`);
    assert.equal(
      rem(base.get('inset-inline-start')),
      -(MARK + 0.5),
      `${mark} stands 0.5rem before the text`,
    );
  }
  // A narrow pane moves no mark: it only makes room for it.
  const moved = rulesIn(narrow).filter((rule) =>
    rule.selectors.some((selector) => selector.includes('[data-turn-avatar')),
  );
  assert.deepEqual(moved, []);
});

test('a narrow pane widens the column’s left padding to hold the whole mark', async () => {
  const sheet = await readFile(stylesheet, 'utf8');
  const narrow = narrowBlock(sheet);

  const column = declared(
    narrow,
    ".conversation-scroll > [data-slot='scroll-area-viewport'] > div",
  );
  const padding = rem(column.get('padding-inline-start'));
  const mark = declared(
    uncommented(sheet).replace(narrow, ''),
    ".conversation-scroll [data-lexical-editor] > [data-turn-avatar='user']::after",
  );
  const reach = -rem(mark.get('inset-inline-start'));
  const size = rem(mark.get('inline-size'));

  // The mark starts inside the padding, never past the pane's edge, and
  // ends before the first character.
  assert.ok(reach > size, 'a gap between the mark and the text');
  assert.ok(padding > reach, 'the padding holds the mark whole');
});

test('the stack that opens the prompt wears its mark, and the prompt’s words below it none', async () => {
  const sheet = await readFile(stylesheet, 'utf8');
  const hidden = rulesIn(sheet)
    .filter((rule) => rule.body.get('content') === 'none')
    .flatMap((rule) => rule.selectors);

  for (const selector of [
    // An empty stack draws no mark of its own…
    '.conversation-scroll [data-lexical-editor] > [data-composer-stack]:empty::after',
    // …and one holding comments takes the prompt's.
    '.conversation-scroll [data-lexical-editor] > [data-composer-stack]:not(:empty) ~ [data-prompt-input]::after',
  ]) {
    assert.ok(hidden.includes(selector), selector);
  }
});

test('no turn’s mark hangs on the block before it, so a block drawn above restyles none below', async () => {
  const sheet = await readFile(stylesheet, 'utf8');
  // The transcript fills in by inserting blocks above the ones it drew: a
  // mark chosen by the block right before it (`+`) would restyle every turn
  // below at every insertion. The one sibling rule left is the prompt's, which
  // only the stack's own changes reach. (A sent turn's comments taking its
  // mark is proven in a window, `turn-marks.test.ts`.)
  const adjacent = selectors(sheet).filter(
    (selector) =>
      selector.includes('[data-lexical-editor] >') &&
      selector.includes('[data-turn-avatar') &&
      / \+ /.test(selector),
  );

  assert.deepEqual(adjacent, []);
});

test('the pointer cursor over a commented passage styles the element under the pointer, never the whole transcript', async () => {
  const sheet = await readFile(stylesheet, 'utf8');
  // `cursor` is inherited: worn by the editor's root, it would restyle every
  // element of the transcript on each hover, a frame too slow to follow the
  // pointer in a long conversation. (Which element wears it is proven in a
  // window, `comment-selection.test.ts`.)
  const hover = selectors(sheet).filter((selector) =>
    selector.includes('[data-comment-hover]'),
  );

  assert.deepEqual(hover, ['[data-lexical-editor] [data-comment-hover]']);
  assert.equal(
    declared(sheet, '[data-lexical-editor] [data-comment-hover]').get('cursor'),
    'pointer',
  );
});

test('a block that wears a gutter mark starts its first line at its top, whatever opens it', async () => {
  const sheet = await readFile(stylesheet, 'utf8');
  const first = declared(
    uncommented(sheet),
    '.conversation-scroll [data-lexical-editor] > [data-turn-avatar] > :first-child',
  );

  // A heading's own top margin would push the first line below the mark.
  assert.equal(first.get('margin-block-start'), '0');
});
