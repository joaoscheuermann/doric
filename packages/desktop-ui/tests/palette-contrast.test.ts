/**
 * The palette's own contrast, checked where it is written.
 *
 * The buttons read their states from the tokens — `hover:bg-muted`, `bg-accent`,
 * `border-input`, `text-primary-foreground` — so a pair of tokens that sits too
 * close together is a control nobody can see: the ghost button whose hover is the
 * page, the keycap that is a keycap by name only. This reads the tokens module
 * and measures the pairs those names compose, so the palette cannot regress
 * quietly.
 *
 * The thresholds are WCAG's where the pair carries meaning — 4.5 for text, 3 for
 * the ring that marks a boundary — and a perceptibility floor where the pair is a
 * surface (a hover, a highlight, an edge at rest), which no standard grades but
 * which has to be more than the 1.00 a colour identical to its page measures.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { tokens as palette, resolvedVariables } from 'desktop-ui';

import {
  blend,
  contrastRatio,
  type LinearRgb,
  linearRgb,
  type Oklch,
} from './support/contrast.js';

/** The smallest difference a surface has to make to be seen at all. */
const perceptible = 1.15;
const text = 4.5;
const boundary = 3;

/** One variant's colour tokens, as the window that wears it resolves them. */
const tokensOf = (
  variant: 'light' | 'dark',
): Readonly<Record<string, Oklch>> => {
  const tokens: Record<string, Oklch> = {};

  for (const [name, value] of Object.entries(
    resolvedVariables(palette, variant),
  )) {
    const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
    if (match === null) continue;
    const [, l, c, h] = match;
    tokens[name.slice(2)] = { c: Number(c), h: Number(h), l: Number(l) };
  }

  return tokens;
};

const root = tokensOf('light');
const dark = tokensOf('dark');

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
  ['warning', 'background'],
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
      // in `components/button.tsx` — so the palette is measured as that mix, in both
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
