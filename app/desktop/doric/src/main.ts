// The composition root of the desktop (section 10.2): the technical
// platform and the host's Connect connection. Since the stage-9 cut-over the
// only IPC is the platform's `doric:desktop` dispatcher beside `doric:connect`;
// product rules (which windows open, their sizes, the menu) live in the core's
// desktopMain part and the UI in client bundles.

import './platform/protocol/privileges';

import { app, BrowserWindow, Notification, nativeTheme } from 'electron';

import { DesktopPlatform } from './platform/app';
import { connectHost, HOST_URL } from './platform/host/connect';
import { createPlatformLog } from './platform/log';
import type { NotificationApi } from './platform/native/notifications';

/** Electron's notifications behind the platform's one notification function. */
const electronNotifications: NotificationApi = {
  isSupported: () => Notification.isSupported(),
  create: (options) => new Notification(options),
};

void app.whenReady().then(async () => {
  // The theme is set in `platform.prepare()`, from the saved preference.
  const log = createPlatformLog();
  // The host origin the app reaches Doric on: `DORIC_HOST_URL` for a host
  // that is not on the app's own loopback, the loopback default otherwise.
  // Every host call and the status watch follow it.
  const host = connectHost({ url: process.env.DORIC_HOST_URL ?? HOST_URL });
  const platform = new DesktopPlatform({
    mainDir: __dirname,
    userData: app.getPath('userData'),
    host,
    packaged: app.isPackaged,
    argv: process.argv,
    notifications: electronNotifications,
    ...(process.env.DORIC_RENDERER_DEV_URL === undefined
      ? {}
      : { devServerOrigin: process.env.DORIC_RENDERER_DEV_URL }),
    log,
  });
  nativeTheme.on('updated', () => {
    const color = platform.tokens.color(
      'window',
      nativeTheme.shouldUseDarkColors,
    );
    for (const window of BrowserWindow.getAllWindows())
      window.setBackgroundColor(color);
  });
  await platform.prepare();

  // `platform.stop()` closes the host connection and every generation.
  app.once('will-quit', () => void platform.stop());

  app.on('activate', () => {
    if (
      BrowserWindow.getAllWindows().every(
        (window) =>
          platform.registry.byWebContents(window.webContents.id) === undefined,
      )
    ) {
      void platform.activate();
    }
  });
  app.on('before-quit', (event) => platform.lifecycle.beforeQuit(event));

  await platform.start();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
