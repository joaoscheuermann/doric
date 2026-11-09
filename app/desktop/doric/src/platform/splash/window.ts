// The splash and recovery window (P3): a frameless 610x487 window (§4.5,
// `302:22437`) on the window background, with the same preload as every
// window so the page reaches `doric.splash/v1`. It is a technical window: no
// key, never seen by bundles.

import { BrowserWindow } from 'electron';

import { doricUrl } from '../protocol/scheme';

export const splashWindowOptions = (input: {
  readonly backgroundColor: string;
  readonly preload: string;
}): Electron.BrowserWindowConstructorOptions => ({
  width: 610,
  height: 487,
  frame: false,
  roundedCorners: false,
  resizable: false,
  backgroundColor: input.backgroundColor,
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    preload: input.preload,
  },
});

/**
 * The development override of the splash art (S32): `'shaded'` only in an
 * unpackaged build whose environment sets `DORIC_SPLASH_ART=shaded`.
 */
export const splashArtOverride = (input: {
  readonly packaged: boolean;
  readonly env: NodeJS.ProcessEnv;
}): 'shaded' | undefined =>
  !input.packaged && input.env.DORIC_SPLASH_ART === 'shaded'
    ? 'shaded'
    : undefined;

export interface SplashWindow {
  readonly window: BrowserWindow;
  readonly contentsId: number;
  close(): void;
}

/**
 * Opens the splash at `doric://app/platform/splash@<v>/index.html`, with
 * `?art=shaded` when `art` asks for the shaded image (the protocol handler
 * routes on the pathname only).
 */
export const openSplashWindow = (input: {
  readonly backgroundColor: string;
  readonly preload: string;
  readonly path: string;
  readonly art?: 'shaded';
  readonly closed: () => void;
}): SplashWindow => {
  const window = new BrowserWindow(splashWindowOptions(input));
  const contentsId = window.webContents.id;

  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault();
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.once('closed', input.closed);
  void window
    .loadURL(
      doricUrl(
        input.art === 'shaded' ? `${input.path}?art=shaded` : input.path,
      ),
    )
    .catch(() => undefined);

  return {
    window,
    contentsId,
    close: () => {
      if (!window.isDestroyed()) {
        window.destroy();
      }
    },
  };
};
