// The §2.9 shell check's states, reached as a reader would in the real shell
// over the workspace bundles and captured at the window's size in one theme:
// `99:8035` (Project view, Thread open), `99:8508` (a sub-thread in the
// viewer), `85:7726` (the new tab's Recent Dashboard) and `85:7520` (the
// Dashboard of every Project). Phase 3 adds the
// bundles' own surfaces: both usage popovers (`usage-context`, `usage-cost`),
// the agent thread in the viewer (`viewer-agent`), a file in the viewer
// (`file-viewer`), the Changes tab (`changes`) and a diff (`git-diff`), and
// the settings window on its Providers section (`settings-window`). Phase 4.1
// adds its Appearance section with each tile selected
// (`settings-appearance-<theme>`, `65:13666`); 4.2 adds Back after opening a
// sub-thread (`history-back`); 4.3 the sidebar's Thread search with a match,
// with none and focused by ⌘F (`thread-search`, `thread-search-empty`,
// `thread-search-focus`); 4.4 its context menus by right-click (G16), the
// Files name row with a taken name and the Discard dialog with a refusal
// (`menu-*`, `new-file-row`, `new-file-exists`, `discard-dialog`,
// `discard-refused`).

import type { BrowserWindow, WebContents } from 'electron';

import { type Booted, page, until } from './harness';
import {
  captureState,
  click,
  clickOn,
  focused,
  go,
  hover,
  inPage,
  painted,
  press,
  rightClick,
  type,
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
  PLAN,
  TAKEN_NAME,
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
const SIDEBAR_HEADER = '[data-slot="workspace-sidebar-header"]';
const BACK = 'button[aria-label="Back"]';
const FORWARD = 'button[aria-label="Forward"]';
const THREAD_SEARCH = 'input[aria-label="Search Threads"]';
const THREADS_EMPTY = '[data-threads-empty]';
const COMPOSER = '[aria-label="Thread conversation"] [contenteditable="true"]';
/** Resolves once the sidebar tree shows (or no longer shows) `name`. */
const treeShows = (
  contents: WebContents,
  name: string,
  shown: boolean,
): Promise<true> =>
  until(
    async () =>
      (await inPage<boolean>(
        contents,
        `deepAll('[role="treeitem"][data-slot="sidebar-menu-sub-button"]').filter(visible).some((e) => (e.innerText ?? '').trim() === ${JSON.stringify(name)})`,
      )) === shown
        ? true
        : undefined,
    `the tree ${shown ? 'to show' : 'to hide'} ${name}`,
  );
/** A main Thread of Checkout redesign other than the open one. */
const AUDIT_NAME = 'Accessibility audit';

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
    rest = true,
  ) => {
    if (rest) {
      await restPointer(contents, blur);
    }
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

  // history-back (4.2): another main Thread opened from the sidebar, then
  // Back in the sidebar header: the open Thread again, Forward enabled, Back
  // as the window's stack allows. The prototype's hotspot (`122:26445`) opens
  // "Build the payment form", but a sub-thread opens in the viewer and writes
  // no history entry; a main Thread's selection is pushed to the path.
  await clickOn(contents, SIDEBAR_ROWS, AUDIT_NAME);
  await explained(
    until(
      async () =>
        (await page<string>(contents, 'location.pathname')) !== THREAD_PATH
          ? true
          : undefined,
      'the window to leave the open Thread',
    ),
  );
  await painted(contents, 300);
  await explained(clickOn(contents, `${SIDEBAR_HEADER} ${BACK}`));
  await at(THREAD_PATH);
  await explained(
    until(
      async () =>
        (await inPage<boolean>(
          contents,
          `deepAll(${JSON.stringify(`${SIDEBAR_HEADER} ${FORWARD}`)}).some((e) => visible(e) && !e.disabled)`,
        ))
          ? true
          : undefined,
      'Forward to be enabled after Back',
    ),
  );
  await shoot(
    'history-back',
    'Project / Checkout redesign · Back after opening a sub-thread',
    true,
  );
  if (
    await inPage<boolean>(
      contents,
      `deepAll(${JSON.stringify(VIEWER)}).some(visible)`,
    )
  ) {
    await closeViewer(contents);
  }

  // thread-search, thread-search-empty, thread-search-focus (4.3): "pay" and
  // "zzz" typed into the sidebar's "Search Threads" (`I269:31402;331:42177`),
  // then ⌘F with focus in the composer: the field focused, its ring drawn.
  const clearSearch = async () => {
    await explained(clickOn(contents, THREAD_SEARCH));
    press(contents, 'Escape');
    await explained(gone(contents, THREADS_EMPTY, 'the query to clear'));
    await explained(treeShows(contents, AUDIT_NAME, true));
  };
  await explained(clickOn(contents, THREAD_SEARCH));
  await type(contents, 'pay');
  await explained(treeShows(contents, AUDIT_NAME, false));
  await shoot(
    'thread-search',
    'Project / Checkout redesign · Search "pay"',
    true,
  );
  await clearSearch();
  await explained(clickOn(contents, THREAD_SEARCH));
  await type(contents, 'zzz');
  await explained(waitForSelector(contents, THREADS_EMPTY));
  await shoot(
    'thread-search-empty',
    'Project / Checkout redesign · Search with no match',
    true,
  );
  await clearSearch();
  await inPage(
    contents,
    `deepAll(${JSON.stringify(COMPOSER)}).filter(visible).at(-1)?.focus()`,
  );
  press(contents, 'F', ['meta']);
  await explained(
    until(
      async () =>
        (await focused(contents))?.name === 'Search Threads' ? true : undefined,
      'the ⌘F focus on Search Threads',
    ),
  );
  await shoot(
    'thread-search-focus',
    'Project / Checkout redesign · ⌘F from the composer',
    true,
    false,
  );
  await inPage(contents, 'deepActive()?.blur?.()');

  await explained(captureMenus(contents, shoot));

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

    // menu-dashboard-row (4.4 A2): a Project row's menu on the Dashboard.
    await explained(
      rightClick(
        contents,
        `[data-slot="dashboard-content"] [data-project-id="${CHECKOUT.id}"]`,
      ),
    );
    await explained(waitForSelector(contents, MENU));
    await shoot(
      'menu-dashboard-row',
      'Home / Dashboard · Project row menu',
      false,
      false,
    );
    await closeMenu(contents);
  });

  // settings-window: the account menu's Settings opens the settings window,
  // sized 1024×720, on its Providers section (Figma `36:22049`, `36:19734`).
  written.push(
    ...(await captureSettingsWindow({ booted, contents, dir, theme })),
  );

  return written;
};

