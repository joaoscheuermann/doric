import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { resolveThemeSource } from '../src/platform/appearance';

const resolve = (packaged: boolean, theme?: string) =>
  resolveThemeSource({
    packaged,
    env: theme === undefined ? {} : { DORIC_THEME: theme },
  });

describe('the theme main gives nativeTheme', () => {
  test('a packaged build is always dark, whatever DORIC_THEME says', () => {
    for (const theme of [undefined, 'light', 'system']) {
      assert.equal(resolve(true, theme), 'dark', String(theme));
    }
  });

  test('an unpackaged build follows a known DORIC_THEME', () => {
    for (const theme of ['light', 'dark', 'system'] as const) {
      assert.equal(resolve(false, theme), theme);
    }
  });

  test('an unpackaged build is dark when DORIC_THEME is missing, empty or unknown', () => {
    for (const theme of [undefined, '', 'LIGHT', 'blue']) {
      assert.equal(resolve(false, theme), 'dark', String(theme));
    }
  });
});
