// The shell's view of the app in a real window (T-2.10): the window's
// description carries the version main reads with `app.getVersion()`.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { app, type WebContents } from 'electron';

import { coreDistribution } from '../../doric/tests/support/core';
import {
  type Booted,
  bootPlatform,
  type FakeHost,
  page,
  startFakeHost,
} from './support/harness';

let host: FakeHost;
let booted: Booted;
let contents: WebContents;

describe('the shell in an app window', () => {
  before(async () => {
    host = await startFakeHost(await coreDistribution());
    booted = await bootPlatform({ host });
    contents = (await booted.window('workspace')).webContents;
  });

  after(async () => {
    await booted?.dispose().catch(() => undefined);
    await host?.close();
  });

  test("the window's description carries the app's version", async () => {
    assert.equal(
      await page<unknown>(
        contents,
        `window.doric.desktop.describeWindow().then((d) => d.app.version)`,
      ),
      app.getVersion(),
    );
  });
});
