// The composition root of the desktop (section 10.2): the technical
// platform plus the legacy semantic channels the current renderer still
// uses (decision 71). Product rules (which windows open, their sizes, the
// menu) live in the core's desktopMain part.

import './platform/protocol/privileges';

import { join } from 'node:path';

import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';

import { bindConnectionStatus } from './connection/ipc';
import { createConnectionManager } from './connection/manager';
import {
  type ConnectionMonitor,
  createConnectionService,
} from './connection/status';
import {
  electronNotifications,
  registerLegacyNotificationHandler,
} from './notifications';
import { DesktopPlatform } from './platform/app';
import { createPlatformLog } from './platform/log';
import { migrateSelectionOrigin } from './platform/migration/selection-origin';
import { workspaceUrl } from './workspace/config';
import {
  createThreadEventService,
  type ThreadEventService,
} from './workspace/events';
import { registerWorkspaceHandlers } from './workspace/ipc';
import {
  createProjectEventService,
  type ProjectEventService,
} from './workspace/project-events';
import {
  createTerminalEventService,
  type TerminalEventService,
} from './workspace/terminal-events';
import { registerTerminalHandlers } from './workspace/terminal-ipc';
import { terminalApi } from './workspace/terminals';
import {
  createThreadHistoryStore,
  type ThreadHistoryStore,
} from './workspace/thread-history';
import { senderIsAllowed } from './workspace/validation';

let connection: ConnectionMonitor | null = null;
let threadEvents: ThreadEventService | null = null;
let projectEvents: ProjectEventService | null = null;
let terminalEvents: TerminalEventService | null = null;
let threadHistory: ThreadHistoryStore | null = null;

/**
 * The workspace window's one way to ask for the settings window: it runs the
 * core's `core.open-settings/v1` command in desktopMain, which opens the key
 * `settings` (or focuses it when it is open). Like every other handler, it
 * answers only a shell page of `doric://app`.
 */
const registerLegacySettingsOpen = (platform: DesktopPlatform): void => {
  ipcMain.handle('doric:settings:open', async (event) => {
    if (!senderIsAllowed(event.senderFrame?.url)) {
      throw new Error('The request source is not allowed.');
    }
    await platform.openSettings();
  });
};

void app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  const log = createPlatformLog();
  const platform = new DesktopPlatform({
    mainDir: __dirname,
    userData: app.getPath('userData'),
    hostUrl: workspaceUrl,
    packaged: app.isPackaged,
    argv: process.argv,
    notifications: electronNotifications,
    ...(process.env.DORIC_RENDERER_DEV_URL === undefined
      ? {}
      : { devServerOrigin: process.env.DORIC_RENDERER_DEV_URL }),
    log,
  });
  await platform.prepare();

  const manager = createConnectionManager();
  connection = createConnectionService(manager);
  // The local Thread history snapshot lives in its own directory under
  // `userData`; the event service writes it through, and closing the service
  // flushes it before the process exits.
  threadHistory = createThreadHistoryStore(
    join(app.getPath('userData'), 'thread-history'),
  );
  // The status and Project tree namespaces share the manager above; every
  // watched Thread gets a manager of its own, so its subscription ends when
  // its watch does.
  threadEvents = createThreadEventService(
    createConnectionManager,
    threadHistory,
  );
  projectEvents = createProjectEventService(manager);
  terminalEvents = createTerminalEventService({
    manager: createConnectionManager,
    snapshot: terminalApi.snapshot,
  });
  const hostAvailable = () => platform.hostAvailable();
  registerTerminalHandlers(terminalEvents, hostAvailable);
  app.once('will-quit', () => {
    threadEvents?.close();
    threadEvents = null;
    threadHistory = null;
    projectEvents?.close();
    terminalEvents?.close();
    projectEvents = null;
    connection?.close();
    connection = null;
    void platform.stop();
  });
  registerLegacySettingsOpen(platform);
  registerLegacyNotificationHandler((error) =>
    log.error({ error }, 'Notification failed'),
  );
  registerWorkspaceHandlers(
    threadEvents,
    projectEvents,
    threadHistory,
    hostAvailable,
  );
  // Connection status reaches only the window whose key is `workspace`, as
  // it reached only the main window before (P16).
  platform.onWindowCreated((entry) => {
    if (entry.key === 'workspace' && connection !== null) {
      bindConnectionStatus(entry.window.webContents, connection);
    }
  });

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

  await platform.start(() =>
    migrateSelectionOrigin({
      state: platform.state,
      packaged: app.isPackaged,
      legacyPage: join(__dirname, 'assets', 'legacy-origin.html'),
      blankPath: platform.blankPath(),
      log,
    }),
  );
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
