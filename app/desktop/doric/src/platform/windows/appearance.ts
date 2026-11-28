// A window's visual intent (window-appearance.md) as Electron constructor
// options, plus the chrome and safe area its shell applies.

import { release as osRelease } from 'node:os';

import type { windowAppearanceSchema } from 'bundle/contracts';
import type { WindowChrome } from 'desktop/protocol';
import type { z } from 'zod';

import type { WindowTokens } from '../tokens';

export type ParsedAppearance = z.output<typeof windowAppearanceSchema>;

/** Electron's default size, used when an appearance names none. */
export const PLATFORM_DEFAULT_SIZE = { width: 800, height: 600 } as const;
/** No window is created smaller than this. */
export const FIXED_MINIMUM = { width: 320, height: 240 } as const;

export interface WorkArea {
  readonly width: number;
  readonly height: number;
}

/** The native material behind a window's page (window-appearance.md). */
export type WindowMaterial = NonNullable<WindowChrome['material']>;

/**
 * The fully transparent background a glass window is created with: an opaque
 * one would cover the vibrancy view.
 */
export const GLASS_BACKGROUND = '#00000000';

/**
 * The first Windows build whose windows take a system-drawn backdrop
 * (`backgroundMaterial`): Windows 11 22H2. An older Windows ignores the
 * option, so a transparent window there would show no frosted desktop.
 */
export const WINDOWS_BACKDROP_BUILD = 22621;

/**
 * Whether the system can draw a frosted backdrop behind a window: macOS, and
 * Windows 11 22H2 or later. `release` is `os.release()`, whose third part is
 * the Windows build.
 */
export const glassSupported = (
  platform: NodeJS.Platform,
  release: string = osRelease(),
): boolean => {
  if (platform === 'darwin') return true;
  if (platform !== 'win32') return false;
  const build = Number(release.split('.')[2]);
  return Number.isInteger(build) && build >= WINDOWS_BACKDROP_BUILD;
};

/**
 * An app window is glass when the user keeps it on (`enabled`, the saved
 * `glass` preference) and the system can draw it ({@link glassSupported}):
 * main puts the system's frosted backdrop (macOS's `sidebar` vibrancy,
 * Windows' acrylic) behind its page, so the window's frame shows a blurred
 * desktop. A view window shows a page of the host that knows nothing of the
 * material, and every other window stays opaque.
 */
export const materialFor = (
  kind: 'path' | 'view' | undefined,
  platform: NodeJS.Platform,
  release: string = osRelease(),
  enabled = true,
): WindowMaterial =>
  kind === 'path' && enabled && glassSupported(platform, release)
    ? 'glass'
    : 'none';

/** The calls that change the material of a window already open. */
export type MaterialTarget = Pick<
  Electron.BrowserWindow,
  'setBackgroundColor' | 'setVibrancy' | 'setBackgroundMaterial'
>;

/**
 * Puts `material` behind an open window, as {@link nativeOptions} would have
 * created it: glass makes it transparent over the system's backdrop; `none`
 * removes the backdrop and paints it `opaque` (the `window` token's color in
 * the current theme). The backdrop goes in before the color turns clear and
 * out after it turns opaque, so the window never shows a bare transparent
 * frame.
 */
export const setWindowMaterial = (
  window: MaterialTarget,
  material: WindowMaterial,
  platform: NodeJS.Platform,
  opaque: string,
): void => {
  if (material === 'glass') {
    if (platform === 'darwin') window.setVibrancy('sidebar');
    else if (platform === 'win32') window.setBackgroundMaterial('acrylic');
    window.setBackgroundColor(GLASS_BACKGROUND);
    return;
  }
  window.setBackgroundColor(opaque);
  if (platform === 'darwin') window.setVibrancy(null);
  else if (platform === 'win32') window.setBackgroundMaterial('none');
};

