// The preview frame in a real app window (docs/architecture/bundles/
// papercraft/isolamento.md, phases 0–1): the shell embeds
// `<iframe sandbox="allow-scripts">` at the frame document, whose boot script
// imports a bundle's frame entry. The entry imports React from the frame's
// import map, renders, probes what an opaque origin may reach and reports to
// the shell by `postMessage`.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  BrowserWindow,
  net,
  type WebContents,
  type WebFrameMain,
} from 'electron';

import { desktopPaths } from '../../doric/src/platform/paths';
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
const ARTIFACT = 'doric://app/artifacts/probe-art@1/index.js';

/** The fixture frame entry; `client` is a client part it must not reach. */
const probe = (client: string) => `
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

const attempt = async (load) => {
  try {
    return await load();
  } catch (error) {
    return 'failed: ' + error.name;
  }
};
const report = { origin: self.origin, doric: typeof window.doric };

try {
  localStorage.getItem('probe');
  report.localStorage = 'readable';
} catch (error) {
  report.localStorage = error.name;
}

const root = document.createElement('div');

document.body.append(root);
flushSync(() =>
  createRoot(root).render(createElement('p', { id: 'probe' }, 'rendered by React')),
);
report.rendered = document.getElementById('probe')?.textContent ?? null;
report.artifact = await attempt(async () => (await import('${ARTIFACT}')).value);
report.client = await attempt(async () => {
  await import('${client}');
  return 'imported';
});
report.fetch = await attempt(async () => (await fetch('${ARTIFACT}')).status);

window.addEventListener('message', (event) => {
  if (typeof event.data?.navigate === 'string') {
    location.href = event.data.navigate;
  }
  if (event.data?.ping !== undefined) {
    parent.postMessage({ pong: event.data.ping }, '*');
  }
});
parent.postMessage({ probe: report }, '*');
`;

let host: FakeHost;
let booted: Booted;
let userData: string;
let contents: WebContents;
let clientPart: string;
const attempts: { url: string; isMainFrame: boolean }[] = [];

/** The preview frame of the shell, as main sees it. */
const previewFrame = (): WebFrameMain | undefined =>
  contents.mainFrame.frames.find((frame) =>
    frame.url.startsWith('doric://app/frame/'),
  );

/** Messages the shell received from frames. */
const received = () =>
  page<Record<string, unknown>[]>(contents, 'window.__frameMessages');

/** Whether the frame still answers from its first document. */
const answers = async (ping: string): Promise<boolean> => {
  await page(
    contents,
    `document.getElementById('preview').contentWindow.postMessage({ ping: ${JSON.stringify(ping)} }, '*')`,
  );

  return await until(
    async () =>
      (await received()).some((message) => message.pong === ping) || undefined,
    `the frame to answer ${ping}`,
    5_000,
  );
};

