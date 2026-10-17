// The desktop platform with the default composition (the real core, its
// built desktopMain part in a utility process) against a fake host: what
// Electron does today must still hold, now through `doric://app` only.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { BrowserWindow, Menu, type MenuItem, webContents } from 'electron';

import { coreDistribution } from '../../doric/tests/support/core';
import {
  type Booted,
  bootPlatform,
  type FakeHost,
  page,
  startFakeHost,
  until,
} from './support/harness';

let host: FakeHost;
let booted: Booted;
let workspace: BrowserWindow;

const urlOf = (window: BrowserWindow) => new URL(window.webContents.getURL());

interface MenuShape {
  readonly label: string;
  readonly role?: string;
  readonly accelerator?: string;
  readonly type: string;
  readonly submenu?: readonly MenuShape[];
}

const shape = (items: readonly MenuItem[]): MenuShape[] =>
  items.map((item) => ({
    label: item.label,
    ...(item.role === undefined || item.role === null
      ? {}
      : { role: String(item.role) }),
    ...(item.accelerator === undefined || item.accelerator === null
      ? {}
      : { accelerator: String(item.accelerator) }),
    type: item.type,
    ...(item.submenu === undefined || item.submenu === null
      ? {}
      : { submenu: shape(item.submenu.items) }),
  }));

