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
  dragBy,
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
const HANDLE = '[data-slot="resizable-handle"]';
const FILES_HEADER = '[data-slot="workspace-files-header"]';
const SUB_THREAD_TAB = `[data-tab-id="thread:${VALIDATE_CARDS.id}"]`;

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
  const shoot = async (node: string, state: string) => {
    const shot = await captureState({
      booted,
      window,
      dir,
      node,
      state,
      theme,
    });

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
  await shoot('99:8035', 'Project / Checkout redesign · Thread');

  // 99:8508: the sub-thread opened from the sidebar, in the viewer.
  await clickOn(
    contents,
    '[data-slot="sidebar-menu-button"], [data-slot="sidebar-menu-sub-button"]',
    VALIDATE_CARDS.name,
  );
  await explained(
    showing(contents, VIEWER, ANSWER_START, 'the sub-thread in the viewer'),
  );
  await shoot('99:8508', 'Project / Checkout redesign · Sub-thread in viewer');

  // S27: the Files column collapsed while the viewer stays open. Its
  // handle collapses it: the Files toggle the layout draws in the column's
  // header renders nothing (see the 2f-2 report).
  await dragBy(contents, HANDLE, 400);
  await explained(gone(contents, FILES_HEADER, 'the Files column to collapse'));
  await painted(contents, 300);
  await shoot(
    'S27',
    'Project / Checkout redesign · Files collapsed, viewer open',
  );
  await dragBy(contents, HANDLE, -328);
  await explained(waitForSelector(contents, FILES_HEADER));
  await clickOn(contents, `${SUB_THREAD_TAB} [data-slot="tab-close"]`);
  await gone(contents, SUB_THREAD_TAB, 'the sub-thread tab to close');

  // 85:7726: the new tab's Recent Dashboard, from the Project view's "+".
  await click(contents, 'New project', 'button', '[aria-label="Workspace tabs"]');
  await at('/');
  await shoot('85:7726', 'Home / Dashboard · Recent (new tab)');

  // 85:7520: the Dashboard of every Project, from the sidebar header.
  await go(contents, THREAD_PATH);
  await click(contents, 'Dashboard');
  await at('/projects');
  await shoot('85:7520', 'Home / Dashboard · All projects');

  return written;
};
