// The §2.9 shell check's states, reached as a reader would in the real shell
// over the workspace bundles and captured at the window's size in one theme:
// `99:8035` (Project view, Thread open), `99:8508` (a sub-thread in the
// viewer), S27 (Files collapsed, viewer open), `85:7726` (the new tab's Recent
// Dashboard) and `85:7520` (the Dashboard of every Project). Phase 3 adds the
// bundles' own surfaces: both usage popovers (`usage-context`, `usage-cost`),
// the agent thread in the viewer (`viewer-agent`), a file in the viewer
// (`file-viewer`), the Changes tab (`changes`) and a diff (`git-diff`), and
// the settings window on its Providers section (`settings-window`).

import type { BrowserWindow, WebContents } from 'electron';

import { type Booted, page, until } from './harness';
import {
  captureState,
  click,
  clickOn,
  go,
  inPage,
  painted,
  press,
  waitFor,
  waitForSelector,
} from './shell-page';
import { ANSWER } from './workspace-content';
import {
  BILLING,
  CHECKOUT,
  DOCS,
  FROZEN_NOW,
  PAYMENT_FORM,
  THREAD_PATH,
  VALIDATE_CARDS,
} from './workspace-host';

/** The directories the prototype's Files column shows open. */
const OPEN_DIRECTORIES = [
  'apps',
  'web',
  'src',
  'checkout',
  'docs',
  'packages',
] as const;

/** A tree row named `name`, with or without its change mark. */
const treeRow = (name: string): string =>
  `[role="treeitem"][aria-label=${JSON.stringify(name)}], [role="treeitem"][aria-label^=${JSON.stringify(`${name},`)}]`;

const VIEWER = 'section[aria-label="Viewer"]';
const TAB_BAR_END = '[data-slot="project-tab-actions"]';
const FILES_HEADER = '[data-slot="workspace-files-header"]';
const SUB_THREAD_TAB = `[data-tab-id="thread:${PAYMENT_FORM.id}"]`;
const AGENT_THREAD_TAB = `[data-tab-id="thread:${VALIDATE_CARDS.id}"]`;
const SIDEBAR_ROWS =
  '[data-slot="sidebar-menu-button"], [data-slot="sidebar-menu-sub-button"]';
const VIEWER_TAB_CLOSE =
  '[data-slot="workspace-viewer-header"] [data-slot="tab-close"]';
const POPOVER = '[data-slot="popover-content"]';
const FILE_VIEW_FOOTER = `${VIEWER} footer:not([data-slot])`;
const CHANGES_TAB = `${FILES_HEADER} [data-tab-id="changes"]`;
const FILES_TAB = `${FILES_HEADER} [data-tab-id="files"]`;
const REPOSITORY_ROW = '[role="treeitem"][aria-label*="lines added"]';
const SETTINGS_TITLE_BAR = '[data-slot="settings-title-bar"]';

/** Resolves once no visible element matches `selector`. */
const gone = (
  contents: WebContents,
  selector: string,
  what: string,
): Promise<true> =>
  until(
    async () =>
      (await inPage<boolean>(
        contents,
        `deepAll(${JSON.stringify(selector)}).some(visible)`,
      ))
        ? undefined
        : true,
    what,
  );

/** Resolves once the visible text of `selector` includes `text`. */
const showing = (
  contents: WebContents,
  selector: string,
  text: string,
  what: string,
): Promise<true> =>
  until(
    () =>
      inPage<boolean>(
        contents,
        `deepAll(${JSON.stringify(selector)}).filter(visible).some((e) => (e.innerText ?? '').includes(${JSON.stringify(text)}))`,
      ).then((found) => (found ? true : undefined)),
    what,
  );

/**
 * Moves the pointer onto an empty spot of the page's main card (the
 * conversation, else the Dashboard's content, else the settings content) and,
 * unless `blur` is false (an open popover keeps its focus), takes focus off
 * the control the last click focused, so neither a hover fill nor a focus
 * state is captured.
 */
