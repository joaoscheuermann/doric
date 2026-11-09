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
import { splashView } from '../src/splash-page/view';

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

  test('the splash window has rounded corners and no title bar (S12)', () => {
    const options = splashWindowOptions({
      backgroundColor: '#1c1a17',
      preload: '/preload.js',
    });

    assert.equal(options.roundedCorners, true);
    assert.equal(options.frame, false);
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

  describe('error states (S14, S15)', () => {
    const labels = (state: Parameters<typeof splashView>[0]) =>
      splashView(state).actions.map(
        (action) => action.ariaLabel ?? action.label,
      );

    test('Retry comes first in every error state', () => {
      assert.deepEqual(
        labels({
          state: 'host-unreachable',
          hostUrl: 'http://127.0.0.1:3000',
          lastError: 'connect ECONNREFUSED',
          attempts: 1,
          hasSnapshot: true,
        }),
        ['Retry', 'Open last known composition'],
      );
      assert.deepEqual(
        labels({
          state: 'bundle-failure',
          bundles: [
            { id: 'probe-a', version: '1.0.0', reasons: [] },
            { id: 'probe-b', version: '1.0.0', reasons: [] },
          ],
        }),
        [
          'Retry',
          'Continue without them',
          'Disable probe-a',
          'Disable probe-b',
        ],
      );
      assert.deepEqual(
        labels({
          state: 'core-failure',
          core: { id: 'badcore', version: '1.0.0' },
          error: 'the core broke',
          hasLastGoodCore: true,
        }),
        ['Retry', 'Use last core that worked', 'Return to default composition'],
      );
      assert.deepEqual(
        labels({
          state: 'core-failure',
          core: { id: 'badcore', version: '1.0.0' },
          error: 'the core broke',
          hasLastGoodCore: false,
        }),
        ['Retry', 'Return to default composition'],
      );
      assert.deepEqual(
        labels({
          state: 'recovery',
          reason: 'Recovery',
          hasLastGoodCore: true,
        }),
        ['Retry', 'Use last core that worked', 'Return to default composition'],
      );
    });

    test('a bundle failure says some bundles cannot load above the list', () => {
      const view = splashView({
        state: 'bundle-failure',
        bundles: [
          {
            id: 'probe-new',
            version: '1.0.0',
            reasons: [
              { code: 'engines_unsatisfied', message: 'needs doric ^2.0.0' },
            ],
          },
        ],
      });

      assert.deepEqual(view.status, {
        tone: 'error',
        text: 'Some bundles cannot load',
      });
      assert.deepEqual(view.details, {
        kind: 'list',
        items: ['probe-new 1.0.0: needs doric ^2.0.0'],
      });
    });
  });
});
