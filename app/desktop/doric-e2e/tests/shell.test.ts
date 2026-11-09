// The shell's view of the app in a real window. T-2.10: the window's
// description carries the version main reads with `app.getVersion()`.
// T-2.2 and T-2.4: the real renderer shell with the real core, layout and
// resources bundles draws the account status. With
// `DORIC_SHELL_CAPTURES=<dir>`, the prototype states are captured at
// 1920×1080 in dark and light for the §2.9 shell check.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import {
  app,
  type BrowserWindow,
  nativeTheme,
  type WebContents,
} from 'electron';

import {
  coreDistribution,
  workspaceDistribution,
} from '../../doric/tests/support/core';
import {
  type Booted,
  bootPlatform,
  type FakeHost,
  page,
  startFakeHost,
  until,
} from './support/harness';
import {
  captureState,
  click,
  focused,
  go,
  inPage,
  painted,
  press,
  waitFor,
} from './support/shell-page';
import {
  BILLING,
  CHECKOUT,
  DOCS,
  serveWorkspace,
  THREAD_PATH,
  threadRouteFixture,
} from './support/workspace-host';

describe('the shell in an app window', () => {
  let host: FakeHost;
  let booted: Booted;
  let contents: WebContents;

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

describe('the real shell over the workspace bundles', () => {
  let host: FakeHost;
  let booted: Booted;
  let window: BrowserWindow;
  let contents: WebContents;
  let themeSource: typeof nativeTheme.themeSource;

  const consoleLines: string[] = [];
  const recordConsole = (_event: unknown, created: WebContents) =>
    created.on('console-message', (details) => {
      const { level, message } = details as unknown as {
        level: string;
        message: string;
      };

      if (level !== 'info' && level !== 'debug') {
        consoleLines.push(`${level}: ${message}`);
      }
    });

  before(async () => {
    app.on('web-contents-created', recordConsole);
    themeSource = nativeTheme.themeSource;
    host = await startFakeHost(
      await workspaceDistribution({ bundles: [threadRouteFixture] }),
    );
    serveWorkspace(host);
    booted = await bootPlatform({ host, shell: 'renderer' });
    window = await booted.window('workspace');
    contents = window.webContents;
    await waitFor(contents, 'Account').catch(async (error: unknown) => {
      console.log(await diagnose());
      throw error;
    });
  });

  /** What the window got, printed when a wait times out. */
  const diagnose = async (): Promise<string> =>
    JSON.stringify(
      {
        calls: [
          ...new Set(
            host.calls.map((call) => `${call.contract} ${call.method}`),
          ),
        ],
        logs: booted.logs.filter((entry) => entry.level !== 'info'),
        console: consoleLines.slice(-30),
        path: await page<string>(contents, 'location.pathname'),
        text: await page<string>(
          contents,
          'document.body.innerText.slice(0, 1500)',
        ),
      },
      null,
      2,
    );

  after(async () => {
    app.off('web-contents-created', recordConsole);
    nativeTheme.themeSource = themeSource;
    await booted?.dispose().catch(() => undefined);
    await host?.close();
  });

  test('the account menu reads the app version (T-2.2)', async () => {
    await click(contents, 'Account');

    const menu = await until(
      () =>
        inPage<string | undefined>(
          contents,
          `deepAll('[role="menu"]').filter(visible).map((m) => m.textContent).join('\\n') || undefined`,
        ),
      'the account menu',
    ).catch(async (error: unknown) => {
      console.log(await diagnose());
      throw error;
    });

    press(contents, 'Escape');

    assert.ok(
      menu.includes(`MIT License · v${app.getVersion()}`),
      `The account menu reads: ${menu}`,
    );
  });

  test('the avatar and the badge are separate Tab stops (T-2.4)', async () => {
    await waitFor(contents, 'Connection and resources').catch(
      async (error: unknown) => {
        console.log(await diagnose());
        throw error;
      },
    );

    // Start on the avatar, then move with the keyboard only.
    await inPage(
      contents,
      `deepAll('button[aria-label="Account"]').find(visible).focus()`,
    );
    assert.deepEqual(await focused(contents), {
      tag: 'button',
      name: 'Account',
    });

    press(contents, 'Tab');
    await until(
      async () =>
        (await focused(contents))?.name === 'Connection and resources'
          ? true
          : undefined,
      'Tab to reach the badge',
      5_000,
    ).catch(() => undefined);
    assert.deepEqual(await focused(contents), {
      tag: 'button',
      name: 'Connection and resources',
    });

    press(contents, 'Tab', ['shift']);
    await until(
      async () =>
        (await focused(contents))?.name === 'Account' ? true : undefined,
      'Shift+Tab to reach the avatar',
      5_000,
    ).catch(() => undefined);
    assert.deepEqual(await focused(contents), {
      tag: 'button',
      name: 'Account',
    });
    // Two buttons, neither inside the other.
    assert.equal(
      await inPage<boolean>(
        contents,
        `(() => {
          const avatar = deepAll('button[aria-label="Account"]').find(visible);
          const badge = deepAll('button[aria-label="Connection and resources"]').find(visible);
          return avatar !== badge && !avatar.contains(badge) && !badge.contains(avatar);
        })()`,
      ),
      true,
    );
  });

  const dir = process.env.DORIC_SHELL_CAPTURES;

  test('captures the prototype states at 1920×1080 in dark and light (§2.9)', {
    skip: dir === undefined || dir === '',
  }, async () => {
    window.setContentSize(1920, 1080);
    await until(() => {
      const [width, height] = window.getContentSize();

      return width === 1920 && height === 1080 ? true : undefined;
    }, 'the 1920×1080 content size');

    const written: string[] = [];
    const at = async (path: string) => {
      await until(
        async () =>
          (await page<string>(contents, 'location.pathname')) === path
            ? true
            : undefined,
        `the window at ${path}`,
      );
      await painted(contents, 500);
    };

    for (const theme of ['dark', 'light'] as const) {
      nativeTheme.themeSource = theme;
      await until(
        async () =>
          (await page<boolean>(
            contents,
            `document.documentElement.classList.contains('dark')`,
          )) ===
          (theme === 'dark')
            ? true
            : undefined,
        `the ${theme} theme`,
      );

      // The Project view (99:8035) with its three Project tabs and its
      // Thread open; the conversation is empty until the chat bundle (2f-2).
      for (const path of [
        THREAD_PATH,
        `/projects/${DOCS.id}`,
        `/projects/${BILLING.id}`,
        THREAD_PATH,
      ]) {
        await go(contents, path);
        await painted(contents, 100);
      }
      await waitFor(contents, CHECKOUT.name)
        .then(() => waitFor(contents, BILLING.name))
        .catch(async (error: unknown) => {
          console.log(await diagnose());
          throw error;
        });
      const shots = [
        await captureState({
          booted,
          window,
          dir: dir as string,
          node: '99:8035',
          state:
            'Project / Checkout redesign · Thread (empty conversation: no chat bundle)',
          theme,
        }),
      ];

      // The new tab's Recent Dashboard (85:7726), from the tab bar's "+".
      // (From /projects the same "+" shows the All projects form: the
      // outlet recreates the workspace for the `/` route and the new-tab
      // state is lost; see the 2f-1 report.)
      await click(
        contents,
        'New project',
        'button',
        '[aria-label="Workspace tabs"]',
      );
      await at('/');
      shots.push(
        await captureState({
          booted,
          window,
          dir: dir as string,
          node: '85:7726',
          state: 'Home / Dashboard · Recent (new tab)',
          theme,
        }),
      );

      // The Dashboard of every Project (85:7520), from the Project view's
      // sidebar header.
      await go(contents, THREAD_PATH);
      await click(contents, 'Dashboard');
      await at('/projects');
      shots.push(
        await captureState({
          booted,
          window,
          dir: dir as string,
          node: '85:7520',
          state: 'Home / Dashboard · All projects',
          theme,
        }),
      );

      for (const shot of shots) {
        written.push(shot.png, shot.json);
      }
    }

    console.log(`# shell captures:\n#   ${written.join('\n#   ')}`);
    assert.equal(written.length, 12);
  });
});
