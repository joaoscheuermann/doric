// The window's IPC surface after the stage-9 cut-over: the real preload gives
// a page `window.doric.desktop` and nothing else. The semantic Project, Thread,
// configuration, terminal, connection, notification and settings namespaces
// the legacy renderer used are gone; every call is a contract call routed by
// main's one `doric:desktop` dispatcher.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import type { BrowserWindow } from 'electron';

import { coreDistribution } from '../tests/support/core';
import {
  type Booted,
  bootPlatform,
  type FakeHost,
  page,
  startFakeHost,
} from './support/harness';

let host: FakeHost;
let booted: Booted;
let workspace: BrowserWindow;

describe('window IPC surface', () => {
  before(async () => {
    host = await startFakeHost(await coreDistribution());
    booted = await bootPlatform({ host });
    workspace = await booted.window('workspace');
  });

  after(async () => {
    await booted.dispose();
    await host.close();
  });

  test('the preload exposes only the platform namespace', async () => {
    assert.deepEqual(
      await page(workspace.webContents, 'Object.keys(window.doric)'),
      ['desktop'],
    );
  });

  test('no legacy semantic namespace is reachable from the page', async () => {
    assert.deepEqual(
      await page(
        workspace.webContents,
        `['projects', 'threads', 'config', 'tools', 'providers', 'credentials',
          'resources', 'terminals', 'connection', 'notifications', 'settings']
          .filter((name) => window.doric[name] !== undefined)`,
      ),
      [],
    );
  });
});
