import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

import {
  remainingSplashMs,
  splashMinimumMs,
} from '../src/platform/splash/timing';

const page = (name: string): string =>
  readFileSync(resolve('app/desktop/doric/src/splash-page', name), 'utf8');

const tokens = JSON.parse(
  readFileSync(resolve('packages/desktop/dist/tokens.json'), 'utf8'),
) as { variants: { dark: Record<string, string> } };

describe('splash screen', () => {
  test('shows the Doric name centered with the system theme', () => {
    const markup = page('index.html');
    const css = page('splash.css');

    assert.match(markup, /<html lang="en">/u);
    assert.match(markup, /content="light dark"/u);
    assert.match(markup, /<title>Doric<\/title>/u);
    assert.match(markup, /<div class="splash-title">Doric<\/div>/u);
    assert.match(markup, /href="\/platform\/desktop@1\.0\.0\/theme\.css"/u);
    assert.match(css, /justify-content: center/u);
    assert.match(css, /align-items: center/u);
    assert.match(css, /background: var\(--background\)/u);
    assert.match(css, /color: var\(--foreground\)/u);
    assert.match(css, /font:\s*600 32px\s*\/\s*1\.2 system-ui,\s*sans-serif/u);
    assert.equal(tokens.variants.dark['--background'], '#222222');
    assert.equal(tokens.variants.dark['--foreground'], '#e9e9e9');
  });

  test('stays visible for five seconds when the backend answers instantly', () => {
    assert.equal(splashMinimumMs, 5_000);
    assert.equal(remainingSplashMs(0), 5_000);
    assert.equal(remainingSplashMs(4_999), 1);
    assert.equal(remainingSplashMs(5_000), 0);
    assert.equal(remainingSplashMs(30_000), 0);
  });
});