const MENU = '[data-slot="context-menu-content"]';
const MENU_ITEM = `${MENU} :is([data-slot="context-menu-item"], [data-slot="context-menu-sub-trigger"])`;
const SUB_MENU = '[data-slot="context-menu-sub-content"]';
const DIALOG = '[data-slot="alert-dialog-content"]';
const NAME_ROW = 'input[aria-label="New file name"]';
const VIEWER_TAB = '[data-slot="workspace-viewer-header"] [data-tab-id]';

/** Closes the open context menu (and its submenu) with Escape. */
const closeMenu = async (contents: WebContents): Promise<void> => {
  for (let tries = 0; tries < 3; tries += 1) {
    if (
      !(await inPage<boolean>(
        contents,
        `deepAll(${JSON.stringify(MENU)}).some(visible)`,
      ))
    ) {
      break;
    }
    press(contents, 'Escape');
    await painted(contents, 200);
  }
  await gone(contents, MENU, 'the context menu to close');
};

type Shoot = (
  node: string,
  state: string,
  frozen?: boolean,
  blur?: boolean,
  rest?: boolean,
) => Promise<void>;

/**
 * The §4.4 menus over the Project view (`99:8035`), reached by right-click as
 * a reader opens them (G16: `ContextMenu/Content` `18:645`, `ContextMenu/Item`
 * `16:339`, destructive `16:363`): the Thread row (A1), the Project tab (A3)
 * and its Color submenu, the Files rows (A8–A10) with the name row and its
 * `exists` answer, a file's tab (A5), the Changes rows (A11, A12) with the
 * Discard dialog and its refusal, and a diff's tab (A6). Each menu is captured
 * with the pointer off it and its focus kept (an open menu holds focus).
 */
