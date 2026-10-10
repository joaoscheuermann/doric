// The one-time origin migration of the saved selection (section 16.4): the
// packaged renderer kept it under `file://`; windows now load `doric://app`.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { BrowserWindow, protocol } from 'electron';

import { silentLog } from '../src/platform/log';
import { migrateSelectionOrigin } from '../src/platform/migration/selection-origin';
import { DesktopState } from '../src/platform/state';

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

describe('selection origin migration', () => {
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
      `localStorage.removeItem('doric.selection')`,
    );
    await storage(
      'doric://app/blank',
      `localStorage.removeItem('doric.selection')`,
    );
    protocol.unhandle('doric');
    await rm(root, { recursive: true, force: true });
  });

  const migrate = async (statePath: string, packaged = true) =>
    migrateSelectionOrigin({
      state: await DesktopState.open(statePath),
      packaged,
      legacyPage,
      blankPath: '/blank',
      log: silentLog,
    });

  test('copies the file:// selection to doric://app once, never over a value already there', async () => {
    const statePath = join(root, 'doric', 'state.json');

    await storage(
      pathToFileURL(legacyPage).href,
      `localStorage.setItem('doric.selection', '{"projectId":"p1","threadId":"t1"}')`,
    );

    assert.equal(await migrate(statePath), 'migrated');
    assert.equal(
      await storage(
        'doric://app/blank',
        `localStorage.getItem('doric.selection')`,
      ),
      '{"projectId":"p1","threadId":"t1"}',
    );
    assert.equal(await migrate(statePath), 'skipped');

    // A fresh profile state with a newer selection under doric://app.
    await storage(
      'doric://app/blank',
      `localStorage.setItem('doric.selection', 'newer')`,
    );
    await rm(statePath);
    await migrate(statePath);
    assert.equal(
      await storage(
        'doric://app/blank',
        `localStorage.getItem('doric.selection')`,
      ),
      'newer',
    );
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).migrations, {
      selectionOrigin: true,
    });
  });

  test('development profiles are not migrated', async () => {
    assert.equal(
      await migrate(join(root, 'doric', 'dev-state.json'), false),
      'skipped',
    );
  });
});
