// A second Electron app over the same user data directory: it registers the
// `doric` scheme exactly as the desktop does, serves one empty page and
// writes or reads `localStorage` under `doric://app` (argv: write|read).

const { app, BrowserWindow, protocol } = require('electron');

const [mode, userData, value] = process.argv.slice(-3);

app.setPath('userData', userData);
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'doric',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      codeCache: true,
    },
  },
]);

app.whenReady().then(async () => {
  protocol.handle(
    'doric',
    () =>
      new Response('<!doctype html><title>Doric</title>', {
        headers: { 'content-type': 'text/html' },
      }),
  );

  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  });

  await window.loadURL('doric://app/');

  const script =
    mode === 'write'
      ? `localStorage.setItem('doric.selection', ${JSON.stringify(value)}); 'written'`
      : `localStorage.getItem('doric.selection')`;
  const result = await window.webContents.executeJavaScript(script);

  // Let Chromium persist the storage before quitting.
  await window.webContents.session.flushStorageData();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  app.exit(0);
});
