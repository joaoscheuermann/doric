// Starts the desktop app for `nx serve doric-app` (the `serve` target).
//
// Chromium refuses to run as root unless its sandbox is turned off — Electron
// aborts in `electron_main_delegate.cc` with "Running as root without
// --no-sandbox is not supported" before any app code runs, so the decision
// cannot be made from `main.ts`. A root container also cannot use Chromium's
// setuid helper, which is why the sandbox image assumes `--no-sandbox` there.
//
// Only that case opts out, and the flag lands on the electron launch through
// `nx-electron:execute`'s `args` option, so a normal non-root user keeps the
// sandbox. The decision is the effective uid — `getuid() === 0` on a Unix
// root — or an explicit opt-in through `DORIC_ELECTRON_NO_SANDBOX=1`, which
// lets a caller request the flag without being root. The `serve-electron`
// target below is the unchanged `nx-electron:execute` launch that does the
// build and spawns Electron.
//
// Usage: node app/desktop/doric/serve.mjs

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const nxCli = resolve(root, 'node_modules', 'nx', 'bin', 'nx.js');

const runningAsRoot =
  typeof process.getuid === 'function' && process.getuid() === 0;
const optedIn = process.env.DORIC_ELECTRON_NO_SANDBOX === '1';

const args = ['run', 'doric-app:serve-electron'];
if (runningAsRoot || optedIn) {
  args.push('--args=--no-sandbox');
}

const child = spawn(process.execPath, [nxCli, ...args], {
  stdio: 'inherit',
  env: process.env,
});

// Forward signals a parent (Nx, `concurrently`) sends, so Electron stops with
// the serve task instead of outliving it.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  process.exit(signal === null ? (code ?? 1) : 128);
});
