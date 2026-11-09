// The §2.9 shell check's states, reached as a reader would in the real shell
// over the workspace bundles and captured at the window's size in one theme:
// `99:8035` (Project view, Thread open), `99:8508` (a sub-thread in the
// viewer), S27 (Files collapsed, viewer open), `85:7726` (the new tab's Recent
// Dashboard) and `85:7520` (the Dashboard of every Project).

import type { BrowserWindow, WebContents } from 'electron';

import { type Booted, page, until } from './harness';
import {
  captureState,
  click,
  clickOn,
  go,
  inPage,
  painted,
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
 * conversation, else the Dashboard's content) and takes focus off the control
 * the last click focused, so neither a hover fill nor a focus state is
 * captured.
 */
const restPointer = async (contents: WebContents): Promise<void> => {
  const spot = await inPage<{ x: number; y: number }>(
    contents,
    `(() => {
      const card = ['[aria-label="Thread conversation"]', '[data-slot="dashboard-content"]']
        .map((selector) => deepAll(selector).find(visible))
        .find(Boolean);
      const rect = card ? card.getBoundingClientRect() : { x: 0, y: 0, width: innerWidth, height: innerHeight };
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height * 0.8) };
    })()`,
  );

  contents.sendInputEvent({ type: 'mouseMove', ...spot });
  await inPage(contents, 'deepActive()?.blur?.()');
};

/**
 * Runs `step` with the page's `Date.now` held at `FROZEN_NOW`, so the running
 * Thread's elapsed badge reads the prototype's 02:00 on every run. The badge
 * reads the clock once a second: the hold lasts past one reading.
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
  const shoot = async (node: string, state: string, frozen = false) => {
    await restPointer(contents);
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
  await shoot('99:8035', 'Project / Checkout redesign · Thread', true);

  // 99:8508: the running sub-thread opened from the sidebar, in the viewer.
  await clickOn(
    contents,
    '[data-slot="sidebar-menu-button"], [data-slot="sidebar-menu-sub-button"]',
    PAYMENT_FORM.name,
  );
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
  await clickOn(contents, `${SUB_THREAD_TAB} [data-slot="tab-close"]`);
  await gone(contents, SUB_THREAD_TAB, 'the sub-thread tab to close');

  // 85:7726: the new tab's Recent Dashboard, from the Project view's "+".
  await click(
    contents,
    'New project',
    'button',
    '[aria-label="Workspace tabs"]',
  );
  await at('/');
  await shoot('85:7726', 'Home / Dashboard · Recent (new tab)');

  // 85:7520: the Dashboard of every Project, from the sidebar header.
  await go(contents, THREAD_PATH);
  await click(contents, 'Dashboard');
  await at('/projects');
  await shoot('85:7520', 'Home / Dashboard · All projects');

  return written;
};
