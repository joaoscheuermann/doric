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

import { tokens as palette, resolvedVariables } from 'desktop/ui';
import { Button } from 'desktop/ui/button';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  blend,
  contrastRatio,
  type LinearRgb,
  linearRgb,
  mixOklch,
  oklch,
} from './support/contrast.js';

/** The smallest difference a surface has to make to be seen at all. */
const perceptible = 1.07;
const text = 4.5;
const boundary = 3;
/** How far a hovered filled button has to move from its rest colour. */
const hoverChange = 1.1;

/** One variant's colour tokens, as the window that wears it resolves them. */
const tokensOf = (
  variant: 'light' | 'dark',
): Readonly<Record<string, LinearRgb>> => {
  const tokens: Record<string, LinearRgb> = {};

  for (const [name, value] of Object.entries(
    resolvedVariables(palette, variant),
  )) {
    const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
    if (match !== null) {
      const [, l, c, h] = match;
      tokens[name.slice(2)] = linearRgb({
        c: Number(c),
        h: Number(h),
        l: Number(l),
      });
      continue;
    }
    const hex = /^#([0-9a-f]{6})$/i.exec(value);
    if (hex === null) continue;
    const channel = (offset: number) => {
      const srgb = Number.parseInt(hex[1].slice(offset, offset + 2), 16) / 255;
      return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    };
    tokens[name.slice(2)] = [channel(0), channel(2), channel(4)];
  }

  return tokens;
};

/** The classes the default Button renders with, as the window receives them. */
const defaultButtonClasses = (): readonly string[] => {
  const markup = renderToStaticMarkup(createElement(Button, null, 'Save'));
  const match = /class="([^"]*)"/.exec(markup);
  assert.notEqual(match, null, `the default Button renders a class: ${markup}`);

  return (match as RegExpExecArray)[1].split(/\s+/);
};

/**
 * The hover the default Button states for one theme: the two tokens its
 * `color-mix(in oklch, …)` blends and the share the second one takes.
 */
const buttonHover = (
  theme: 'light' | 'dark',
): { from: string; to: string; amount: number } => {
  const prefix = theme === 'light' ? 'hover:' : 'dark:hover:';
  const pattern =
    /^bg-\[color-mix\(in_oklch,var\(--([\w-]+)\),var\(--([\w-]+)\)_([\d.]+)%\)\]$/;
  const classes = defaultButtonClasses();
  const hover = classes
    .filter((name) => name.startsWith(prefix))
    .map((name) => pattern.exec(name.slice(prefix.length)))
    .find((match) => match !== null);
  assert.ok(
    hover !== undefined && hover !== null,
    `the default Button hovers in the ${theme} theme with ${prefix}bg-[color-mix(in_oklch,var(--A),var(--B)_N%)], but its classes are: ${classes.join(' ')}`,
  );
  const [, from, to, amount] = hover;

  return { amount: Number(amount) / 100, from, to };
};

const root = tokensOf('light');
const dark = tokensOf('dark');

/** The token one theme states under a name, or a failure that names it. */
const colour = (
  tokens: Readonly<Record<string, LinearRgb>>,
  name: string,
): LinearRgb => {
  const value = tokens[name];
  assert.notEqual(value, undefined, `the palette states --${name}`);

  return value as LinearRgb;
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
  // Papermache's filled control is #f9f9f9 on white. Its border and inset
  // shadow supply the boundary; the fill alone is intentionally subtler.
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

    test('a hovered filled button keeps its text readable and visibly changes', () => {
      // A filled button's hover is not a colour in the palette but a mix of
      // two of its tokens, which the default Button's own class names.
      // The redesign states it: light mixes 60% of the foreground into the
      // primary, dark mixes 8% of the primary foreground into it.
      const { amount, from, to } = buttonHover(theme);
      assert.deepEqual(
        { amount, from, to },
        theme === 'light'
          ? { amount: 0.6, from: 'primary', to: 'foreground' }
          : { amount: 0.08, from: 'primary', to: 'primary-foreground' },
        `the default Button's ${theme} hover mixes the tokens the redesign names`,
      );
      const primary = colour(tokens, 'primary');
      const label = colour(tokens, 'primary-foreground');
      const hovering = mixOklch(
        colour(tokens, from),
        colour(tokens, to),
        amount,
      );
      const onText = contrastRatio(label, hovering);
      const change = contrastRatio(hovering, primary);

      assert.ok(
        onText >= text,
        `the label on the hovered primary is ${onText.toFixed(2)}:1, under ${text}`,
      );
      assert.ok(
        change >= hoverChange,
        `the hovered primary is ${change.toFixed(2)}:1 against the primary at rest, under ${hoverChange}`,
      );
    });
  });
}

describe('the oklch helpers the hover is measured with', () => {
  const near = (actual: number, expected: number, tolerance: number) =>
    Math.abs(actual - expected) <= tolerance;
  const same = (actual: LinearRgb, expected: LinearRgb, tolerance = 1e-6) =>
    actual.every((channel, index) =>
      near(channel, expected[index] ?? Number.NaN, tolerance),
    );
  const samples: readonly LinearRgb[] = [
    [1, 1, 1],
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [0.2, 0.5, 0.8],
    [1.1, -0.05, 0.3],
  ];

  test('reads sRGB red as the oklch CSS Color 4 publishes for it', () => {
    const red = oklch([1, 0, 0]);

    assert.ok(near(red.l, 0.62796, 1e-4), `l is ${red.l}`);
    assert.ok(near(red.c, 0.25768, 1e-4), `c is ${red.c}`);
    assert.ok(near(red.h, 29.234, 1e-2), `h is ${red.h}`);
  });

  test('a colour read as oklch converts back to itself', () => {
    for (const sample of samples) {
      const back = linearRgb(oklch(sample));

      assert.ok(same(back, sample), `${sample} came back as ${back}`);
    }
  });

  test('a mix at 0 is its first colour and at 1 its second', () => {
    for (const from of samples) {
      for (const to of samples) {
        assert.ok(same(mixOklch(from, to, 0), from), `${from} to ${to} at 0`);
        assert.ok(same(mixOklch(from, to, 1), to), `${from} to ${to} at 1`);
      }
    }
  });

  test('white and black mixed half and half are the neutral of lightness 0.5', () => {
    // Oklab's neutral lightness is the cube root of its linear luminance.
    assert.ok(same(mixOklch([1, 1, 1], [0, 0, 0], 0.5), [0.125, 0.125, 0.125]));
  });

  test('hues mix along the shorter arc', () => {
    const from = linearRgb({ l: 0.6, c: 0.1, h: 350 });
    const to = linearRgb({ l: 0.6, c: 0.1, h: 30 });

    assert.ok(near(oklch(mixOklch(from, to, 0.5)).h, 10, 1e-3));
  });
});