const restPointer = async (
  contents: WebContents,
  blur = true,
): Promise<void> => {
  const spot = await inPage<{ x: number; y: number }>(
    contents,
    `(() => {
      const card = ['[aria-label="Thread conversation"]', '[data-slot="dashboard-content"]', 'main']
        .map((selector) => deepAll(selector).find(visible))
        .find(Boolean);
      const rect = card ? card.getBoundingClientRect() : { x: 0, y: 0, width: innerWidth, height: innerHeight };
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height * 0.8) };
    })()`,
  );

  contents.sendInputEvent({ type: 'mouseMove', ...spot });

  if (blur) {
    await inPage(contents, 'deepActive()?.blur?.()');
  }
};

/** Closes every tab of the viewer, so the viewer itself closes. */
const closeViewer = async (contents: WebContents): Promise<void> => {
  while (
    await inPage<boolean>(
      contents,
      `deepAll(${JSON.stringify(VIEWER_TAB_CLOSE)}).some(visible)`,
    )
  ) {
    await clickOn(contents, VIEWER_TAB_CLOSE);
    await painted(contents, 200);
  }

  await gone(contents, VIEWER, 'the viewer to close');
};

/**
 * Runs `step` with the page's `Date.now` held at `FROZEN_NOW`, so the running
 * Thread's elapsed badge reads the prototype's 02:00 on every run, and a
 * Dashboard opened inside `step` reads the prototype's relative times. The
 * badge reads the clock once a second: the hold lasts past one reading.
 */
const atFrozenClock = async <T>(
  contents: WebContents,
  step: () => Promise<T>,
): Promise<T> => {
  await page(
    contents,
    `(() => { window.__doricRealNow ??= Date.now; Date.now = () => ${FROZEN_NOW}; })()`,
  );

  try {
    await new Promise((done) => setTimeout(done, 1_200));
    await painted(contents, 100);

    return await step();
  } finally {
    await page(
      contents,
      '(() => { if (window.__doricRealNow) Date.now = window.__doricRealNow; })()',
    );
  }
};

/** The answer's first words, as the conversation draws them. */
const ANSWER_START = ANSWER.slice(0, ANSWER.indexOf('`')).trim();

/**
 * Walks the states in the current theme and captures each one; answers the
 * files written. `diagnose` explains a wait that timed out.
 */