describe('the preview frame in an app window', () => {
  before(async () => {
    userData = await mkdtemp(join(tmpdir(), 'doric-electron-frame-'));

    const revision = join(desktopPaths(userData).artifacts, 'probe-art@1');

    await mkdir(revision, { recursive: true });
    await writeFile(
      join(revision, 'index.js'),
      `export const value = 'artifact';`,
    );

    const core = await coreDistribution();
    const coreVersion =
      core.catalog.bundles.find((bundle) => bundle.id === 'core')?.version ??
      '';

    clientPart = `doric://app/bundles/core@${coreVersion}/client/index.js`;
    host = await startFakeHost(
      await coreDistribution({
        bundles: [
          {
            id: 'frameprobe',
            files: { 'client/frames/probe.js': probe(clientPart) },
          },
        ],
      }),
    );
    booted = await bootPlatform({ host, userData });
    contents = (await booted.window('workspace')).webContents;
    contents.on('will-frame-navigate', (details) => {
      attempts.push({ url: details.url, isMainFrame: details.isMainFrame });
    });
    await page(
      contents,
      `window.__frameMessages = [];
       window.addEventListener('message', (event) => window.__frameMessages.push(event.data));
       const frame = document.createElement('iframe');
       frame.id = 'preview';
       frame.setAttribute('sandbox', 'allow-scripts');
       frame.src = ${JSON.stringify(FRAME_URL)};
       document.body.append(frame);`,
    );
  });

  after(async () => {
    await booted?.dispose().catch(() => undefined);
    await host?.close();
    await rm(userData, { recursive: true, force: true });
  });

  const report = () =>
    until(
      async () =>
        (await received()).find((message) => message.probe !== undefined)
          ?.probe as Record<string, unknown> | undefined,
      'the frame report',
    );

  test('boots the bundle frame entry, which renders with the platform React', async () => {
    assert.equal((await report()).rendered, 'rendered by React');
  });

  test('runs with an opaque origin, without the preload or persistent storage', async () => {
    const probed = await report();

    assert.equal(probed.origin, 'null');
    assert.equal(probed.doric, 'undefined');
    assert.equal(probed.localStorage, 'SecurityError');
    assert.equal(previewFrame()?.origin, 'null');
    // The shell beside it keeps its bridge.
    assert.equal(await page(contents, 'typeof window.doric'), 'object');
  });

  test("imports an artifact revision, but not a bundle's client part, and fetches nothing", async () => {
    const probed = await report();
    const part = await net.fetch(clientPart);

    assert.equal(probed.artifact, 'artifact');
    // The part exists and the shell may load it: only CORS keeps the frame out.
    assert.equal(part.status, 200);
    assert.equal(part.headers.get('access-control-allow-origin'), null);
    assert.match(String(probed.client), /^failed: /u);
    // `connect-src 'none'`.
    assert.match(String(probed.fetch), /^failed: /u);
  });

  test('a font at an app path no route serves is a 404, not the shell read as a font', async () => {
    // What a preview's sheet asked for when it kept a `url()` written for its
    // source file's place; answered with the shell, Chromium logged
    // "OTS parsing error: invalid sfntVersion" (the bytes `<!DO`). The probe
    // page is a served file, which carries no CSP, so it may fetch; a fetch
    // is no navigation, as a font is none.
    const probe = new BrowserWindow({ show: false });

    try {
      await probe.loadURL(clientPart);
      const answer = await page<{ status: number; html: boolean }>(
        probe.webContents,
        `fetch('doric://app/assets/fonts/e2e-missing.woff2').then(async (response) => ({
           status: response.status,
           html: /<!doctype/i.test(await response.text()),
         }))`,
      );

      assert.deepEqual(answer, { status: 404, html: false });
    } finally {
      probe.destroy();
    }
  });

  test('runs in a renderer process of its own', async () => {
    await report();

    const frame = previewFrame() as WebFrameMain;
    const main = contents.mainFrame;

    console.log(
      `# processes: shell pid ${main.osProcessId} (id ${main.processId}), preview frame pid ${frame.osProcessId} (id ${frame.processId})`,
    );
    assert.notEqual(frame.osProcessId, main.osProcessId);
  });

  test('main captures the window region under the preview frame (doric.windows/v1.capture)', async () => {
    await report();

    const box = await page<{
      x: number;
      y: number;
      width: number;
      height: number;
    }>(
      contents,
      `(() => { const r = document.getElementById('preview').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
    );
    const shot = await booted.platform.windows.capture({
      key: 'workspace',
      rect: box,
    });
    const png = Buffer.from(shot.png, 'base64');

    console.log(
      `# capture: ${JSON.stringify(box)} -> ${shot.width}x${shot.height} @${shot.scale}`,
    );
    assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
    assert.ok(shot.width >= Math.floor(box.width));
    assert.equal(shot.scale, shot.width / box.width);
  });

  test("leaves the shell's own about:blank frames alone (the dev server overlay)", async () => {
    const loaded = await page<string>(
      contents,
      `new Promise((done) => {
         const frame = document.createElement('iframe');
         frame.src = 'about:blank';
         frame.onload = () => {
           frame.contentDocument.body.textContent = 'overlay';
           done(frame.contentDocument.body.textContent);
         };
         document.body.append(frame);
         setTimeout(() => done('no load'), 3000);
       })`,
    );

    assert.equal(loaded, 'overlay');
  });

  test('stays at the frame document when it or the shell navigates it inside frame-src', async () => {
    await report();
    // The shell's `frame-src doric://app/frame/` allows this URL; the guard
    // refuses it, and the frame keeps its document.
    await page(
      contents,
      `document.getElementById('preview').contentWindow.postMessage({ navigate: 'doric://app/frame/boot.js' }, '*')`,
    );
    await until(
      () =>
        attempts.some(
          (attempt) =>
            !attempt.isMainFrame && attempt.url === 'doric://app/frame/boot.js',
        ) || undefined,
      'the navigation attempt',
    );
    await new Promise((done) => setTimeout(done, 300));
    assert.ok(await answers('self'));
    assert.equal(previewFrame()?.url, FRAME_URL);

    const before = attempts.length;

    await page(
      contents,
      `document.getElementById('preview').src = 'doric://app/frame/boot.js'`,
    );
    await until(
      () => attempts.length > before || undefined,
      'the shell navigation attempt',
    );
    await new Promise((done) => setTimeout(done, 300));
    assert.ok(await answers('shell'));
    assert.equal(previewFrame()?.url, FRAME_URL);
  });

  test('a navigation outside frame-src fails and never shows the shell', async () => {
    const failed: { code: number; url: string }[] = [];

    contents.on('did-fail-load', (_event, code, _text, url, isMain) => {
      if (!isMain) {
        failed.push({ code, url });
      }
    });
    // The shell's CSP refuses it before the guard sees it: the frame ends on
    // Chromium's error page for that URL, not on the shell's document.
    await page(
      contents,
      `document.getElementById('preview').contentWindow.postMessage({ navigate: 'doric://app/settings' }, '*')`,
    );
    await until(() => failed.length > 0 || undefined, 'the failed load');
    // net::ERR_BLOCKED_BY_CSP
    assert.deepEqual(failed, [{ code: -30, url: 'doric://app/settings' }]);

    const frame = contents.mainFrame.frames.find(
      (candidate) => candidate.url === 'doric://app/settings',
    ) as WebFrameMain;

    assert.equal(
      await frame.executeJavaScript(
        `document.querySelector('meta[name="doric-generation"]') === null && typeof window.doric`,
      ),
      'undefined',
    );
  });
});
