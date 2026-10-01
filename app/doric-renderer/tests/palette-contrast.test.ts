/**
 * The palette's own contrast, checked where it is written.
 *
 * The buttons read their states from the tokens — `hover:bg-muted`, `bg-accent`,
 * `border-input`, `text-primary-foreground` — so a pair of tokens that sits too
 * close together is a control nobody can see: the ghost button whose hover is the
 * page, the keycap that is a keycap by name only. This reads `styles.css` and
 * measures the pairs those names compose, so the palette cannot regress quietly.
 *
 * The thresholds are WCAG's where the pair carries meaning — 4.5 for text, 3 for
 * the ring that marks a boundary — and a perceptibility floor where the pair is a
 * surface (a hover, a highlight, an edge at rest), which no standard grades but
 * which has to be more than the 1.00 a colour identical to its page measures.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  blend,
  contrastRatio,
  type LinearRgb,
  linearRgb,
  type Oklch,
} from '../src/utility/contrast';

/** The smallest difference a surface has to make to be seen at all. */
const perceptible = 1.15;
const text = 4.5;
const boundary = 3;

/**
 * The stylesheet as it is written, read from where the compiled test sits: the
 * test target compiles beside the source it tests, so the file is two folders
 * up and the palette it checks is the one the app ships.
 */
const stylesheet = readFileSync(
  join(__dirname, '../../src/styles.css'),
  'utf8',
);

/**
 * One theme's tokens, in the order the stylesheet states them. The block is read
 * from its selector to the brace that closes it, so a token defined in `:root`
 * and overridden in `.dark` is read twice, each time as that theme has it.
 */
const tokensOf = (selector: string): Readonly<Record<string, Oklch>> => {
  const start = stylesheet.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `the palette states ${selector}`);
  const block = stylesheet.slice(start, stylesheet.indexOf('}', start));
  const tokens: Record<string, Oklch> = {};

  for (const [, name, l, c, h] of block.matchAll(
    /--([a-z-]+):\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/g,
  )) {
    tokens[name ?? ''] = { c: Number(c), h: Number(h), l: Number(l) };
  }

  return tokens;
};

const root = tokensOf(':root');
const dark = tokensOf('.dark');

/** The token one theme states under a name, or a failure that names it. */
const colour = (
  tokens: Readonly<Record<string, Oklch>>,
  name: string,
): LinearRgb => {
  const value = tokens[name];
  assert.notEqual(value, undefined, `the palette states --${name}`);

  return linearRgb(value as Oklch);
};

/** The pairs the renderer's controls actually put next to each other. */
const textPairs: readonly (readonly [string, string])[] = [
  ['foreground', 'background'],
  ['muted-foreground', 'background'],
  ['primary-foreground', 'primary'],
  ['secondary-foreground', 'secondary'],
  ['accent-foreground', 'accent'],
  ['destructive-foreground', 'destructive'],
];

/** Pairs that carry meaning only as a surface: a hover, a highlight, an edge. */
const surfacePairs: readonly (readonly [string, string])[] = [
  ['muted', 'background'],
  ['accent', 'background'],
  ['border', 'background'],
  ['input', 'background'],
  ['secondary', 'background'],
  ['sidebar-accent', 'sidebar'],
  ['sidebar-border', 'sidebar'],
];

for (const [theme, tokens] of [
  ['light', root],
  ['dark', dark],
] as const) {
  describe(`the ${theme} palette`, () => {
    for (const [foreground, background] of textPairs) {
      test(`${foreground} on ${background} is readable`, () => {
        const ratio = contrastRatio(
          colour(tokens, foreground),
          colour(tokens, background),
        );

        assert.ok(
          ratio >= text,
          `${foreground} on ${background} is ${ratio.toFixed(2)}:1, under ${text}`,
        );
      });
    }

    test('the focus ring marks a boundary', () => {
      const ratio = contrastRatio(
        colour(tokens, 'ring'),
        colour(tokens, 'background'),
      );

      assert.ok(
        ratio >= boundary,
        `ring on background is ${ratio.toFixed(2)}:1, under ${boundary}`,
      );
    });

    for (const [surface, behind] of surfacePairs) {
      test(`${surface} is visible against ${behind}`, () => {
        const ratio = contrastRatio(
          colour(tokens, surface),
          colour(tokens, behind),
        );

        assert.ok(
          ratio >= perceptible,
          `${surface} on ${behind} is ${ratio.toFixed(2)}:1, under ${perceptible}`,
        );
      });
    }

    test('the destructive button keeps its text on its own tint', () => {
      const destructive = colour(tokens, 'destructive');
      const tint = blend(destructive, colour(tokens, 'background'), 0.1);
      const ratio = contrastRatio(destructive, tint);

      assert.ok(
        ratio >= text,
        `destructive text on its tint is ${ratio.toFixed(2)}:1, under ${text}`,
      );
    });

    test('hovering a filled button does not cost it contrast', () => {
      // What a filled button is filled with is not a colour in the palette but a
      // mix with the foreground — `color-mix(in oklch, var(--primary), var(--foreground) 12%)`
      // in `ui/button.tsx` — so the palette is measured as that mix, in both
      // themes: a hover that washed toward the page would read as `bg-primary/80`
      // did, at 2.96:1 of text in the light theme.
      const primary = colour(tokens, 'primary');
      const hovering = blend(primary, colour(tokens, 'foreground'), 0.12);
      const onText = contrastRatio(
        colour(tokens, 'primary-foreground'),
        hovering,
      );
      const atRest = contrastRatio(
        colour(tokens, 'primary-foreground'),
        primary,
      );

      assert.ok(
        onText >= atRest,
        `the primary's hover is ${onText.toFixed(2)}:1 against ${atRest.toFixed(2)}:1 at rest`,
      );
    });
  });
}
