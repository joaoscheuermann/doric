import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  applyTheme,
  resolveThemeSource,
  type ThemeSource,
} from '../src/platform/appearance';

const resolve = (packaged: boolean, theme?: string) =>
  resolveThemeSource({
    packaged,
    env: theme === undefined ? {} : { DORIC_THEME: theme },
  });

describe('the theme main gives nativeTheme', () => {
  test('a packaged build with nothing stored is dark, whatever DORIC_THEME says', () => {
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

describe('the theme main gives nativeTheme, with a stored preference (T-4.1.5)', () => {
  test('a packaged build shows the stored preference and ignores DORIC_THEME', () => {
    assert.equal(
      resolveThemeSource({
        packaged: true,
        env: { DORIC_THEME: 'light' },
        stored: 'system',
      }),
      'system',
    );
  });

  test('an unpackaged build lets a known DORIC_THEME win over the stored preference', () => {
    assert.equal(
      resolveThemeSource({
        packaged: false,
        env: { DORIC_THEME: 'light' },
        stored: 'dark',
      }),
      'light',
    );
  });

  test('an unknown DORIC_THEME leaves the stored preference', () => {
    assert.equal(
      resolveThemeSource({
        packaged: false,
        env: { DORIC_THEME: 'blue' },
        stored: 'light',
      }),
      'light',
    );
  });

  test('with no DORIC_THEME and nothing stored the app is dark', () => {
    assert.equal(resolveThemeSource({ packaged: false, env: {} }), 'dark');
  });
});

describe('applying a theme choice (T-4.1.8)', () => {
  const recorder = () => {
    const shown: ThemeSource[] = [];

    return {
      shown,
      setThemeSource: (source: ThemeSource) => {
        shown.push(source);
      },
    };
  };

  test('a store that cannot save rejects, and the shown theme never changes', async () => {
    const { shown, setThemeSource } = recorder();
    const failure = new Error('read-only');

    await assert.rejects(
      applyTheme({
        store: { set: async () => Promise.reject(failure) },
        theme: 'light',
        packaged: true,
        env: {},
        setThemeSource,
      }),
      failure,
    );
    assert.deepEqual(shown, []);
  });

  test('a saved choice is shown once, after the save, as resolveThemeSource resolves it', async () => {
    // Packaged, DORIC_THEME is ignored; unpackaged, it wins over the choice.
    const cases = [
      { packaged: true, expected: 'light' },
      { packaged: false, expected: 'system' },
    ] as const;

    for (const { packaged, expected } of cases) {
      const { shown, setThemeSource } = recorder();
      const saved: ThemeSource[] = [];
      const store = {
        set: async (theme: ThemeSource) => {
          assert.deepEqual(shown, [], 'shown before it was saved');
          saved.push(theme);
        },
      };

      await applyTheme({
        store,
        theme: 'light',
        packaged,
        env: { DORIC_THEME: 'system' },
        setThemeSource,
      });

      assert.deepEqual(saved, ['light'], String(packaged));
      assert.deepEqual(shown, [expected], String(packaged));
    }
  });
});
