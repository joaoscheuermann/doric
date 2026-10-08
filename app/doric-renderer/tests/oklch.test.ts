import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { oklchToHex } from '../src/utility/oklch';

/**
 * The colours below are published values, not values taken from this code.
 *
 * - White and black are what Oklab is defined by: `oklab(1 0 0)` is sRGB white
 *   and `oklab(0 0 0)` is black, whatever the hue of a colour with no chroma.
 * - The three primaries are the table CSS Color 4 publishes for the two spaces
 *   — `rgb(100% 0 0)` is `oklch(62.796% 0.25768 29.234)`, and so on — quoted
 *   here as that table writes them.
 * - `oklch(0.5 0 0)` is worked out by hand from that same definition: Oklab's
 *   lightness of a neutral is the cube root of its linear luminance, so `0.5`
 *   is a linear `0.125`, and the sRGB transfer function turns that into
 *   `1.055 * 0.125 ** (1 / 2.4) - 0.055 = 0.3885729`, which rounds to 99/255.
 * - Every value here was also read back from Chromium, whose `oklch()` is the
 *   implementation the editor's own Chromium will paint: a one-pixel canvas
 *   filled with the colour and read with `getImageData`. It agrees with the
 *   conversion everywhere, except where a channel sits on a rounding boundary
 *   — Chromium calls `oklch(0.5 0.13 152)` `#04773b` where this calls it
 *   `#05773b`, one bit apart in a channel two per cent of the way up.
 */
const published: readonly (readonly [string, string])[] = [
  ['oklch(1 0 0)', '#ffffff'],
  ['oklch(0 0 0)', '#000000'],
  ['oklch(62.796% 0.25768 29.234)', '#ff0000'],
  ['oklch(86.644% 0.29483 142.495)', '#00ff00'],
  ['oklch(45.201% 0.31321 264.052)', '#0000ff'],
  ['oklch(0.5 0 0)', '#636363'],
  ['oklch(0.7 0.15 30)', '#ed7665'],
  // The palette's own background, in the syntax every token is written in.
  ['oklch(0.2244 0.0074 67.437)', '#1e1b18'],
];

describe('oklch to hex', () => {
  test('reads a colour as the published value it has in sRGB', () => {
    for (const [value, hex] of published) {
      assert.equal(oklchToHex(value), hex, value);
    }
  });

  test('reads the text a computed style hands back', () => {
    // `getComputedStyle` pads a token with the whitespace of the declaration,
    // and CSS is not case sensitive.
    assert.equal(oklchToHex('  oklch(0.5 0 0)  '), '#636363');
    assert.equal(oklchToHex('OKLCH(0.5 0 0)'), '#636363');
  });

  test('writes an alpha that is not one as two more digits', () => {
    assert.equal(oklchToHex('oklch(0.5 0 0 / 0.5)'), '#63636380');
    assert.equal(oklchToHex('oklch(0.5 0 0 / 50%)'), '#63636380');
    assert.equal(oklchToHex('oklch(0.5 0 0 / 0)'), '#63636300');
    assert.equal(oklchToHex('oklch(0.5 0 0 / 1)'), '#636363');
  });

  test('clamps a colour outside the sRGB gamut, as CSS does', () => {
    assert.equal(oklchToHex('oklch(1.2 0 0)'), '#ffffff');
    assert.equal(oklchToHex('oklch(-0.2 0 0)'), '#000000');
    assert.equal(oklchToHex('oklch(1 0.5 30)'), '#ff0000');
  });

  test('refuses text that is not an oklch colour the palette writes', () => {
    for (const value of [
      '',
      'red',
      '#1e1b18',
      'rgb(30 27 24)',
      'oklch()',
      'oklch(0.5 0.1)',
      'oklch(0.5 0.1 200 300)',
      'oklch(none none none)',
      // A hue in another unit, and a chroma as a percentage of 0.4 rather than
      // of one: refused rather than read wrongly.
      'oklch(0.5 0.1 200deg)',
      'oklch(0.5 0.1 3.49rad)',
      'oklch(0.5 10% 200)',
      // Neither is a colour CSS accepts.
      'oklch(0.5 -0.1 200)',
      'oklch(0.5 0.1 200 / )',
      'oklch(0.5 0.1 200 / 0.5 / 0.5)',
    ]) {
      assert.equal(oklchToHex(value), undefined, value);
    }
  });
});
