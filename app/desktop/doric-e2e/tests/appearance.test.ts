// The Appearance section in a real app (§4.1). T-4.1.1: choosing Light in the
// settings window repaints every open window and its native background
// without a restart. T-4.1.2: the choice is saved in `appearance.json`, so a
// second start on the same `userData` opens the splash and the workspace
// window light, with the Light tile selected. An open terminal's repaint is
// S21's `followColorScheme` test and a manual check (G11): the harness loads
// no terminal bundle.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { BrowserWindow, nativeTheme, type WebContents } from 'electron';

import { workspaceDistribution } from '../../doric/tests/support/core';
import {
  type Booted,
  bootPlatform,
  type FakeHost,
  page,
  startFakeHost,
  until,
} from './support/harness';
import {
  click,
  clickOn,
  inPage,
  waitFor,
  waitForSelector,
} from './support/shell-page';
import { serveWorkspace } from './support/workspace-host';

const NAV_ROW = '[data-slot="sidebar"] :is(a, button, [role="link"])';
const TILE = '[role="radiogroup"] [role="radio"]';

/** The tiles' names in order, and the checked one. */
const tiles = (contents: WebContents) =>
  inPage<{ names: string[]; checked: string[] }>(
    contents,
    `(() => {
      const tiles = deepAll(${JSON.stringify(TILE)}).filter(visible);
      const name = (tile) => tile.querySelector('[data-slot="theme-title"]')?.textContent ?? '';
      return {
        names: tiles.map(name),
        checked: tiles.filter((tile) => tile.getAttribute('aria-checked') === 'true').map(name),
      };
    })()`,
  );

/** Opens Settings from the account menu and its Appearance section. */
const openAppearance = async (
  booted: Booted,
  workspace: WebContents,
): Promise<WebContents> => {
  await click(workspace, 'Account');
  await clickOn(workspace, '[role="menuitem"]', 'Settings');

  const settings = (await booted.window('settings')).webContents;

  await waitForSelector(settings, NAV_ROW);
  await clickOn(settings, NAV_ROW, 'Appearance');
  await until(
    async () =>
      (await page<string>(settings, 'location.pathname')) ===
        '/settings/appearance' || undefined,
    'the Appearance section',
  );
  await until(
    async () =>
      (await tiles(settings)).checked.length === 1 ? true : undefined,
    'the stored theme to be read',
  );

  return settings;
};

const darkClass = (contents: WebContents) =>
  page<boolean>(
    contents,
    `document.documentElement.classList.contains('dark')`,
  );

/** Every open window: its page's `.dark` and its native background. */
const windows = async () =>
  Promise.all(
    BrowserWindow.getAllWindows()
      .filter((window) => !window.isDestroyed())
      .map(async (window) => ({
        url: window.webContents.getURL(),
        dark: await darkClass(window.webContents),
        background: window.getBackgroundColor().toLowerCase(),
      })),
  );

describe('the Appearance section', () => {
  let host: FakeHost;
  let userData: string;
  let themeSource: typeof nativeTheme.themeSource;
  let booted: Booted | undefined;

  before(async () => {
    // The harness runs main in this process: a `DORIC_THEME` would win over
    // the saved theme (§4.1).
    delete process.env.DORIC_THEME;
    themeSource = nativeTheme.themeSource;
    userData = await mkdtemp(join(tmpdir(), 'doric-electron-appearance-'));
    host = await startFakeHost(await workspaceDistribution());
    serveWorkspace(host);
  });

  after(async () => {
    nativeTheme.themeSource = themeSource;
    await booted?.dispose().catch(() => undefined);
    await host?.close();
    await rm(userData, { recursive: true, force: true });
  });

  test('choosing Light repaints every open window and its native background without a restart (T-4.1.1)', async () => {
    booted = await bootPlatform({ host, userData, shell: 'renderer' });
    const workspace = (await booted.window('workspace')).webContents;
    await waitFor(workspace, 'Account');

    // No saved theme: Dark, the default.
    assert.equal(nativeTheme.themeSource, 'dark');

    const settings = await openAppearance(booted, workspace);
    assert.deepEqual(await tiles(settings), {
      names: ['Dark (default)', 'Light', 'System'],
      checked: ['Dark (default)'],
    });

    await clickOn(settings, TILE, 'Light');
    await until(
      async () =>
        (await tiles(settings)).checked[0] === 'Light' ? true : undefined,
      'the Light tile to be selected',
    );

    assert.equal(nativeTheme.themeSource, 'light');
    assert.equal(nativeTheme.shouldUseDarkColors, false);
    const light = booted.platform.tokens.color('window', false).toLowerCase();
    const repainted = await until(async () => {
      const open = await windows();
      return open.length >= 2 &&
        open.every((window) => !window.dark && window.background === light)
        ? open
        : undefined;
    }, 'every window to repaint light').catch(async (error: unknown) => {
      console.log(JSON.stringify(await windows(), null, 2));
      throw error;
    });
    assert.ok(
      repainted.some((window) => window.url.includes('/settings')),
      'the settings window is among them',
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(join(userData, 'doric', 'appearance.json'), 'utf8'),
      ),
      { theme: 'light' },
    );

    await booted.dispose();
    booted = undefined;
  });

  test('the choice survives a restart: the splash and the workspace window open light (T-4.1.2)', async () => {
    // Another theme in between, so only the saved file can make it light.
    nativeTheme.themeSource = 'dark';

    booted = await bootPlatform({
      host,
      userData,
      shell: 'renderer',
      start: false,
    });
    assert.equal(nativeTheme.themeSource, 'light');

    const started = booted.platform.start();
    const splash = booted.platform.splashWindow;
    assert.ok(splash, 'start() opens the splash');
    assert.equal(
      splash.getBackgroundColor().toLowerCase(),
      booted.platform.tokens.color('window', false).toLowerCase(),
    );
    await started;

    const workspace = (await booted.window('workspace')).webContents;
    await waitFor(workspace, 'Account');
    assert.equal(await darkClass(workspace), false);

    const settings = await openAppearance(booted, workspace);
    assert.deepEqual((await tiles(settings)).checked, ['Light']);
  });
});
