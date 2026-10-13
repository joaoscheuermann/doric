/** The shared palette and its generated CSS and JSON assets. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PLATFORM_VERSION } from 'bundle';
import { resolvedVariables, tokens, tokensCss } from 'desktop/ui';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string): string =>
  readFileSync(join(packageRoot, path), 'utf8');

describe('the palette', () => {
  test('light and dark use Papermache root, panel and text tones', () => {
    assert.equal(tokens.variants.light['--background'], '#ffffff');
    assert.equal(tokens.variants.light['--sidebar'], '#f2f2f2');
    assert.equal(tokens.variants.light['--paper-panel-highlight-1'], '#eaeaea');
    assert.equal(tokens.variants.light['--paper-control'], '#f9f9f9');
    assert.equal(tokens.variants.light['--paper-separator'], '#e2e2e2');
    assert.equal(
      tokens.variants.light['--paper-gray-1'],
      'oklab(0% none none / 0.8)',
    );
    assert.equal(tokens.variants.dark['--background'], '#222222');
    assert.equal(tokens.variants.dark['--sidebar'], '#2a2a2a');
    assert.equal(tokens.variants.dark['--foreground'], '#e9e9e9');
    assert.equal(tokens.variants.dark['--paper-panel-highlight-1'], '#333333');
    assert.equal(tokens.variants.dark['--paper-control'], '#373737');
    assert.equal(tokens.variants.dark['--paper-separator'], '#373737');
    assert.equal(
      tokens.variants.dark['--paper-gray-1'],
      'oklab(100% 0 5.96046e-8 / 0.9)',
    );
  });

  test('the adapted UI uses the system face and Papermache control geometry', () => {
    assert.equal(
      tokens.shared['--font-sans'],
      "-apple-system, BlinkMacSystemFont, 'Noto Sans', sans-serif",
    );
    assert.equal(tokens.shared['--paper-text-base'], '12px');
    assert.equal(tokens.shared['--paper-radius-control'], '6px');
    assert.equal(tokens.variants.light['--paper-focus'], 'oklch(74% 0.12 258)');
    assert.equal(tokens.variants.dark['--paper-focus'], 'oklch(60% 0.15 258)');
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

  test('the tokens carry the platform version', () => {
    assert.equal(tokens.version, PLATFORM_VERSION);
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
    assert.equal(tokens.window.backgrounds.window.light, '#ffffff');
    assert.equal(tokens.window.backgrounds.window.dark, '#222222');
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
