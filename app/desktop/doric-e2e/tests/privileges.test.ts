// The privileges of the `doric` scheme (decision 74, risk R1) in a real
// window, with the shell's CSP: module scripts resolved through the import
// map to the built platform packages, dynamic import of a bundle part,
// classic and module workers, localStorage persisted across a relaunch, and
// `fetch` of doric://app under the development policy only.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';

import { BrowserWindow, protocol } from 'electron';

import {
  frameImportMap,
  renderFrameDocument,
} from '../../doric/src/platform/protocol/frame';
import { respond } from '../../doric/src/platform/protocol/handler';
import { platformImportMap } from '../../doric/src/platform/protocol/import-map';
import { resourcesFor } from '../../doric/src/platform/protocol/resources';
import {
  createShellRenderer,
  type ShellMode,
} from '../../doric/src/platform/protocol/shell';
import { MAIN_DIR, page, until } from './support/harness';

const run = promisify(execFile);

const SHELL = `<!doctype html>
<html lang="en" class="dark">
  <head><meta charset="utf-8" /><title>Doric</title></head>
  <body><script type="module" src="/platform/shell@1.0.0/probe.js"></script></body>
</html>
`;

const PROBE = `
import { z } from 'zod';
import { ContractError } from 'bundle/contracts';

const worker = (url, options) =>
  new Promise((done) => {
    const instance = new Worker(url, options);
    instance.onmessage = (event) => done(event.data);
    instance.onerror = () => done('refused');
  });
const results = {};
results.zod = z.string().parse('parsed');
results.contracts = new ContractError('unavailable', 'x').code;
results.part = (await import('/bundles/probe@1.0.0/client/index.js')).value;
results.classic = await worker('/platform/shell@1.0.0/classic.js');
results.module = await worker('/platform/shell@1.0.0/module.js', { type: 'module' });
localStorage.setItem('doric.probe', 'kept');
results.storage = localStorage.getItem('doric.probe');
results.fetch = await fetch('doric://app/platform/importmap.platform.json').then(
  (response) => String(response.ok),
  () => 'refused',
);
window.results = results;
`;

let root: string;
let mode: ShellMode = 'packaged';

const probe = async (shellMode: ShellMode): Promise<Record<string, string>> => {
  mode = shellMode;

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  try {
    await window.loadURL('doric://app/');

    return await until(
      () =>
        page<Record<string, string> | undefined>(
          window.webContents,
          'window.results',
        ),
      'the probe page',
    );
  } finally {
    window.destroy();
  }
};

describe('doric:// privileges', () => {
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'doric-privileges-'));

    const shellRoot = join(root, 'shell');
    const part = join(root, 'bundles', 'probe@1.0.0', 'client', 'index.js');

    const resources = { ...resourcesFor(MAIN_DIR), shellRoot };
    const importMap = platformImportMap(resources.platformRoot);
    const zodPath = new URL(importMap.imports['zod']).pathname;

    await mkdir(shellRoot, { recursive: true });
    await mkdir(join(root, 'bundles', 'probe@1.0.0', 'client'), {
      recursive: true,
    });
    await writeFile(join(shellRoot, 'shell.html'), SHELL);
    await writeFile(join(shellRoot, 'probe.js'), PROBE);
    await writeFile(join(shellRoot, 'classic.js'), `postMessage('classic');`);
    await writeFile(
      join(shellRoot, 'module.js'),
      `import { z } from '${zodPath}'; postMessage(z.literal('module').parse('module'));`,
    );
    await writeFile(part, 'export const value = "part";');

    protocol.handle('doric', (request) =>
      respond(request, {
        resources,
        bundles: {
          file: (id, version, path) =>
            `${id}@${version}/${path}` === 'probe@1.0.0/client/index.js'
              ? part
              : undefined,
        },
        artifacts: { root: join(root, 'artifacts') },
        frame: renderFrameDocument(frameImportMap(importMap)),
        shell: {
          render: () =>
            createShellRenderer({
              mode,
              template: () => readFile(join(shellRoot, 'shell.html'), 'utf8'),
              generation: () => 1,
              importMap: () => importMap,
              themeHref: '/platform/desktop@1.0.0/theme.css',
              devServerOrigin: 'http://localhost:4200',
            }).render(),
        },
      }),
    );
  });

  after(async () => {
    protocol.unhandle('doric');
    await rm(root, { recursive: true, force: true });
  });

  test('the packaged shell runs ESM through the import map, bundle parts and both kinds of worker', async () => {
    assert.deepEqual(await probe('packaged'), {
      zod: 'parsed',
      contracts: 'unavailable',
      part: 'part',
      classic: 'classic',
      module: 'module',
      storage: 'kept',
      fetch: 'refused',
    });
  });

  test('the development shell may fetch doric://app (hot updates)', async () => {
    assert.equal((await probe('development')).fetch, 'true');
  });

  test('localStorage under doric://app survives a relaunch over the same profile', async () => {
    const userData = join(root, 'profile');
    const script = resolve(
      'app/desktop/doric-e2e/tests/fixtures/storage-main.cjs',
    );
    const electron = process.execPath;
    const launch = async (mode: 'write' | 'read') =>
      JSON.parse(
        (
          await run(electron, [script, mode, userData, 'project-1/thread-2'], {
            env: { ...process.env, ELECTRON_ENABLE_LOGGING: '' },
          })
        ).stdout
          .trim()
          .split('\n')
          .at(-1) as string,
      ) as unknown;

    assert.equal(await launch('write'), 'written');
    assert.equal(await launch('read'), 'project-1/thread-2');
  });
});
