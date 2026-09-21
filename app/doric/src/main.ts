import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { app, BrowserWindow, nativeTheme, session } from 'electron';

import { remainingSplashMs, splashUrl } from './startup/splash';
import { workspaceReady } from './workspace/api';
import { registerWorkspaceHandlers } from './workspace/ipc';

const rendererPort = 4200;
const developmentRendererUrl = `http://localhost:${rendererPort}/`;
const connectionPollMs = 1_000;
let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;

const rendererUrl = (): string =>
  app.isPackaged
    ? pathToFileURL(
        join(__dirname, '..', 'doric-renderer', 'index.html'),
      ).toString()
    : developmentRendererUrl;

const contentSecurityPolicy = (): string =>
  app.isPackaged
    ? "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    : "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://localhost:4200; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const installContentSecurityPolicy = (): void => {
  // A response header can safely vary for webpack development and packaged files.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (
      details.url.startsWith(developmentRendererUrl) ||
      details.url === rendererUrl()
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

/** Keeps native traffic lights visible and centered in the 32px renderer bar. */
const titleBarOptions = (): Electron.BrowserWindowConstructorOptions =>
  process.platform === 'darwin'
    ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 9 } }
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
    width: 960,
    height: 640,
    minWidth: 640,
    minHeight: 480,
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

  if (app.isPackaged) {
    void mainWindow.loadURL(allowedUrl);
    return;
  }

  void mainWindow.loadURL(allowedUrl);
};

void app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  const allowedUrl = rendererUrl();
  installContentSecurityPolicy();
  registerWorkspaceHandlers(allowedUrl);
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