describe('desktop platform, default composition', () => {
  before(async () => {
    host = await startFakeHost(await coreDistribution());
    booted = await bootPlatform({ host, flushDeadlineMs: 300 });
    workspace = await booted.window('workspace');
  });

  after(async () => {
    await booted.dispose();
    await host.close();
  });

  test('every window opens only through doric://app, the splash included', () => {
    const urls = webContents
      .getAllWebContents()
      .map((contents) => contents.getURL())
      .filter((url) => url !== '');

    assert.ok(urls.length >= 1);

    for (const url of urls) {
      const parsed = new URL(url);

      assert.equal(parsed.protocol, 'doric:', url);
      assert.equal(parsed.host, 'app', url);
    }

    assert.equal(urlOf(workspace).pathname, '/');
    assert.equal(workspace.getTitle(), 'Doric');
  });

  test('startup completes the core storage migration through the generation process', () => {
    assert.equal(booted.platform.state.data.migrations.selectionOrigin, true);
  });

  test('the workspace window has today’s isolation and the splash closed at its first ready()', async () => {
    // Sandboxed, isolated, no Node: the page sees neither require nor process.
    assert.equal(
      await page(
        workspace.webContents,
        `typeof require + typeof process + typeof module`,
      ),
      'undefinedundefinedundefined',
    );
    assert.equal(
      await page(workspace.webContents, `typeof window.doric.desktop.call`),
      'function',
    );
    await until(
      () => booted.platform.splashWindow === undefined || undefined,
      'the splash to close',
    );
    assert.deepEqual(workspace.getMinimumSize(), [960, 640]);
  });

  test('the shell carries the generation and the import map; the renderer never fetches the network', async () => {
    const contents = workspace.webContents;

    assert.equal(
      await page(
        contents,
        `document.querySelector('meta[name="doric-generation"]')?.getAttribute('content')`,
      ),
      String(booted.platform.newestGeneration),
    );
    assert.equal(
      await page(
        contents,
        `document.querySelectorAll('script[type="importmap"]').length`,
      ),
      1,
    );
    assert.equal(
      await page(
        contents,
        `fetch('http://127.0.0.1:1/').then(() => 'fetched', () => 'refused')`,
      ),
      'refused',
    );
  });

  test('a renderer cannot navigate the window to a file:// page nor open a window', async () => {
    const contents = workspace.webContents;
    const before = contents.getURL();

    await page(contents, `location.href = 'file:///etc/hosts'; 'sent'`);
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(contents.getURL(), before);
    assert.equal(
      await page(contents, `String(window.open('doric://app/x'))`),
      'null',
    );
    assert.equal(
      BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
        .length,
      1,
    );
  });

  test('reloading a window keeps its path and serves the shell again', async () => {
    const contents = workspace.webContents;

    await booted.platform.windows.open({
      key: 'workspace',
      path: '/projects/p1/threads/t1',
    });
    await until(
      async () =>
        (await page<string>(contents, 'document.body?.dataset.ready')) ===
          'yes' || undefined,
      'the navigated shell',
    );
    contents.reload();
    await new Promise((done) =>
      contents.once('did-finish-load', () => done(undefined)),
    );

    assert.equal(urlOf(workspace).pathname, '/projects/p1/threads/t1');
    assert.equal(
      await page(
        contents,
        `document.querySelectorAll('meta[name="doric-generation"]').length`,
      ),
      1,
    );
    assert.equal(
      booted.platform.windows.lastPath('workspace'),
      '/projects/p1/threads/t1',
    );
  });

  test('settings opens once at /settings with today’s size; a second open focuses it', async () => {
    await booted.platform.runCommand('core.open-settings/v1');

    const settings = await booted.window('settings');

    await booted.platform.runCommand('core.open-settings/v1');

    assert.equal(urlOf(settings).pathname, '/settings');
    assert.equal(settings.getTitle(), 'Doric Settings');
    assert.deepEqual(settings.getMinimumSize(), [720, 520]);
    assert.equal(
      booted.platform.registry.all().filter((entry) => entry.key === 'settings')
        .length,
      1,
    );
  });

  test('one primary window at a time: a second primary is refused, a plain window opens', async () => {
    await assert.rejects(
      booted.platform.windows.open({
        key: 'probe:primary',
        path: '/',
        primary: true,
      }),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: unknown }).code === 'registration_conflict',
    );
    assert.equal(booted.platform.registry.byKey('probe:primary'), undefined);

    await booted.platform.windows.open({ key: 'probe:plain', path: '/' });

    const plain = booted.platform.registry.byKey('probe:plain');

    assert.equal(plain?.primary, false);
    assert.equal(booted.platform.registry.byKey('workspace')?.primary, true);
    plain?.window.destroy();
  });

  test('a primary request for an open window without the flag is refused; the window stays plain', async () => {
    await booted.platform.windows.open({ key: 'probe:open', path: '/' });

    const open = booted.platform.registry.byKey('probe:open');

    await assert.rejects(
      booted.platform.windows.open({
        key: 'probe:open',
        path: '/',
        primary: true,
      }),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: unknown }).code === 'registration_conflict' &&
        (error as { details?: { windowKey?: unknown } }).details?.windowKey ===
          'probe:open',
    );
    assert.equal(booted.platform.registry.byKey('probe:open')?.primary, false);
    assert.equal(booted.platform.registry.byKey('workspace')?.primary, true);
    open?.window.destroy();
  });

  test('a close waits for the flush, and a renderer that never flushes closes at the deadline', async () => {
    const settings = booted.platform.registry.byKey('settings')
      ?.window as BrowserWindow;
    const contents = settings.webContents;

    // The page answers the veto but hangs its flush forever.
    await page(
      contents,
      `window.doric.desktop.onCloseRequested((request) =>
        request.phase === 'flush' ? new Promise(() => {}) : Promise.resolve(undefined),
      ); 'armed'`,
    );

    const started = Date.now();

    settings.close();
    assert.equal(settings.isDestroyed(), false);
    await until(
      () => settings.isDestroyed() || undefined,
      'the settings window to close',
      5_000,
    );
    assert.ok(Date.now() - started >= 250);
  });

  test('the menu the core sets is Electron’s default menu, item for item', () => {
    const initial = (globalThis as { electronDefaultMenu?: Menu | null })
      .electronDefaultMenu;
    const current = Menu.getApplicationMenu();

    assert.ok(
      initial !== undefined && initial !== null,
      'Electron set a default menu',
    );
    assert.notEqual(current, initial, 'the core set its own menu');
    assert.deepEqual(shape(current?.items ?? []), shape(initial.items));
  });

  test('activate with no window reopens the workspace at its last path', async () => {
    workspace.destroy();
    await until(
      () =>
        booted.platform.registry.byKey('workspace') === undefined || undefined,
      'the workspace to close',
    );
    await booted.platform.activate();

    const reopened = await booted.window('workspace');

    assert.equal(urlOf(reopened).pathname, '/projects/p1/threads/t1');
    workspace = reopened;
  });
});
