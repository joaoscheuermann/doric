import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  remainingSplashMs,
  splashMinimumMs,
  splashUrl,
} from '../src/startup/splash';

describe('splash screen', () => {
  test('shows the Doric name centered on a dark background', () => {
    const prefix = 'data:text/html;charset=utf-8,';
    assert.ok(splashUrl.startsWith(prefix));
    const markup = decodeURIComponent(splashUrl.slice(prefix.length));
    assert.match(markup, /<body>Doric<\/body>/u);
    assert.match(markup, /justify-content: center/u);
    assert.match(markup, /background: oklch\(0\.2244 0\.0074 67\.437\)/u);
    assert.match(markup, /color: oklch\(0\.9288 0\.0126 255\.5078\)/u);
  });

  test('stays visible for five seconds when the backend answers instantly', () => {
    assert.equal(splashMinimumMs, 5_000);
    assert.equal(remainingSplashMs(0), 5_000);
    assert.equal(remainingSplashMs(4_999), 1);
    assert.equal(remainingSplashMs(5_000), 0);
    assert.equal(remainingSplashMs(30_000), 0);
  });
});
