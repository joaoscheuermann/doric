// The theme in a real app window (S3): main sets `nativeTheme.themeSource`,
// and the workspace window's `<html>` follows `prefers-color-scheme` with its
// `.dark` class, as does a sandboxed preview frame inside it, without a
// reload.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { nativeTheme, type WebContents, type WebFrameMain } from 'electron';

import { coreDistribution } from '../../doric/tests/support/core';
import {
  type Booted,
  bootPlatform,
  type FakeHost,
  page,
  startFakeHost,
  until,
} from './support/harness';

const ENTRY = 'doric://app/bundles/frameprobe@1.0.0/client/frames/probe.js';
const FRAME_URL = `doric://app/frame/index.html?entry=${encodeURIComponent(ENTRY)}`;
const DARK = `matchMedia('(prefers-color-scheme: dark)').matches`;

let host: FakeHost;
let booted: Booted;
let userData: string;
let contents: WebContents;
let themeSource: typeof nativeTheme.themeSource;

/** The preview frame of the shell, as main sees it. */
const previewFrame = (): WebFrameMain | undefined =>
  contents.mainFrame.frames.find((frame) =>
    frame.url.startsWith('doric://app/frame/'),
  );

/** Whether the window's `<html>` carries `.dark`. */
const darkClass = () =>
  page<boolean>(
    contents,
    `document.documentElement.classList.contains('dark')`,
  );

/** Whether the preview frame's `prefers-color-scheme` is dark. */
const frameDark = async (): Promise<unknown> =>
  previewFrame()?.executeJavaScript(DARK);

/**
 * Polls `observe` until it returns `expected`; on timeout, fails naming
 * `subject` and the last value it observed.
 */
const follows = async (
  subject: string,
  observe: () => Promise<unknown>,
  expected: boolean,
  timeoutMs = 5_000,
): Promise<void> => {
  const started = Date.now();
  let last: unknown;

  for (;;) {
    last = await observe();

    if (last === expected) {
      return;
    }

    if (Date.now() - started > timeoutMs) {
      assert.fail(
        `${subject} did not follow the theme source within ${timeoutMs} ms: expected ${expected}, last observed ${String(last)}.`,
      );
    }

    await new Promise((done) => setTimeout(done, 50));
  }
};

describe('the theme in an app window', () => {
  before(async () => {
    delete process.env.DORIC_THEME;
    themeSource = nativeTheme.themeSource;
    userData = await mkdtemp(join(tmpdir(), 'doric-electron-theme-'));
    host = await startFakeHost(
      await coreDistribution({
        bundles: [
          {
            id: 'frameprobe',
            files: { 'client/frames/probe.js': 'export {};' },
          },
        ],
      }),
    );
    booted = await bootPlatform({ host, userData });
    contents = (await booted.window('workspace')).webContents;
    await page(
      contents,
      `const frame = document.createElement('iframe');
       frame.id = 'preview';
       frame.setAttribute('sandbox', 'allow-scripts');
       frame.src = ${JSON.stringify(FRAME_URL)};
       document.body.append(frame);`,
    );
    await until(
      async () =>
        (await previewFrame()?.executeJavaScript('document.readyState')) ===
          'complete' || undefined,
      'the preview frame to load',
    );
  });

  after(async () => {
    nativeTheme.themeSource = themeSource;
    await booted?.dispose().catch(() => undefined);
    await host?.close();
    await rm(userData, { recursive: true, force: true });
  });

  for (const scheme of ['dark', 'light'] as const) {
    test(`a ${scheme} theme source makes the window and its preview frame ${scheme} without a reload`, async () => {
      const dark = scheme === 'dark';

      nativeTheme.themeSource = scheme;

      await follows("The window's `.dark` class", darkClass, dark);
      await follows(
        "The preview frame's prefers-color-scheme: dark media query",
        frameDark,
        dark,
      );
    });
  }
});
