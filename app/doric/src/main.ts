import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { app, BrowserWindow, ipcMain, nativeTheme, session } from 'electron';

import { bindConnectionStatus } from './connection/ipc';
import { createConnectionManager } from './connection/manager';
import {
  type ConnectionMonitor,
  createConnectionService,
} from './connection/status';
import { remainingSplashMs, splashUrl } from './startup/splash';
import { workspaceReady } from './workspace/api';
import {
  createThreadEventService,
  type ThreadEventService,
} from './workspace/events';
import { registerWorkspaceHandlers } from './workspace/ipc';
import {
  createProjectEventService,
  type ProjectEventService,
} from './workspace/project-events';
import { senderIsAllowed } from './workspace/validation';

const rendererPort = 4200;
const developmentRendererUrl = `http://localhost:${rendererPort}/`;
const connectionPollMs = 1_000;
let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
/**
 * Set while a closing settings window is waiting on its renderer, and called
 * with the answer. It exists so the close handshake lives in one place: the
 * close listener arms it, and the renderer's flush acknowledgement fires it.
 */
const flushBeforeClose: { current: (() => void) | undefined } = {
  current: undefined,
};
let connection: ConnectionMonitor | null = null;
let threadEvents: ThreadEventService | null = null;
let projectEvents: ProjectEventService | null = null;

const rendererUrl = (): string =>
  app.isPackaged
    ? pathToFileURL(
        join(__dirname, '..', 'doric-renderer', 'index.html'),
      ).toString()
    : developmentRendererUrl;

/** The settings window loads its own page by the same packaged/dev mechanism. */
const settingsRendererUrl = (): string =>
  app.isPackaged
    ? pathToFileURL(
        join(__dirname, '..', 'doric-renderer', 'settings.html'),
      ).toString()
    : `${developmentRendererUrl}settings.html`;

/** The only two URLs any renderer may load or send IPC from. */
const rendererUrls = (): readonly string[] => [
  rendererUrl(),
  settingsRendererUrl(),
];

const contentSecurityPolicy = (): string =>
  app.isPackaged
    ? "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    : "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://localhost:4200; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const installContentSecurityPolicy = (): void => {
  // A response header can safely vary for webpack development and packaged files.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (
      details.url.startsWith(developmentRendererUrl) ||
      rendererUrls().includes(details.url)
    ) {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [contentSecurityPolicy()],
        },
      });
      return;
    }
    callback({ responseHeaders: details.responseHeaders });
  });
};

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * Keeps native traffic lights visible and centered in the renderer's chrome bar.
 *
 * The numbers belong to that bar's height, which is stated once in the
 * renderer's stylesheet as `.chrome-bar` (2.25rem, so 36px): a macOS light is
 * 12px tall, so its inset is `(36 - 12) / 2`. Raising the bar means raising this
 * with it, which is the one place the two are not derived from each other.
 */
const titleBarOptions = (): Electron.BrowserWindowConstructorOptions =>
  process.platform === 'darwin'
    ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 12 } }
    : {};

const createSplashWindow = () => {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 260,
    frame: false,
    roundedCorners: false,
    resizable: false,
    backgroundColor: '#1c1b19',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void splashWindow.loadURL(splashUrl);
};

/** Waits for the backend, then holds the splash for its minimum visible time. */
const connectWorkspace = async () => {
  const startedAt = Date.now();
  for (;;) {
    try {
      await workspaceReady();
      break;
    } catch {
      await delay(connectionPollMs);
    }
  }
  const remaining = remainingSplashMs(Date.now() - startedAt);
  if (remaining > 0) await delay(remaining);
};

const createWindow = () => {
  const allowedUrl = rendererUrl();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#1c1b19',
    ...titleBarOptions(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, 'preload.js'),
      sandbox: true,
    },
  });
  if (process.platform === 'darwin') {
    mainWindow.setWindowButtonVisibility(true);
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    splashWindow?.destroy();
    splashWindow = null;
  });
  mainWindow.once('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== allowedUrl) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (connection !== null) {
    bindConnectionStatus(mainWindow.webContents, connection);
  }

  void mainWindow.loadURL(allowedUrl);
};

/**
 * How long a closing settings window is given to answer that its pending change
 * is saved. A renderer that does not answer in time never traps the window.
 */
const settingsCloseFlushMs = 1_500;

/**
 * Opens the settings window, or focuses the one already open so a second click
 * never duplicates it. It is an ordinary, non-modal window that runs beside the
 * workspace window and shares the same sandboxed preload boundary.
 *
 * The window has no Save button, so closing it is what settles a change still
 * waiting on the renderer's debounce. `close` is held back long enough for the
 * renderer to flush and answer, because a renderer torn down first would lose
 * the change; the wait is bounded so a wedged renderer cannot trap the window.
 */
const createSettingsWindow = () => {
  if (settingsWindow !== null) {
    settingsWindow.focus();
    return;
  }
  const allowedUrl = settingsRendererUrl();
  const window = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: '#1c1b19',
    ...titleBarOptions(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, 'preload.js'),
      sandbox: true,
    },
  });
  settingsWindow = window;
  if (process.platform === 'darwin') {
    window.setWindowButtonVisibility(true);
  }

  let flushed = false;
  window.on('close', (event) => {
    if (flushed || window.webContents.isDestroyed()) return;
    event.preventDefault();
    const settled = (): void => {
      flushed = true;
      if (!window.isDestroyed()) window.close();
    };
    const timer = setTimeout(settled, settingsCloseFlushMs);
    flushBeforeClose.current = () => {
      clearTimeout(timer);
      settled();
    };
    window.webContents.send('doric:settings:flush');
  });
  window.once('ready-to-show', () => {
    window.show();
  });
  window.once('closed', () => {
    settingsWindow = null;
    flushBeforeClose.current = undefined;
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== allowedUrl) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  void window.loadURL(allowedUrl);
};

/**
 * The workspace window's one way to ask the main process for the settings
 * window. Like every other handler, it answers only a renderer at one of the
 * two expected URLs.
 */
const registerSettingsHandler = (allowedUrls: readonly string[]): void => {
  ipcMain.handle('doric:settings:open', (event) => {
    if (!senderIsAllowed(event.senderFrame?.url, allowedUrls)) {
      throw new Error('The request source is not allowed.');
    }
    createSettingsWindow();
  });
};

/**
 * The settings window's answer that its pending change has been saved, which is
 * what lets the held-back close proceed. It is the other half of the handshake
 * in `createSettingsWindow`, and a window that never answers is released by the
 * same timeout that arms it.
 */
const registerSettingsFlushHandler = (allowedUrls: readonly string[]): void => {
  ipcMain.handle('doric:settings:flushed', (event) => {
    if (!senderIsAllowed(event.senderFrame?.url, allowedUrls)) {
      throw new Error('The request source is not allowed.');
    }
    flushBeforeClose.current?.();
  });
};

void app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  const manager = createConnectionManager();
  connection = createConnectionService(manager);
  threadEvents = createThreadEventService(manager);
  projectEvents = createProjectEventService(manager);
  app.once('will-quit', () => {
    threadEvents?.close();
    threadEvents = null;
    projectEvents?.close();
    projectEvents = null;
    connection?.close();
    connection = null;
  });
  const allowedUrls = rendererUrls();
  installContentSecurityPolicy();
  registerSettingsHandler(allowedUrls);
  registerSettingsFlushHandler(allowedUrls);
  registerWorkspaceHandlers(allowedUrls, threadEvents, projectEvents);
  createSplashWindow();
  void connectWorkspace().then(createWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
