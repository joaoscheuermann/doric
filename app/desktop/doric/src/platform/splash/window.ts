// The splash and recovery window (P3): today's frameless 420x260 window on
// the dark window background, now with the same preload as every window so
// the page reaches `doric.splash/v1`. It is a technical window: no key, never
// seen by bundles.

import { BrowserWindow } from 'electron';

import { doricUrl } from '../protocol/scheme';

export const splashWindowOptions = (input: {
  readonly backgroundColor: string;
  readonly preload: string;
}): Electron.BrowserWindowConstructorOptions => ({
  width: 420,
  height: 260,
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

export interface SplashWindow {
  readonly window: BrowserWindow;
  readonly contentsId: number;
  close(): void;
}

/** Opens the splash at `doric://app/platform/splash@<v>/index.html`. */
export const openSplashWindow = (input: {
  readonly backgroundColor: string;
  readonly preload: string;
  readonly path: string;
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
  void window.loadURL(doricUrl(input.path)).catch(() => undefined);

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
