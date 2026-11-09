import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

import {
  remainingSplashMs,
  splashMinimumMs,
} from '../src/platform/splash/timing';
import {
  splashArtOverride,
  splashWindowOptions,
} from '../src/platform/splash/window';

const page = (name: string): string =>
  readFileSync(resolve('app/desktop/doric/src/splash-page', name), 'utf8');

const tokens = JSON.parse(
  readFileSync(resolve('packages/desktop/dist/tokens.json'), 'utf8'),
) as { variants: { dark: Record<string, string> } };

describe('splash screen', () => {
  test('the splash page has the art pane and the wordmark', () => {
    const markup = page('index.html');

    assert.match(markup, /<html lang="en">/u);
    assert.match(markup, /content="light dark"/u);
    assert.match(markup, /<title>Doric<\/title>/u);
    assert.match(markup, /href="\/platform\/desktop@1\.0\.0\/theme\.css"/u);
    assert.match(markup, /<[a-z]+[^>]*\sdata-art-pane[\s>=]/u);
    assert.match(markup, /<svg[^>]*\saria-label="Doric"/u);
    assert.doesNotMatch(markup, /splash-title/u);
    assert.equal(tokens.variants.dark['--background'], '#1c1a17');
    assert.equal(tokens.variants.dark['--foreground'], '#e8e2d6');
  });

  test('the splash window is 610×487', () => {
    const options = splashWindowOptions({
      backgroundColor: '#1c1a17',
      preload: '/preload.js',
    });

    assert.equal(options.width, 610);
    assert.equal(options.height, 487);
  });

  test('DORIC_SPLASH_ART=shaded asks for the shaded art only in an unpackaged build', () => {
    const shaded = { DORIC_SPLASH_ART: 'shaded' };

    assert.equal(splashArtOverride({ packaged: false, env: shaded }), 'shaded');
    assert.equal(splashArtOverride({ packaged: true, env: shaded }), undefined);
    assert.equal(splashArtOverride({ packaged: false, env: {} }), undefined);
    assert.equal(
      splashArtOverride({
        packaged: false,
        env: { DORIC_SPLASH_ART: 'shader' },
      }),
      undefined,
    );
  });

  test('stays visible for five seconds when the backend answers instantly', () => {
    assert.equal(splashMinimumMs, 5_000);
    assert.equal(remainingSplashMs(0), 5_000);
    assert.equal(remainingSplashMs(4_999), 1);
    assert.equal(remainingSplashMs(5_000), 0);
    assert.equal(remainingSplashMs(30_000), 0);
  });
});
