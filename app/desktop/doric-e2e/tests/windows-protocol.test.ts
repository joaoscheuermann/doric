// What `doric://app` answers through Electron's own network stack, and how
// `doric.windows/v1.open` treats keys and paths in real windows, with the
// real core against a fake host.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { type BrowserWindow, net } from 'electron';

import { desktopPaths } from '../../doric/src/platform/paths';
import { WindowPaths } from '../../doric/src/platform/state';
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
let userData: string;
let coreVersion: string;

const pathOf = (window: BrowserWindow) =>
  new URL(window.webContents.getURL()).pathname;

const fetchStatus = async (
  url: string,
): Promise<{ status: number; type: string | null; body: string }> => {
  const response = await net.fetch(url);

  return {
    status: response.status,
    type: response.headers.get('content-type'),
    body: await response.text(),
  };
};

describe('doric://app through Electron, and open() semantics', () => {
  before(async () => {
    userData = await mkdtemp(join(tmpdir(), 'doric-electron-windows-'));

    const distribution = await coreDistribution();

    coreVersion =
      distribution.catalog.bundles.find((bundle) => bundle.id === 'core')
        ?.version ?? '';
    host = await startFakeHost(distribution);
    booted = await bootPlatform({ host, userData });
    await booted.window('workspace');
  });

  after(async () => {
    await booted.dispose().catch(() => undefined);
    await host.close();
    await rm(userData, { recursive: true, force: true });
  });

  test('a real platform, bundle and schema file answers 200 with its type', async () => {
    const splash = await fetchStatus(
      'doric://app/platform/splash@1.0.0/index.html',
    );

    assert.equal(splash.status, 200);
    assert.match(splash.type ?? '', /^text\/html/);

    const react = await fetchStatus(
      'doric://app/platform/react@19.2.8/index.js',
    );

    assert.equal(react.status, 200);
    assert.match(react.type ?? '', /javascript/);

    const desktop = await fetchStatus(
      `doric://app/bundles/core@${coreVersion}/desktop/index.js`,
    );

    assert.equal(desktop.status, 200);
    assert.match(desktop.type ?? '', /javascript/);

    const schema = await fetchStatus('doric://app/schemas/composition/v1.json');

    assert.equal(schema.status, 200);
    assert.match(schema.type ?? '', /json/);
  });

  test('missing or refused technical paths answer 404, never the shell', async () => {
    for (const url of [
      'doric://app/platform/react@19.2.8/missing.js',
      'doric://app/platform/nothing@1.0.0/index.js',
      `doric://app/bundles/core@${coreVersion}/missing.js`,
      'doric://app/bundles/unknown@1.0.0/desktop/index.js',
      `doric://app/bundles/core@${coreVersion}/host/index.js`,
      // An encoded slash or backslash is a traversal attempt (Chromium already
      // resolves a plain or percent-encoded `..` before the handler sees it).
      `doric://app/bundles/core@${coreVersion}/desktop%2F..%2Fhost%2Findex.js`,
      `doric://app/bundles/core@${coreVersion}/desktop%5C..%5Chost%5Cindex.js`,
      'doric://app/platform/react@19.2.8%2F..%2F..%2Fassets%2Flegacy-origin.html',
      'doric://app/schemas/missing.json',
      'doric://other/x',
    ]) {
      const answer = await fetchStatus(url);

      assert.equal(answer.status, 404, url);
      assert.doesNotMatch(answer.body, /<html/i, url);
    }
  });

  test('any other path answers the shell', async () => {
    for (const path of ['/', '/settings/providers', '/projects/p/threads/t']) {
      const answer = await fetchStatus(`doric://app${path}`);

      assert.equal(answer.status, 200, path);
      assert.match(answer.type ?? '', /^text\/html/, path);
      assert.match(answer.body, /name="doric-generation"/, path);
    }
  });

  test('the same key focuses its window and navigates it to a new path', async () => {
    const before = booted.platform.registry.all().length;

    await booted.platform.windows.open({ key: 'probe:same', path: '/a' });

    const first = await booted.window('probe:same');

    await booted.platform.windows.open({ key: 'probe:same', path: '/a' });
    assert.equal(booted.platform.registry.all().length, before + 1);
    assert.equal(booted.platform.registry.byKey('probe:same')?.window, first);

    await booted.platform.windows.open({ key: 'probe:same', path: '/b' });
    await until(
      async () =>
        (pathOf(first) === '/b' &&
          (await page<string>(
            first.webContents,
            'document.body?.dataset.ready',
          )) === 'yes') ||
        undefined,
      'the window to navigate to /b',
    );
    assert.equal(booted.platform.registry.all().length, before + 1);
    assert.equal(booted.platform.windows.lastPath('probe:same'), '/b');
  });

  test('different keys open different windows', async () => {
    await booted.platform.windows.open({ key: 'probe:other', path: '/a' });

    const other = await booted.window('probe:other');

    assert.notEqual(
      other,
      booted.platform.registry.byKey('probe:same')?.window,
    );
  });

  test('focusOrOpen of a key never opened answers not_found', async () => {
    await assert.rejects(
      booted.platform.windows.focusOrOpen('probe:never'),
      (error: { code?: string }) => error.code === 'not_found',
    );
    assert.equal(booted.platform.registry.byKey('probe:never'), undefined);
  });

  test('a closed key reopens at its last path; the last path survives a restart', async () => {
    const window = booted.platform.registry.byKey('probe:same')
      ?.window as BrowserWindow;

    window.destroy();
    await until(
      () =>
        booted.platform.registry.byKey('probe:same') === undefined || undefined,
      'the window to close',
    );
    await booted.platform.windows.focusOrOpen('probe:same');

    const reopened = await booted.window('probe:same');

    assert.equal(pathOf(reopened), '/b');

    await booted.dispose();

    const file = desktopPaths(userData).windows;
    const stored = JSON.parse(await readFile(file, 'utf8')) as {
      lastPaths: Record<string, string>;
    };

    assert.equal(stored.lastPaths['probe:same'], '/b');
    assert.equal((await WindowPaths.open(file)).get('probe:same'), '/b');
  });
});
