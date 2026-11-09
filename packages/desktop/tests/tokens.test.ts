/** The shared palette and its generated CSS and JSON assets. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PLATFORM_ASSETS_VERSION } from 'bundle';
import { resolvedVariables, tokens, tokensCss } from 'desktop/ui';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string): string =>
  readFileSync(join(packageRoot, path), 'utf8');

describe('the palette', () => {
  test('the UI uses Noto Sans first and Papermache control geometry', () => {
    const face = "'Noto Sans', -apple-system, BlinkMacSystemFont, sans-serif";

    assert.equal(tokens.shared['--font-sans'], face);
    assert.equal(tokens.shared['--font-serif'], face);
    assert.equal(tokens.shared['--paper-text-base'], '12px');
    assert.equal(tokens.shared['--paper-radius-control'], '6px');
  });

  test('both variants cast the same black shadows', () => {
    const names = [
      '--shadow-color',
      '--shadow-2xs',
      '--shadow-xs',
      '--shadow-sm',
      '--shadow',
      '--shadow-md',
      '--shadow-lg',
      '--shadow-xl',
      '--shadow-2xl',
    ] as const;

    for (const name of names) {
      const light = tokens.variants.light[name];

      assert.equal(tokens.variants.dark[name], light, name);
      assert.match(String(light), /hsl\(0 0% 0%/u, name);
    }
  });

  test('the stylesheet applies dark tokens before first paint with system preference', () => {
    assert.match(tokensCss(tokens), /@media \(prefers-color-scheme: dark\)/u);
  });

  test('the light fallback is available before the system preference resolves', () => {
    assert.equal(tokens.defaultVariant, 'light');
    assert.deepEqual(
      resolvedVariables(tokens),
      resolvedVariables(tokens, 'light'),
    );
  });

  test('the palette leaves the change colours to the bundle that draws them', () => {
    const names = Object.keys(resolvedVariables(tokens));
    assert.deepEqual(
      names.filter((name) => name.startsWith('--git-')),
      [],
    );
  });

  test('the tokens carry the platform assets version', () => {
    assert.equal(tokens.version, PLATFORM_ASSETS_VERSION);
  });
});

describe('the window tokens', () => {
  test('the titlebar is 40px', () => {
    assert.equal(tokens.window.titlebarHeight, 40);
    assert.equal(resolvedVariables(tokens)['--doric-titlebar-height'], '40px');
  });

  test("the window buttons' reserved width is the renderer's pl-20", () => {
    assert.equal(tokens.window.trafficLight.reservedWidth, 20 * 4);
    assert.equal(tokens.window.trafficLight.size, 12);
    assert.equal(tokens.window.trafficLight.insetX, 14);
  });

  test('native window backgrounds match both page backgrounds', () => {
    assert.deepEqual(tokens.window.backgrounds.window, {
      light: '#fbf8f2',
      dark: '#1c1a17',
    });
  });

  for (const variant of ['light', 'dark'] as const) {
    test(`the ${variant} window background is that variant's --background`, () => {
      const background = resolvedVariables(tokens, variant)['--background'];
      assert.equal(tokens.window.backgrounds.window[variant], background);
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
