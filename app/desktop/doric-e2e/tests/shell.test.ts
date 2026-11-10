// The shell's view of the app in a real window. T-2.10: the window's
// description carries the version main reads with `app.getVersion()`.
// T-2.2 and T-2.4: the real renderer shell with the real core, layout and
// resources bundles draws the account status. T-2.5: with the real git, files
// and chat bundles, the working directory and branch sit in the Files column
// footer and the branch picker switches. T-2.17: the Files column has no
// toggle and does not collapse. With `DORIC_SHELL_CAPTURES=<dir>`,
// the prototype states are captured at 1920×1080 in dark and light for the
// §2.9 shell check, with the phase 3 states of the bundles' own surfaces
// (the settings window at 1024×720), phase 4.1's Appearance section and
// phase 4.4's context menus, name row and Discard dialog.

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
import { capturePrototypeStates } from './support/prototype-states';
import {
  click,
  clickOn,
  dragBy,
  focused,
  go,
  inPage,
  painted,
  press,
  textsOf,
  type,
  waitFor,
  waitForSelector,
} from './support/shell-page';
import { BRANCH, CWD, type GitCalls } from './support/workspace-content';
import { PLAN, serveWorkspace, THREAD_PATH } from './support/workspace-host';

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
  let git: GitCalls;

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
    host = await startFakeHost(await workspaceDistribution());
    git = serveWorkspace(host);
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

  test('the working directory and branch sit in the Files footer, and the branch picker switches (T-2.5)', async () => {
    const filesFooter = '[data-slot="workspace-files-footer"]';
    const conversationFooter = '[data-slot="workspace-footer"]';
    const summary = 'Working directory and branch';
    const option = (branch: string) =>
      `[role="option"][data-value=${JSON.stringify(branch)}]`;

    await go(contents, THREAD_PATH);
    await waitFor(contents, summary, 'button', 20_000, filesFooter).catch(
      async (error: unknown) => {
        console.log(await diagnose());
        throw error;
      },
    );
    await until(
      async () =>
        (await textsOf(contents, filesFooter)).join('\n').includes(BRANCH)
          ? true
          : undefined,
      'the branch in the Files footer',
    );

    const files = (await textsOf(contents, filesFooter)).join('\n');
    const conversation = (await textsOf(contents, conversationFooter)).join(
      '\n',
    );

    assert.ok(files.includes(CWD), `The Files footer reads: ${files}`);
    assert.ok(files.includes(BRANCH), `The Files footer reads: ${files}`);
    assert.ok(
      !conversation.includes(CWD) && !conversation.includes(BRANCH),
      `The conversation footer reads: ${conversation}`,
    );
    assert.equal(
      await inPage<number>(
        contents,
        `deepAll(${JSON.stringify(`${conversationFooter} [aria-label="${summary}"]`)}).length`,
      ),
      0,
    );

    // The summary, then its branch picker, then a search that keeps one branch.
    await click(contents, summary, 'button', filesFooter);
    await click(contents, 'Select branch');
    await waitForSelector(contents, 'input[aria-label="Search branches"]');
    await waitForSelector(contents, option('main'));
    await type(contents, 'apple');
    await until(
      async () =>
        (await textsOf(contents, '[role="option"]')).length === 1
          ? true
          : undefined,
      'the search to keep one branch',
      5_000,
    ).catch(() => undefined);

    const shown = await inPage<string[]>(
      contents,
      `deepAll('[role="option"]').filter(visible).map((o) => o.dataset.value)`,
    );

    assert.deepEqual(shown, ['feat/apple-pay']);

    await clickOn(contents, option('feat/apple-pay'));
    await until(
      async () => (git.switches.length > 0 ? true : undefined),
      'the branch switch',
    );
    assert.deepEqual(git.switches, [
      { threadId: PLAN.id, branch: 'feat/apple-pay', cwd: CWD },
    ]);
    await until(
      async () =>
        (await textsOf(contents, filesFooter))
          .join('\n')
          .includes('feat/apple-pay')
          ? true
          : undefined,
      'the switched branch in the Files footer',
    );

    // Back to the prototype's branch for the captures: the switch closed the
    // branch picker, and the summary stays open over the footer.
    await painted(contents);
    if (
      !(await inPage<boolean>(
        contents,
        `deepAll('button[aria-label="Select branch"]').some(visible)`,
      ))
    ) {
      await click(contents, summary, 'button', filesFooter);
    }
    await click(contents, 'Select branch');
    await clickOn(contents, option(BRANCH));
    await until(
      async () => (git.switches.length > 1 ? true : undefined),
      'the switch back',
    );
    press(contents, 'Escape');
    press(contents, 'Escape');
  });

  test('the Files column has no FilesToggle and does not collapse (T-2.17)', async () => {
    const filesHeader = '[data-slot="workspace-files-header"]';
    const visibleButton = (name: string): Promise<boolean> =>
      inPage<boolean>(
        contents,
        `deepAll(${JSON.stringify(`button[aria-label="${name}"]`)}).some(visible)`,
      );
    const columnWidth = (): Promise<number> =>
      inPage<number>(
        contents,
        `(() => {
          const header = deepAll(${JSON.stringify(filesHeader)}).find(visible);
          const column = header?.closest('[data-panel]');
          return column ? Math.round(column.getBoundingClientRect().width) : 0;
        })()`,
      );

    await go(contents, THREAD_PATH);
    await waitFor(contents, 'Account', 'button', 20_000, filesHeader).catch(
      async (error: unknown) => {
        console.log(await diagnose());
        throw error;
      },
    );
    assert.equal(await visibleButton('Hide files'), false);
    assert.equal(await visibleButton('Show files'), false);
    assert.equal(
      await inPage<boolean>(
        contents,
        `customElements.get('files-toggle') === undefined`,
      ),
      true,
      'The files-toggle element is still defined.',
    );

    // The Files handle is the rightmost; dragging it right shrinks the column
    // toward collapse. It stops at the 14rem (224 px) minimum.
    await dragBy(contents, '[data-slot="resizable-handle"]', 2000);
    await new Promise((done) => setTimeout(done, 200));

    const width = await columnWidth();
    assert.ok(width >= 224, `The Files column is ${width} px wide.`);
    await waitFor(contents, 'Account', 'button', 20_000, filesHeader);
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
      written.push(
        ...(await capturePrototypeStates({
          booted,
          window,
          dir: dir as string,
          theme,
          diagnose,
        })),
      );
    }

    console.log(`# shell captures:\n#   ${written.join('\n#   ')}`);
    // Thirty-two states (eighteen, and fourteen of 4.4's menus, name row
    // and Discard dialog), a PNG and its JSON rows each, in two themes.
    assert.equal(written.length, 128);
  });
});