const captureMenus = async (
  contents: WebContents,
  shoot: Shoot,
): Promise<void> => {
  const menu = async (
    node: string,
    state: string,
    selector: string,
    text?: string,
  ) => {
    await rightClick(contents, selector, text);
    await waitForSelector(contents, MENU);
    await shoot(node, state, true, false);
  };

  // menu-thread (A1): "Plan the checkout flow"'s row.
  await menu(
    'menu-thread',
    'Project / Checkout redesign · Thread row menu',
    SIDEBAR_ROWS,
    PLAN.name,
  );
  await closeMenu(contents);

  // menu-project-tab, menu-project-color (A3): the Project tab's menu, then
  // its Color submenu opened by hovering its trigger; the pointer stays on the
  // trigger, so the submenu stays open.
  await menu(
    'menu-project-tab',
    'Project / Checkout redesign · Project tab menu',
    `[aria-label="Workspace tabs"] button[aria-label=${JSON.stringify(CHECKOUT.name)}]`,
  );
  await hover(contents, '[data-slot="context-menu-sub-trigger"]');
  await waitForSelector(contents, SUB_MENU);
  await shoot(
    'menu-project-color',
    'Project / Checkout redesign · Project tab menu · Color',
    true,
    false,
    false,
  );
  await closeMenu(contents);

  // menu-file-row, menu-folder-row (A8–A10): a file's and a folder's rows.
  await menu(
    'menu-file-row',
    'Project / Checkout redesign · File row menu',
    treeRow('payment-form.tsx'),
  );
  await closeMenu(contents);
  await menu(
    'menu-folder-row',
    'Project / Checkout redesign · Folder row menu',
    treeRow('checkout'),
  );

  // new-file-row, new-file-exists (A9): New file's name row in the folder,
  // then a taken name answered `exists`: the text under the row.
  await clickOn(contents, MENU_ITEM, 'New file');
  await waitForSelector(contents, NAME_ROW);
  await gone(contents, MENU, 'the context menu to close');
  await shoot(
    'new-file-row',
    'Project / Checkout redesign · New file name row',
    true,
    false,
  );
  await type(contents, TAKEN_NAME);
  press(contents, 'Enter');
  await showing(
    contents,
    '[role="alert"]',
    `${TAKEN_NAME} already exists.`,
    'the name row to say the name is taken',
  );
  await shoot(
    'new-file-exists',
    'Project / Checkout redesign · New file name taken',
    true,
    false,
  );
  press(contents, 'Escape');
  await gone(contents, NAME_ROW, 'the name row to close');

  // menu-file-tab (A5): payment-form.tsx opened, its tab's menu.
  await clickOn(contents, treeRow('payment-form.tsx'));
  await waitForSelector(contents, FILE_VIEW_FOOTER);
  await menu(
    'menu-file-tab',
    'Project / Checkout redesign · File tab menu',
    VIEWER_TAB,
  );
  await closeMenu(contents);
  await closeViewer(contents);

  // menu-change-row, menu-repository-row (A11, A12): the Changes rows.
  await clickOn(contents, CHANGES_TAB);
  await waitForSelector(contents, REPOSITORY_ROW);
  await waitForSelector(contents, treeRow('payment-form.tsx'));
  await menu(
    'menu-change-row',
    'Project / Checkout redesign · Changed file row menu',
    treeRow('payment-form.tsx'),
  );
  await closeMenu(contents);
  await menu(
    'menu-repository-row',
    'Project / Checkout redesign · Repository row menu',
    REPOSITORY_ROW,
  );
  await closeMenu(contents);

  // discard-dialog, discard-refused (A11): Discard changes asks, Discard
  // answers the host's refusal under the header and the dialog stays.
  await rightClick(contents, treeRow('payment-form.tsx'));
  await waitForSelector(contents, MENU);
  await clickOn(contents, MENU_ITEM, 'Discard changes');
  await waitForSelector(contents, DIALOG);
  await gone(contents, MENU, 'the context menu to close');
  await shoot(
    'discard-dialog',
    'Project / Checkout redesign · Discard changes dialog',
    true,
    false,
  );
  await clickOn(
    contents,
    `${DIALOG} [data-slot="alert-dialog-action"]`,
    'Discard',
  );
  await showing(
    contents,
    `${DIALOG} [role="alert"]`,
    'has a merge conflict',
    'the dialog to show the refusal',
  );
  await shoot(
    'discard-refused',
    'Project / Checkout redesign · Discard refused',
    true,
    false,
  );
  await clickOn(contents, `${DIALOG} [data-slot="alert-dialog-cancel"]`);
  await gone(contents, DIALOG, 'the dialog to close');

  // menu-diff-tab (A6): the changed file's diff, its tab's menu.
  await clickOn(contents, treeRow('payment-form.tsx'));
  await waitForSelector(contents, '[data-slot="diff-toolbar"]');
  await menu(
    'menu-diff-tab',
    'Project / Checkout redesign · Diff tab menu',
    VIEWER_TAB,
  );
  await closeMenu(contents);
  await closeViewer(contents);
  await clickOn(contents, FILES_TAB);
  await waitForSelector(contents, treeRow('payment-form.tsx'));
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

    return [
      shot.png,
      shot.json,
      ...(await captureAppearance({ booted, window, dir, theme })),
    ];
  } finally {
    await new Promise<void>((done) => {
      window.once('closed', () => done());
      window.close();
    });
  }
};