export const capturePrototypeStates = async (input: {
  readonly booted: Booted;
  readonly window: BrowserWindow;
  readonly dir: string;
  readonly theme: 'dark' | 'light';
  readonly diagnose: () => Promise<string>;
}): Promise<string[]> => {
  const { booted, window, dir, theme } = input;
  const contents = window.webContents;
  const written: string[] = [];
  const shoot = async (
    node: string,
    state: string,
    frozen = false,
    blur = true,
  ) => {
    await restPointer(contents, blur);
    await painted(contents, 300);

    const capture = () =>
      captureState({ booted, window, dir, node, state, theme });
    const shot = frozen
      ? await atFrozenClock(contents, capture)
      : await capture();

    written.push(shot.png, shot.json);
  };
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
  const explained = <T>(step: Promise<T>): Promise<T> =>
    step.catch(async (error: unknown) => {
      console.log(await input.diagnose());
      throw error;
    });

  // 99:8035: the Project view with its three Project tabs, its Thread's
  // conversation and the Files column open as the prototype draws it.
  for (const path of [
    THREAD_PATH,
    `/projects/${DOCS.id}`,
    `/projects/${BILLING.id}`,
    THREAD_PATH,
  ]) {
    await go(contents, path);
    await painted(contents, 100);
  }
  await explained(
    waitFor(contents, CHECKOUT.name).then(() =>
      waitFor(contents, BILLING.name),
    ),
  );
  await explained(
    showing(
      contents,
      '[aria-label="Thread conversation"]',
      ANSWER_START,
      'the answer in the conversation',
    ),
  );

  for (const name of OPEN_DIRECTORIES) {
    const row = treeRow(name);

    await explained(waitForSelector(contents, row));

    if (
      await inPage<boolean>(
        contents,
        `deepAll(${JSON.stringify(row)}).find(visible).getAttribute('aria-expanded') === 'false'`,
      )
    ) {
      await clickOn(contents, row);
    }
  }
  await explained(waitForSelector(contents, treeRow('payment-form.tsx')));
  // The execution picker (settings) and the agent's model mark (models/v1)
  // are drawn once their reads answer.
  await explained(
    waitForSelector(
      contents,
      '[data-slot="workspace-footer"] [aria-label="Execution model"]',
    ),
  );
  await shoot('99:8035', 'Project / Checkout redesign · Thread', true);

  // usage-context and usage-cost: the footer's two usage popovers open over
  // 99:8035 (Figma `39:877`, `39:236`).
  for (const [node, name, state] of [
    [
      'usage-context',
      'Context window usage',
      'Project / Checkout redesign · Thread · Context popover',
    ],
    [
      'usage-cost',
      'Show conversation cost breakdown',
      'Project / Checkout redesign · Thread · Cost breakdown',
    ],
  ] as const) {
    await explained(click(contents, name));
    await explained(waitForSelector(contents, POPOVER));
    await shoot(node, state, true, false);
    press(contents, 'Escape');
    await explained(gone(contents, POPOVER, `the ${node} popover to close`));
  }

  // 99:8508: the running sub-thread opened from the sidebar, in the viewer.
  await clickOn(contents, SIDEBAR_ROWS, PAYMENT_FORM.name);
  await explained(
    showing(contents, VIEWER, ANSWER_START, 'the sub-thread in the viewer'),
  );
  await shoot(
    '99:8508',
    'Project / Checkout redesign · Sub-thread in viewer',
    true,
  );

  // S27: the Files column collapsed while the viewer stays open, through
  // the "Hide files" toggle in the column's header.
  await explained(click(contents, 'Hide files', 'button', FILES_HEADER));
  await explained(gone(contents, FILES_HEADER, 'the Files column to collapse'));
  await explained(
    waitFor(contents, 'Show files', 'button', 20_000, TAB_BAR_END),
  );
  await painted(contents, 300);
  await shoot(
    'S27',
    'Project / Checkout redesign · Files collapsed, viewer open',
    true,
  );
  await explained(click(contents, 'Show files', 'button', TAB_BAR_END));
  await explained(waitForSelector(contents, FILES_HEADER));

  // viewer-agent: the agent's thread under the sub-thread, in the viewer: its
  // footer carries the AgentThreadControls (Figma `32:49144`).
  await clickOn(contents, SIDEBAR_ROWS, VALIDATE_CARDS.name);
  await explained(waitForSelector(contents, AGENT_THREAD_TAB));
  await explained(waitFor(contents, 'Pause agent thread'));
  await shoot(
    'viewer-agent',
    'Project / Checkout redesign · Agent thread in viewer',
    true,
  );
  await clickOn(contents, `${SUB_THREAD_TAB} [data-slot="tab-close"]`);
  await gone(contents, SUB_THREAD_TAB, 'the sub-thread tab to close');
  await closeViewer(contents);

  // file-viewer: payment-form.tsx opened from the Files tree, in the viewer:
  // the file view and its footer, the selected row and its badge (Figma
  // `30:12630`, `30:12640`, `30:12956`).
  await clickOn(contents, treeRow('payment-form.tsx'));
  await explained(waitForSelector(contents, FILE_VIEW_FOOTER));
  await explained(
    showing(contents, VIEWER, 'PaymentForm', 'the file in the viewer'),
  );
  await shoot(
    'file-viewer',
    'Project / Checkout redesign · File in viewer',
    true,
  );
  await closeViewer(contents);

  // changes: the Files column's Changes tab, its repository row and the
  // changed file (Figma `27:8827`, `27:9693`).
  await explained(clickOn(contents, CHANGES_TAB));
  await explained(waitForSelector(contents, REPOSITORY_ROW));

  if (
    await inPage<boolean>(
      contents,
      `deepAll(${JSON.stringify(REPOSITORY_ROW)}).find(visible).getAttribute('aria-expanded') === 'false'`,
    )
  ) {
    await clickOn(contents, REPOSITORY_ROW);
  }
  await explained(waitForSelector(contents, treeRow('payment-form.tsx')));
  await shoot('changes', 'Project / Checkout redesign · Changes', true);

  // git-diff: the changed file's diff in the viewer, its toolbar and footer
  // (Figma `27:14162`, `27:14284`).
  await clickOn(contents, treeRow('payment-form.tsx'));
  await explained(waitForSelector(contents, '[data-slot="diff-toolbar"]'));
  await explained(waitForSelector(contents, '[data-slot="diff-footer"]'));
  await painted(contents, 500);
  await shoot('git-diff', 'Project / Checkout redesign · Diff in viewer', true);
  await closeViewer(contents);
  await explained(clickOn(contents, FILES_TAB));
  await explained(waitForSelector(contents, treeRow('payment-form.tsx')));

  // The Dashboard reads its relative times when it mounts, so the clock is
  // held from before it opens until the capture: the rows then read the
  // prototype's "just now" … "4 days ago" (`85:7726`, `85:7520`).

  // 85:7726: the new tab's Recent Dashboard, from the Project view's "+".
  await atFrozenClock(contents, async () => {
    await click(
      contents,
      'New project',
      'button',
      '[aria-label="Workspace tabs"]',
    );
    await at('/');
    await shoot('85:7726', 'Home / Dashboard · Recent (new tab)');
  });

  // 85:7520: the Dashboard of every Project, from the sidebar header.
  await go(contents, THREAD_PATH);
  await atFrozenClock(contents, async () => {
    await click(contents, 'Dashboard');
    await at('/projects');
    await shoot('85:7520', 'Home / Dashboard · All projects');
  });

  // settings-window: the account menu's Settings opens the settings window,
  // sized 1024×720, on its Providers section (Figma `36:22049`, `36:19734`).
  written.push(
    ...(await captureSettingsWindow({ booted, contents, dir, theme })),
  );

  return written;
};

