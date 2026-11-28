// A window's visual intent (window-appearance.md) as Electron constructor
// options, plus the chrome and safe area its shell applies.

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
 * An app window on macOS is glass: main puts the `under-window` vibrancy
 * behind its page, so the window's frame shows a frosted desktop. A view
 * window shows a page of the host that knows nothing of the material, and
 * the other platforms keep an opaque window.
 */
export const materialFor = (
  kind: 'path' | 'view' | undefined,
  platform: NodeJS.Platform,
): WindowMaterial =>
  kind === 'path' && platform === 'darwin' ? 'glass' : 'none';

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
 * preload. On macOS it is glass ({@link materialFor}): transparent, over the
 * `under-window` vibrancy, which follows the window's active state.
 */
export const nativeOptions = (
  appearance: ParsedAppearance,
  tokens: WindowTokens,
  platform: NodeJS.Platform,
  workArea: WorkArea,
  preload: string,
  dark = true,
): Electron.BrowserWindowConstructorOptions => ({
  ...windowOptions(appearance, tokens, platform, workArea, dark),
  ...(materialFor('path', platform) === 'glass'
    ? {
        backgroundColor: GLASS_BACKGROUND,
        vibrancy: 'under-window' as const,
        visualEffectState: 'followWindow' as const,
      }
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
