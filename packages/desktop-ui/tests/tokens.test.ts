/**
 * The tokens module is the palette the renderer's stylesheet stated before the
 * platform existed (`fixtures/styles.css`, the 777-line file at 20775a6), and
 * the generated `tokens.css` and `tokens.json` are that module, nothing else.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PLATFORM_VERSION } from 'bundle';
import { resolvedVariables, tokens, tokensCss } from 'desktop-ui';

import { oklchToHex } from './support/oklch.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string): string =>
  readFileSync(join(packageRoot, path), 'utf8');

const stylesheet = read('tests/fixtures/styles.css');

/** The custom properties one block of the old stylesheet declares. */
const declared = (selector: string): Record<string, string> => {
  const start = stylesheet.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `the old stylesheet states ${selector}`);
  const block = stylesheet
    .slice(start + selector.length + 2, stylesheet.indexOf('}', start))
    .replaceAll(/\/\*[\s\S]*?\*\//g, '');
  const result: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(
    /(--[a-z0-9-]+):\s*([\s\S]*?);/g,
  )) {
    result[name ?? ''] = (value ?? '').split(/\s+/).join(' ').trim();
  }
  return result;
};

/**
 * The palette variables a variant resolves, without the window variables and
 * without the git colours: those belong to the git bundle, which states them in
 * its own stylesheet (its test pins them to the values the old palette had).
 */
const palette = (variant: 'light' | 'dark'): Record<string, string> =>
  Object.fromEntries(
    Object.entries(resolvedVariables(tokens, variant)).filter(
      ([name]) => !name.startsWith('--doric-') && !name.startsWith('--git-'),
    ),
  );

/** The old block without its git colours, the palette the desktop-ui module owns. */
const withoutGit = (block: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(block).filter(([name]) => !name.startsWith('--git-')),
  );

const channels = (hex: string): number[] =>
  [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));

describe('the palette', () => {
  test('the light variant resolves exactly what the old :root stated', () => {
    assert.deepEqual(palette('light'), withoutGit(declared(':root')));
  });

  test('the dark variant resolves :root as .dark overrode it', () => {
    assert.deepEqual(palette('dark'), {
      ...withoutGit(declared(':root')),
      ...withoutGit(declared('.dark')),
    });
  });

  test('windows start dark', () => {
    assert.equal(tokens.defaultVariant, 'dark');
    assert.deepEqual(
      resolvedVariables(tokens),
      resolvedVariables(tokens, 'dark'),
    );
  });

  test('the palette leaves the change colours to the bundle that draws them', () => {
    const names = Object.keys(resolvedVariables(tokens));
    assert.deepEqual(
      names.filter((name) => name.startsWith('--git-')),
      [],
    );
  });

  test('the tokens carry the platform version', () => {
    assert.equal(tokens.version, PLATFORM_VERSION);
  });
});

describe('the window tokens', () => {
  test('the titlebar is the old chrome bar height, 2.25rem', () => {
    assert.equal(tokens.window.titlebarHeight, 2.25 * 16);
    assert.equal(
      resolvedVariables(tokens)['--doric-titlebar-height'],
      `${2.25 * 16}px`,
    );
  });

  test("the window buttons' reserved width is the renderer's pl-20", () => {
    assert.equal(tokens.window.trafficLight.reservedWidth, 20 * 4);
    assert.equal(tokens.window.trafficLight.size, 12);
    assert.equal(tokens.window.trafficLight.insetX, 14);
  });

  test("the dark window background is today's native #1c1b19", () => {
    assert.equal(tokens.window.backgrounds.window.dark, '#1c1b19');
  });

  for (const variant of ['light', 'dark'] as const) {
    test(`the ${variant} window background is that variant's --background`, () => {
      const background = resolvedVariables(tokens, variant)['--background'];
      const converted = oklchToHex(background ?? '');
      assert.ok(converted, `--background converts to sRGB`);
      const expected = channels(converted);
      const actual = channels(tokens.window.backgrounds.window[variant]);
      for (const [index, value] of actual.entries()) {
        assert.ok(
          Math.abs(value - (expected[index] ?? 0)) <= 2,
          `${tokens.window.backgrounds.window[variant]} is within rounding of ${converted}`,
        );
      }
    });
  }

  test('the window background follows the page background', () => {
    assert.equal(
      resolvedVariables(tokens)['--doric-window-background'],
      'var(--background)',
    );
  });

  test('a window has no safe area until its shell applies one', () => {
    const variables = resolvedVariables(tokens);
    assert.equal(variables['--doric-safe-top'], '0px');
    assert.equal(variables['--doric-safe-left'], '0px');
  });
});

describe('the generated files', () => {
  test('tokens.css is what the tokens module generates', () => {
    assert.equal(read('src/styles/tokens.css'), tokensCss(tokens));
  });

  test('tokens.json is the tokens module serialized', () => {
    assert.deepEqual(JSON.parse(read('dist/tokens.json')), tokens);
  });
});