/**
 * Opens the settings window from the account menu, shows its Providers
 * section at 1024×720, captures it (key `settings`) and closes it.
 */
const captureSettingsWindow = async (input: {
  readonly booted: Booted;
  readonly contents: WebContents;
  readonly dir: string;
  readonly theme: 'dark' | 'light';
}): Promise<string[]> => {
  const { booted, contents, dir, theme } = input;

  await click(contents, 'Account');
  await clickOn(contents, '[role="menuitem"]', 'Settings');

  const window = await booted.window('settings');
  const settings = window.webContents;

  try {
    window.setContentSize(1024, 720);
    await until(() => {
      const [width, height] = window.getContentSize();

      return width === 1024 && height === 720 ? true : undefined;
    }, 'the 1024×720 settings window');
    await waitForSelector(settings, SETTINGS_TITLE_BAR);

    const providers = '[data-slot="sidebar"] :is(a, button, [role="link"])';

    if (
      await inPage<boolean>(
        settings,
        `deepAll(${JSON.stringify(providers)}).filter(visible).some((e) => (e.innerText ?? '').trim().startsWith('Providers'))`,
      )
    ) {
      await clickOn(settings, providers, 'Providers');
    } else {
      await go(settings, '/settings/providers');
    }
    await until(
      async () =>
        (await page<string>(settings, 'location.pathname')) ===
        '/settings/providers'
          ? true
          : undefined,
      'the Providers section',
    );
    await waitForSelector(settings, 'main tbody tr');
    await restPointer(settings);
    await painted(settings, 500);

    const shot = await captureState({
      booted,
      window,
      key: 'settings',
      dir,
      node: 'settings-window',
      state: 'Settings window · Providers',
      theme,
    });

    return [shot.png, shot.json];
  } finally {
    await new Promise<void>((done) => {
      window.once('closed', () => done());
      window.close();
    });
  }
};
