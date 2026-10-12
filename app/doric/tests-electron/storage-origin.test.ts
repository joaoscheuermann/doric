// The one-time copy of a window's storage from the packaged `file://` origin
// to `doric://app` (section 16.4). The caller names a key and a marker; the
// pages and origins are the platform's. The examples here are arbitrary: the
// selection pair is covered by the core's own tests.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { BrowserWindow, protocol } from 'electron';

import { type PlatformLog, silentLog } from '../src/platform/log';
import { migrateStorageOrigin } from '../src/platform/migration/storage-origin';
import { DesktopState } from '../src/platform/state';

const KEY = 'example.note';
const MARKER = 'exampleMigration';

const storage = async (url: string, script: string): Promise<unknown> => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  });

  try {
    await window.loadURL(url);

    return await window.webContents.executeJavaScript(script);
  } finally {
    window.destroy();
  }
};

const read = (script: string) => storage('doric://app/blank', script);

const recordingLog = () => {
  const warnings: string[] = [];
  const log: PlatformLog = {
    ...silentLog,
    warn: (_fields, message) => {
      warnings.push(message);
    },
  };

  return { log, warnings };
};

describe('storage origin migration', () => {
  let root: string;
  let legacyPage: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'doric-origin-'));
    legacyPage = join(root, 'legacy-origin.html');
    await writeFile(legacyPage, '<!doctype html><title>Doric</title>');
    await mkdir(join(root, 'doric'), { recursive: true });
    protocol.handle(
      'doric',
      () =>
        new Response('<!doctype html><title>Doric</title>', {
          headers: { 'content-type': 'text/html' },
        }),
    );
  });

  after(async () => {
    await storage(
      pathToFileURL(legacyPage).href,
      `localStorage.removeItem('${KEY}')`,
    );
    await read(`localStorage.removeItem('${KEY}')`);
    protocol.unhandle('doric');
    await rm(root, { recursive: true, force: true });
  });

  const migrate = async (
    statePath: string,
    options: { packaged?: boolean; page?: string; log?: PlatformLog } = {},
  ) =>
    migrateStorageOrigin(
      {
        state: await DesktopState.open(statePath),
        packaged: options.packaged ?? true,
        legacyPage: options.page ?? legacyPage,
        blankPath: '/blank',
        log: options.log ?? recordingLog().log,
      },
      { key: KEY, marker: MARKER },
    );

  test('copies the file:// value to doric://app once, never over a value already there', async () => {
    const statePath = join(root, 'doric', 'state.json');

    await storage(
      pathToFileURL(legacyPage).href,
      `localStorage.setItem('${KEY}', 'first')`,
    );

    assert.equal(await migrate(statePath), 'migrated');
    assert.equal(await read(`localStorage.getItem('${KEY}')`), 'first');
    assert.equal(await migrate(statePath), 'skipped');

    // A fresh state with a newer value already under doric://app.
    await read(`localStorage.setItem('${KEY}', 'newer')`);
    await rm(statePath);
    assert.equal(await migrate(statePath), 'migrated');
    assert.equal(await read(`localStorage.getItem('${KEY}')`), 'newer');
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).migrations, {
      [MARKER]: true,
    });
  });

  test('a legacy origin without the key copies nothing and still records the marker', async () => {
    const statePath = join(root, 'doric', 'empty-state.json');

    await storage(pathToFileURL(legacyPage).href, `localStorage.clear()`);
    await read(`localStorage.removeItem('${KEY}')`);

    assert.equal(await migrate(statePath), 'none');
    assert.equal(await read(`localStorage.getItem('${KEY}')`), null);
    assert.equal(await migrate(statePath), 'skipped');
  });

  test('development profiles are not migrated, and the marker is still recorded', async () => {
    const statePath = join(root, 'doric', 'dev-state.json');

    assert.equal(await migrate(statePath, { packaged: false }), 'skipped');
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).migrations, {
      [MARKER]: true,
    });
  });

  test('a failed copy is logged, records its marker so it never retries, and leaves no hidden window open', async () => {
    const statePath = join(root, 'doric', 'failed-state.json');
    const { log, warnings } = recordingLog();
    const windowsBefore = BrowserWindow.getAllWindows().length;

    assert.equal(
      await migrate(statePath, {
        page: join(root, 'missing-legacy-origin.html'),
        log,
      }),
      'failed',
    );
    assert.deepEqual(warnings, ['Storage origin migration failed']);
    assert.equal(
      await migrate(statePath, {
        page: join(root, 'missing-legacy-origin.html'),
        log,
      }),
      'skipped',
    );
    assert.equal(BrowserWindow.getAllWindows().length, windowsBefore);
  });
});