/** The Appearance section's tiles, in the order of `65:13666`. */
const APPEARANCE_TILES = [
  ['dark', 'Dark (default)'],
  ['light', 'Light'],
  ['system', 'System'],
] as const;

/**
 * Opens the settings window's Appearance section and captures it with each
 * tile selected (`settings-appearance-<tile>`, `65:13465`, `65:13565`,
 * `65:13665`). `DORIC_THEME` holds the window in the capture's theme while a
 * choice is saved, as a development run does (§4.1), so "Light selected" is
 * drawn in a dark window as Figma draws it; the variable is restored after.
 */
const captureAppearance = async (input: {
  readonly booted: Booted;
  readonly window: BrowserWindow;
  readonly dir: string;
  readonly theme: 'dark' | 'light';
}): Promise<string[]> => {
  const { booted, window, dir, theme } = input;
  const settings = window.webContents;
  const previous = process.env.DORIC_THEME;
  const written: string[] = [];

  process.env.DORIC_THEME = theme;

  try {
    await clickOn(
      settings,
      '[data-slot="sidebar"] :is(a, button, [role="link"])',
      'Appearance',
    );
    await until(
      async () =>
        (await page<string>(settings, 'location.pathname')) ===
        '/settings/appearance'
          ? true
          : undefined,
      'the Appearance section',
    );

    for (const [tile, title] of APPEARANCE_TILES) {
      await clickOn(settings, '[role="radiogroup"] [role="radio"]', title);
      await until(
        () =>
          inPage<boolean>(
            settings,
            `deepAll('[role="radio"][aria-checked="true"]').some((e) => e.dataset.theme === ${JSON.stringify(tile)})`,
          ).then((selected) => (selected ? true : undefined)),
        `the ${title} tile to be selected`,
      );
      await restPointer(settings);
      await painted(settings, 300);

      const shot = await captureState({
        booted,
        window,
        key: 'settings',
        dir,
        node: `settings-appearance-${tile}`,
        state: `Settings window · Appearance · ${title} selected`,
        theme,
      });

      written.push(shot.png, shot.json);
    }
  } finally {
    if (previous === undefined) {
      delete process.env.DORIC_THEME;
    } else {
      process.env.DORIC_THEME = previous;
    }
  }

  return written;
};
