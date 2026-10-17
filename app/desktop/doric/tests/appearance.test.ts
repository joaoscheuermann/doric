import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

import { windowAppearanceSchema } from 'bundle/contracts';

import { splashWindowOptions } from '../src/platform/splash/window';
import { loadWindowTokens } from '../src/platform/tokens';
import { chromeFor, nativeOptions } from '../src/platform/windows/appearance';

const tokensPath = resolve('packages/desktop/dist/tokens.json');
const tokens = loadWindowTokens(tokensPath);
const preload = '/app/preload.js';
const screen = { width: 2560, height: 1440 };

// The core's intents (bundles/foundation/core/src/desktop/appearance.ts).
const workspace = windowAppearanceSchema.parse({
  size: { width: 1280, height: 800, minWidth: 960, minHeight: 640 },
  titleBar: 'integrated',
});
const settings = windowAppearanceSchema.parse({
  size: { width: 960, height: 720, minWidth: 720, minHeight: 520 },
  titleBar: 'integrated',
});

const webPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  preload,
  sandbox: true,
};

describe('native window options', () => {
  test('the workspace window uses the system dark background on macOS and Linux', () => {
    assert.deepEqual(
      nativeOptions(workspace, tokens, 'darwin', screen, preload),
      {
        width: 1280,
        height: 800,
        minWidth: 960,
        minHeight: 640,
        show: false,
        backgroundColor: '#222222',
        titleBarStyle: 'hidden',
        trafficLightPosition: { x: 14, y: 14 },
        webPreferences,
      },
    );
    assert.deepEqual(
      nativeOptions(workspace, tokens, 'linux', screen, preload),
      {
        width: 1280,
        height: 800,
        minWidth: 960,
        minHeight: 640,
        show: false,
        backgroundColor: '#222222',
        webPreferences,
      },
    );
  });

  test('a light system preference paints the native window white before loading', () => {
    assert.equal(
      nativeOptions(workspace, tokens, 'darwin', screen, preload, false)
        .backgroundColor,
      '#ffffff',
    );
  });

  test('the settings window uses the shared chrome and background', () => {
    assert.deepEqual(
      nativeOptions(settings, tokens, 'darwin', screen, preload),
      {
        width: 960,
        height: 720,
        minWidth: 720,
        minHeight: 520,
        show: false,
        backgroundColor: '#222222',
        titleBarStyle: 'hidden',
        trafficLightPosition: { x: 14, y: 14 },
        webPreferences,
      },
    );
    assert.deepEqual(
      nativeOptions(settings, tokens, 'linux', screen, preload),
      {
        width: 960,
        height: 720,
        minWidth: 720,
        minHeight: 520,
        show: false,
        backgroundColor: '#222222',
        webPreferences,
      },
    );
  });

  test('the splash window uses the dark native background', () => {
    assert.deepEqual(
      splashWindowOptions({
        backgroundColor: tokens.color('window', true),
        preload,
      }),
      {
        width: 420,
        height: 260,
        frame: false,
        roundedCorners: false,
        resizable: false,
        backgroundColor: '#222222',
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          preload,
        },
      },
    );
  });

  test('a window without a size gets Electron’s default, and no window exceeds the work area', () => {
    const plain = windowAppearanceSchema.parse({});
    const small = { width: 1024, height: 700 };

    assert.equal(
      nativeOptions(plain, tokens, 'linux', screen, preload).width,
      800,
    );
    assert.equal(
      nativeOptions(plain, tokens, 'linux', screen, preload).height,
      600,
    );
    assert.equal(
      nativeOptions(workspace, tokens, 'linux', small, preload).width,
      1024,
    );
    assert.equal(
      nativeOptions(workspace, tokens, 'linux', small, preload).height,
      700,
    );
  });

  test('a frameless intent drops the frame; a native one keeps it on macOS', () => {
    const none = windowAppearanceSchema.parse({ titleBar: 'none' });
    const native = windowAppearanceSchema.parse({ titleBar: 'native' });

    assert.equal(
      nativeOptions(none, tokens, 'darwin', screen, preload).frame,
      false,
    );
    assert.equal(
      nativeOptions(native, tokens, 'darwin', screen, preload).titleBarStyle,
      undefined,
    );
  });

  test('an unknown background token is refused', () => {
    const odd = windowAppearanceSchema.parse({ background: 'nope' });

    assert.throws(() => nativeOptions(odd, tokens, 'linux', screen, preload));
  });
});

describe('window chrome', () => {
  test('releases the native controls inset in fullscreen', () => {
    assert.deepEqual(chromeFor('integrated', tokens, true).safeArea, {
      top: 0,
      left: 0,
      right: 0,
    });
    assert.equal(chromeFor('integrated', tokens, true).height, 40);
  });
  test('keeps the 80px reserved width with a 40px title bar', () => {
    assert.deepEqual(chromeFor('integrated', tokens), {
      titleBar: 'integrated',
      height: 40,
      safeArea: { top: 0, left: 80, right: 0 },
    });
    assert.deepEqual(chromeFor('native', tokens).safeArea, {
      top: 0,
      left: 80,
      right: 0,
    });
    assert.deepEqual(chromeFor('none', tokens).safeArea, {
      top: 0,
      left: 0,
      right: 0,
    });
  });

  test('doric.tokens/v1 serves what desktop/ui resolves for a window', async () => {
    // desktop/ui's root entry (React components); its source is not this
    // project's to typecheck, so it is loaded by name.
    const entry: string = 'desktop/ui';
    const { resolvedVariables } = (await import(entry)) as {
      resolvedVariables(tokens: unknown): Readonly<Record<string, string>>;
    };
    const source = JSON.parse(readFileSync(tokensPath, 'utf8'));

    assert.deepEqual(tokens.variables(), resolvedVariables(source));
  });
});
