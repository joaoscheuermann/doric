// The Electron test runner (section 22): a main process that registers the
// `doric` scheme before ready, then runs the `*.test.js` files beside it with
// node:test in this process, and exits with the number of failures.

import '../../doric/src/platform/protocol/privileges';

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

import { app, Menu } from 'electron';

const only = process.env.DORIC_ELECTRON_TESTS?.split(',').filter(Boolean);
const files = readdirSync(__dirname)
  .filter((name) => name.endsWith('.test.js'))
  .filter(
    (name) => only === undefined || only.some((part) => name.includes(part)),
  )
  .sort()
  .map((name) => join(__dirname, name));

// A profile of this run only: no storage leaks between runs or into the
// developer's Electron profile.
const profile = mkdtempSync(join(tmpdir(), 'doric-electron-tests-'));

app.setPath('userData', profile);

// Windows are never shown; quitting is the runner's decision.
app.on('window-all-closed', () => undefined);

void app.whenReady().then(() => {
  // Electron's default application menu, before any test replaces it.
  (globalThis as { electronDefaultMenu?: unknown }).electronDefaultMenu =
    Menu.getApplicationMenu();

  let failures = 0;
  // In this process: the files need Electron's main-process modules.
  const stream = run({
    files,
    concurrency: false,
    isolation: 'none',
  } as Parameters<typeof run>[0]);

  // A failing test also fails its suite; a failing hook fails only the suite.
  stream.on('test:fail', () => {
    failures += 1;
  });
  // In-process runs end at the process's `beforeExit`, which Electron never
  // reaches: once every top-level test completed and none was queued for a
  // moment, the runner raises it, so the root test reports and the summary
  // follows.
  let queued = 0;
  let completed = 0;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const settle = () => {
    clearTimeout(quiet);
    quiet = setTimeout(() => {
      if (queued > 0 && completed >= queued) {
        process.emit('beforeExit', 0);
      }
    }, 500);
  };

  stream.on('test:enqueue', (event: { nesting: number }) => {
    if (event.nesting === 0) {
      queued += 1;
      settle();
    }
  });
  stream.on('test:complete', (event: { nesting: number }) => {
    if (event.nesting === 0) {
      completed += 1;
      settle();
    }
  });
  stream.on('test:summary', (event: { file?: string }) => {
    if (event.file === undefined) {
      setTimeout(() => {
        rmSync(profile, { recursive: true, force: true });
        app.exit(failures > 0 ? 1 : 0);
      }, 200);
    }
  });
  stream
    .compose(new (spec as unknown as new () => NodeJS.ReadWriteStream)())
    .pipe(process.stdout);
});