/** The native options that put the frosted backdrop behind a glass window. */
const glassOptions = (
  platform: NodeJS.Platform,
): Electron.BrowserWindowConstructorOptions =>
  platform === 'darwin'
    ? {
        backgroundColor: GLASS_BACKGROUND,
        vibrancy: 'sidebar',
        visualEffectState: 'followWindow',
      }
    : { backgroundColor: GLASS_BACKGROUND, backgroundMaterial: 'acrylic' };

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(value, maximum));

/**
 * The constructor options every window shares, without web preferences: a
 * `BaseWindow` has none of its own, and a view window's belong to its
 * `WebContentsView`. The `titleBar` intent is applied here — `'native'` leaves
 * Electron's default frame and title bar in place, `'integrated'` hides the
 * bar over the reserved traffic-light space on macOS, and `'none'` drops the
 * frame — so a view window that asks for `'native'` gets the OS title bar and
 * its controls and nothing else.
 */
export const windowOptions = (
  appearance: ParsedAppearance,
  tokens: WindowTokens,
  platform: NodeJS.Platform,
  workArea: WorkArea,
  dark = true,
): Electron.BaseWindowConstructorOptions => {
  const size = appearance.size ?? PLATFORM_DEFAULT_SIZE;

  return {
    width: clamp(
      size.width,
      FIXED_MINIMUM.width,
      Math.max(workArea.width, FIXED_MINIMUM.width),
    ),
    height: clamp(
      size.height,
      FIXED_MINIMUM.height,
      Math.max(workArea.height, FIXED_MINIMUM.height),
    ),
    ...('minWidth' in size && size.minWidth !== undefined
      ? { minWidth: size.minWidth }
      : {}),
    ...('minHeight' in size && size.minHeight !== undefined
      ? { minHeight: size.minHeight }
      : {}),
    show: false,
    backgroundColor: tokens.color(appearance.background, dark),
    ...(appearance.titleBar === 'integrated' && platform === 'darwin'
      ? {
          titleBarStyle: 'hidden' as const,
          trafficLightPosition: {
            x: tokens.trafficLightInsetX,
            y: (tokens.titlebarHeight - tokens.trafficLightSize) / 2,
          },
        }
      : {}),
    ...(appearance.titleBar === 'none' ? { frame: false } : {}),
  };
};

/**
 * The constructor options of an app window with this appearance and its
 * preload. A glass window ({@link materialFor}) is transparent over the
 * frosted backdrop: on macOS the `sidebar` vibrancy, which follows the
 * window's active state; on Windows the acrylic backdrop.
 */
export const nativeOptions = (
  appearance: ParsedAppearance,
  tokens: WindowTokens,
  platform: NodeJS.Platform,
  workArea: WorkArea,
  preload: string,
  dark = true,
  release: string = osRelease(),
  glass = true,
): Electron.BrowserWindowConstructorOptions => ({
  ...windowOptions(appearance, tokens, platform, workArea, dark),
  ...(materialFor('path', platform, release, glass) === 'glass'
    ? glassOptions(platform)
    : {}),
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    preload,
    sandbox: true,
  },
});

/** Whether the window buttons are kept visible after construction. */
export const keepsWindowButtons = (
  appearance: ParsedAppearance,
  platform: NodeJS.Platform,
): boolean => appearance.titleBar === 'integrated' && platform === 'darwin';

/**
 * The chrome a window's shell applies. Fullscreen hides the native controls,
 * so their reserved space returns to the content.
 */
export const chromeFor = (
  titleBar: ParsedAppearance['titleBar'],
  tokens: WindowTokens,
  fullscreen = false,
  material: WindowMaterial = 'none',
): WindowChrome => ({
  titleBar,
  height: tokens.titlebarHeight,
  safeArea:
    titleBar === 'none' || fullscreen
      ? { top: 0, left: 0, right: 0 }
      : { top: 0, left: tokens.reservedWidth, right: 0 },
  material,
});
