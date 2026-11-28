import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

import { windowAppearanceSchema } from 'bundle/contracts';

import { splashWindowOptions } from '../src/platform/splash/window';
import { loadWindowTokens } from '../src/platform/tokens';
import {
  chromeFor,
  glassSupported,
  type MaterialTarget,
  materialFor,
  nativeOptions,
  setWindowMaterial,
} from '../src/platform/windows/appearance';

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
  test('the workspace window is transparent glass over the sidebar vibrancy on macOS', () => {
    assert.deepEqual(
      nativeOptions(workspace, tokens, 'darwin', screen, preload),
      {
        width: 1280,
        height: 800,
        minWidth: 960,
        minHeight: 640,
        show: false,
        backgroundColor: '#00000000',
        vibrancy: 'sidebar',
        visualEffectState: 'followWindow',
        titleBarStyle: 'hidden',
        trafficLightPosition: { x: 14, y: 14 },
        webPreferences,
      },
    );
  });

  test('the workspace window is transparent glass over acrylic on Windows 11 22H2 and later', () => {
    const options = nativeOptions(
      workspace,
      tokens,
      'win32',
      screen,
      preload,
      true,
      '10.0.26200',
    );
    assert.equal(options.backgroundColor, '#00000000');
    assert.equal(options.backgroundMaterial, 'acrylic');
    assert.equal(options.vibrancy, undefined);
  });

  test('the workspace window uses the system dark background on Linux and older Windows', () => {
    const older = nativeOptions(
      workspace,
      tokens,
      'win32',
      screen,
      preload,
      true,
      '10.0.19045',
    );
    assert.equal(older.backgroundColor, '#1c1a17');
    assert.equal(older.backgroundMaterial, undefined);
    assert.deepEqual(
      nativeOptions(workspace, tokens, 'linux', screen, preload),
      {
        width: 1280,
        height: 800,
        minWidth: 960,
        minHeight: 640,
        show: false,
        backgroundColor: '#1c1a17',
        webPreferences,
      },
    );
  });

  test('a light appearance paints the native window #fbf8f2 before loading', () => {
    assert.equal(
      nativeOptions(workspace, tokens, 'linux', screen, preload, false)
        .backgroundColor,
      '#fbf8f2',
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
        backgroundColor: '#00000000',
        vibrancy: 'sidebar',
        visualEffectState: 'followWindow',
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
        backgroundColor: '#1c1a17',
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
        width: 610,
        height: 487,
        frame: false,
        roundedCorners: true,
        resizable: false,
        backgroundColor: '#1c1a17',
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
  test('tells an app window on macOS and Windows 11 22H2+, and only it, that it is glass', () => {
    assert.equal(materialFor('path', 'darwin', '25.0.0'), 'glass');
    assert.equal(materialFor('view', 'darwin', '25.0.0'), 'none');
    assert.equal(materialFor(undefined, 'darwin', '25.0.0'), 'none');
    assert.equal(materialFor('path', 'win32', '10.0.22621'), 'glass');
    assert.equal(materialFor('path', 'win32', '10.0.26200'), 'glass');
    assert.equal(materialFor('view', 'win32', '10.0.26200'), 'none');
    assert.equal(materialFor('path', 'win32', '10.0.22000'), 'none');
    assert.equal(materialFor('path', 'win32', '10.0.19045'), 'none');
    assert.equal(materialFor('path', 'linux', '6.8.0'), 'none');
    assert.equal(glassSupported('darwin', '25.0.0'), true);
    assert.equal(glassSupported('win32', '10.0.22621'), true);
    assert.equal(glassSupported('win32', '10.0.22000'), false);
    assert.equal(glassSupported('linux', '6.8.0'), false);
    assert.equal(
      chromeFor('integrated', tokens, false, 'glass').material,
      'glass',
    );
  });

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
      material: 'none',
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

describe('the glass preference', () => {
  test('a window the user turned glass off for is opaque, even where glass can be drawn', () => {
    assert.equal(materialFor('path', 'darwin', '25.0.0', false), 'none');
    assert.equal(materialFor('path', 'win32', '10.0.26200', false), 'none');

    const off = nativeOptions(
      workspace,
      tokens,
      'win32',
      screen,
      preload,
      true,
      '10.0.26200',
      false,
    );
    assert.equal(off.backgroundColor, '#1c1a17');
    assert.equal(off.backgroundMaterial, undefined);
    assert.equal(
      nativeOptions(
        workspace,
        tokens,
        'darwin',
        screen,
        preload,
        true,
        '25.0.0',
        false,
      ).vibrancy,
      undefined,
    );
  });

  /** A window that records the material calls made on it, in order. */
  const recorder = () => {
    const calls: string[] = [];
    const window: MaterialTarget = {
      setBackgroundColor: (color) => {
        calls.push(`color ${color}`);
      },
      setVibrancy: (type) => {
        calls.push(`vibrancy ${type}`);
      },
      setBackgroundMaterial: (material) => {
        calls.push(`material ${material}`);
      },
    };
    return { calls, window };
  };

  test('turning glass on puts the backdrop in before the window turns clear', () => {
    const mac = recorder();
    setWindowMaterial(mac.window, 'glass', 'darwin', '#1c1a17');
    assert.deepEqual(mac.calls, ['vibrancy sidebar', 'color #00000000']);

    const windows = recorder();
    setWindowMaterial(windows.window, 'glass', 'win32', '#1c1a17');
    assert.deepEqual(windows.calls, ['material acrylic', 'color #00000000']);
  });

  test('turning glass off paints the window opaque before the backdrop goes', () => {
    const mac = recorder();
    setWindowMaterial(mac.window, 'none', 'darwin', '#fbf8f2');
    assert.deepEqual(mac.calls, ['color #fbf8f2', 'vibrancy null']);

    const windows = recorder();
    setWindowMaterial(windows.window, 'none', 'win32', '#1c1a17');
    assert.deepEqual(windows.calls, ['color #1c1a17', 'material none']);

    const linux = recorder();
    setWindowMaterial(linux.window, 'none', 'linux', '#1c1a17');
    assert.deepEqual(linux.calls, ['color #1c1a17']);
  });
});
