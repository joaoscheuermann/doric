// What the shell tests do in a real app window, as a reader would: find
// elements by role and name (through open shadow roots), click and press
// keys with real input events, and read what the page draws.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserWindow, WebContents } from 'electron';

import { type Booted, page, until } from './harness';

/** Page-side helpers: queries that pierce open shadow roots. */
const DEEP = `
  const deepAll = (selector, root = document) => {
    const found = [...root.querySelectorAll(selector)];
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) found.push(...deepAll(selector, element.shadowRoot));
    }
    return found;
  };
  const deepActive = () => {
    let active = document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  };
  const nameOf = (element) =>
    element.getAttribute('aria-label') ?? element.textContent.trim();
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
`;

/** Runs `body` (an expression using the DEEP helpers) in the page. */
export const inPage = <T>(contents: WebContents, body: string): Promise<T> =>
  page<T>(contents, `(() => { ${DEEP} return (${body}); })()`);

/**
 * A button (or `role`) named `name`; `within` is a selector of an ancestor
 * that tells apart two controls of the same name.
 */
const selectorOf = (name: string, role = 'button', within = ''): string =>
  (role === 'button'
    ? [
        `button[aria-label=${JSON.stringify(name)}]`,
        `[role="button"][aria-label=${JSON.stringify(name)}]`,
      ]
    : [`[role=${JSON.stringify(role)}][aria-label=${JSON.stringify(name)}]`]
  )
    .map((selector) => (within === '' ? selector : `${within} ${selector}`))
    .join(', ');

/** Waits until a visible button (or `role`) named `name` is drawn. */
export const waitFor = (
  contents: WebContents,
  name: string,
  role = 'button',
  timeoutMs = 20_000,
  within = '',
): Promise<true> =>
  until(
    () =>
      inPage<boolean>(
        contents,
        `deepAll(${JSON.stringify(selectorOf(name, role, within))}).some(visible)`,
      ).then((found) => (found ? true : undefined)),
    `a ${role} named "${name}"`,
    timeoutMs,
  );

/**
 * Clicks the visible button named `name` with real mouse input, at the first
 * point of a 5×5 grid over it (centre first) where the element itself is hit:
 * another element may overlap part of it (the badge over the avatar).
 */
export const click = async (
  contents: WebContents,
  name: string,
  role = 'button',
  within = '',
): Promise<void> => {
  await waitFor(contents, name, role, 20_000, within);
  await clickOn(contents, selectorOf(name, role, within));
};

/** Waits until a visible element matches `selector`. */
export const waitForSelector = (
  contents: WebContents,
  selector: string,
  timeoutMs = 20_000,
): Promise<true> =>
  until(
    () =>
      inPage<boolean>(
        contents,
        `deepAll(${JSON.stringify(selector)}).some(visible)`,
      ).then((found) => (found ? true : undefined)),
    `an element matching ${selector}`,
    timeoutMs,
  );

/**
 * Waits for the first visible element matching `selector` (and whose text
 * starts with `text`, when given) and answers a point of it the pointer hits:
 * the first of a 5×5 grid over it (centre first) where the element itself is
 * hit, else its centre.
 */
const pointOn = async (
  contents: WebContents,
  selector: string,
  text?: string,
): Promise<{ x: number; y: number }> => {
  const find = `deepAll(${JSON.stringify(selector)}).filter(visible).find((e) => ${
    text === undefined
      ? 'true'
      : `(e.innerText ?? e.textContent).trim().startsWith(${JSON.stringify(text)})`
  })`;

  await until(
    () =>
      inPage<boolean>(contents, `Boolean(${find})`).then((found) =>
        found ? true : undefined,
      ),
    `an element matching ${selector}${text === undefined ? '' : ` reading "${text}"`}`,
  );

  const centre = await inPage<{ x: number; y: number }>(
    contents,
    `(() => {
      const element = ${find};
      const rect = element.getBoundingClientRect();
      const hit = (x, y) => {
        let found = document.elementFromPoint(x, y);
        while (found && found.shadowRoot) {
          const inner = found.shadowRoot.elementFromPoint(x, y);
          if (!inner || inner === found) break;
          found = inner;
        }
        return found;
      };
      const steps = [0.5, 0.2, 0.8, 0.35, 0.65];
      for (const fy of steps) {
        for (const fx of steps) {
          const x = Math.round(rect.x + rect.width * fx);
          const y = Math.round(rect.y + rect.height * fy);
          const at = hit(x, y);
          if (at && (at === element || element.contains(at))) return { x, y };
        }
      }
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`,
  );

  return centre;
};

/** Presses and releases `button` at `point` with real mouse input. */
const pressButton = (
  contents: WebContents,
  point: { x: number; y: number },
  button: 'left' | 'right',
): void => {
  contents.focus();
  contents.sendInputEvent({ type: 'mouseMove', ...point });
  contents.sendInputEvent({
    type: 'mouseDown',
    ...point,
    button,
    clickCount: 1,
  });
  contents.sendInputEvent({ type: 'mouseUp', ...point, button, clickCount: 1 });
};

/**
 * Clicks the first visible element matching `selector` (and whose text
 * starts with `text`, when given) with real mouse input.
 */
export const clickOn = async (
  contents: WebContents,
  selector: string,
  text?: string,
): Promise<void> => {
  pressButton(contents, await pointOn(contents, selector, text), 'left');
};

/**
 * Right-clicks the first visible element matching `selector` (and whose text
 * starts with `text`, when given) with real mouse input, as a reader opens
 * its context menu (§4.4).
 */
export const rightClick = async (
  contents: WebContents,
  selector: string,
  text?: string,
): Promise<void> => {
  pressButton(contents, await pointOn(contents, selector, text), 'right');
};

/**
 * Moves the pointer onto the first visible element matching `selector` (and
 * whose text starts with `text`, when given), as a reader hovers a submenu's
 * trigger.
 */
export const hover = async (
  contents: WebContents,
  selector: string,
  text?: string,
): Promise<void> => {
  const point = await pointOn(contents, selector, text);

  contents.focus();
  contents.sendInputEvent({ type: 'mouseMove', ...point });
};

/**
 * Drags the rightmost visible element matching `selector` by `dx` pixels
 * with real mouse input, in steps, as a reader drags a resize handle.
 */
export const dragBy = async (
  contents: WebContents,
  selector: string,
  dx: number,
): Promise<void> => {
  await waitForSelector(contents, selector);

  const from = await inPage<{ x: number; y: number }>(
    contents,
    `(() => {
      const rects = deepAll(${JSON.stringify(selector)}).filter(visible).map((e) => e.getBoundingClientRect());
      const rect = rects.reduce((a, b) => (b.x > a.x ? b : a));
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`,
  );
  const steps = 12;

  contents.focus();
  contents.sendInputEvent({ type: 'mouseMove', ...from });
  contents.sendInputEvent({
    type: 'mouseDown',
    ...from,
    button: 'left',
    clickCount: 1,
  });

  for (let step = 1; step <= steps; step += 1) {
    await new Promise((done) => setTimeout(done, 16));
    contents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(from.x + (dx * step) / steps),
      y: from.y,
      modifiers: ['leftbuttondown'],
    });
  }

  contents.sendInputEvent({
    type: 'mouseUp',
    x: from.x + dx,
    y: from.y,
    button: 'left',
    clickCount: 1,
  });
};

/** Types `text` into the focused element, as an input method inserts it. */
export const type = async (
  contents: WebContents,
  text: string,
): Promise<void> => {
  contents.focus();
  await contents.insertText(text);
};

/** The visible text of every visible element matching `selector`. */
export const textsOf = (
  contents: WebContents,
  selector: string,
): Promise<string[]> =>
  inPage(
    contents,
    `deepAll(${JSON.stringify(selector)}).filter(visible).map((e) => e.innerText ?? e.textContent)`,
  );

/** Presses one key with real keyboard input. */
export const press = (
  contents: WebContents,
  keyCode: string,
  modifiers: ('shift' | 'control' | 'alt' | 'meta')[] = [],
): void => {
  contents.focus();
  contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
};

/** The focused element's tag and accessible name. */
export const focused = (
  contents: WebContents,
): Promise<{ tag: string; name: string } | null> =>
  inPage(
    contents,
    `(() => { const a = deepActive(); return a && a !== document.body ? { tag: a.tagName.toLowerCase(), name: nameOf(a) } : null; })()`,
  );

/** Moves to `path` as the browser's history would (back and forward do). */
export const go = (contents: WebContents, path: string): Promise<void> =>
  page<void>(
    contents,
    `history.pushState(null, '', ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent('popstate'));`,
  );

/** Resolves after the page drew two frames and the given settle time. */
export const painted = async (
  contents: WebContents,
  settleMs = 300,
): Promise<void> => {
  await page(
    contents,
    'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))',
  );
  await new Promise((done) => setTimeout(done, settleMs));
};

/** The boxes of the §1:1 rows: a name and the selector of the element. */
export const BOXES: readonly (readonly [string, string])[] = [
  ['sidebar header', '[data-slot="workspace-sidebar-header"]'],
  // 4.2: Back/Forward in the sidebar header (`349:95622`, `256:20933`).
  [
    'history group',
    '[data-slot="workspace-sidebar-header"] [data-slot="button-group"]',
  ],
  [
    'back button',
    '[data-slot="workspace-sidebar-header"] button[aria-label="Back"]',
  ],
  [
    'forward button',
    '[data-slot="workspace-sidebar-header"] button[aria-label="Forward"]',
  ],
  // 4.3: the Project sidebar's "Search Threads" field, New Thread and the
  // tree's first row (`I269:31402;331:42177`, `269:31402`), and the Dashboard
  // header's Search button (`85:7520`, plan-4 G3).
  [
    'thread search',
    '[data-slot="input-group"]:has(input[aria-label="Search Threads"])',
  ],
  ['thread search input', 'input[aria-label="Search Threads"]'],
  [
    'thread search kbd',
    '[data-slot="input-group"]:has(input[aria-label="Search Threads"]) [data-slot="kbd"]',
  ],
  [
    'new thread row',
    '[data-slot="sidebar-menu-button"]:has(> svg.lucide-plus)',
  ],
  [
    'first thread row',
    '[role="treeitem"][data-slot="sidebar-menu-sub-button"]',
  ],
  ['threads empty', '[data-threads-empty]'],
  [
    'header search button',
    '[data-slot="workspace-sidebar-header"] button[aria-label="Search"]',
  ],
  ['sidebar column', '[data-slot="workspace-sidebar-header"] + *'],
  ['sidebar menu', '[data-slot="sidebar-menu"]'],
  ['sidebar menu button', '[data-slot="sidebar-menu-button"]'],
  ['tab bar', '[aria-label="Workspace tabs"]'],
  ['project tab actions', '[data-slot="project-tab-actions"]'],
  ['thread conversation card', '[aria-label="Thread conversation"]'],
  ['dashboard content', '[data-slot="dashboard-content"]'],
  ['dashboard card', '[data-slot="dashboard-card"]'],
  ['dashboard navigation', '[aria-label="Dashboard navigation"]'],
  ['viewer card', 'section[aria-label="Viewer"]'],
  ['viewer header', '[data-slot="workspace-viewer-header"]'],
  ['files header', '[data-slot="workspace-files-header"]'],
  ['files footer', '[data-slot="workspace-files-footer"]'],
  ['workspace footer', '[data-slot="workspace-footer"]'],
  ['workspace layout', '[data-slot="workspace-layout"]'],
  ['account status', '[data-slot="account-status"]'],
  ['account avatar', 'button[aria-label="Account"]'],
  ['connection badge', '[data-slot="connection-badge"]'],
  // Phase 3: the bundles' own surfaces (chat, usage, settings, files, git).
  [
    'conversation column',
    '[aria-label="Thread conversation"] .conversation-scroll .max-w-3xl',
  ],
  [
    'first turn',
    '[aria-label="Thread conversation"] [data-lexical-editor] > [data-turn-avatar]',
  ],
  [
    'agent turn',
    '[aria-label="Thread conversation"] [data-lexical-editor] > [data-turn-avatar="agent"]',
  ],
  [
    'execution picker',
    '[data-slot="workspace-footer"] :has(> [aria-label="Execution model"])',
  ],
  [
    'execution model',
    '[data-slot="workspace-footer"] [aria-label="Execution model"]',
  ],
  [
    'reasoning effort',
    '[data-slot="workspace-footer"] [aria-label="Reasoning effort"]',
  ],
  [
    'thread usage',
    '[data-slot="workspace-footer"] :has(> [aria-label="Context window usage"])',
  ],
  [
    'composer button',
    '[data-slot="workspace-footer"] button:is([aria-label^="Send"], [aria-label^="Stop"])',
  ],
  ['usage popover', '[data-slot="popover-content"]'],
  ['chat thread footer', '[data-slot="chat-thread-footer"]'],
  ['chat thread footer items', '[data-slot="chat-thread-footer"] > *'],
  [
    'viewer composer button',
    '[data-slot="chat-thread-footer"] button:is([aria-label^="Send"], [aria-label^="Stop"])',
  ],
  [
    'viewer conversation column',
    'section[aria-label="Viewer"] .conversation-scroll .max-w-3xl',
  ],
  ['files tree', '[role="tree"]'],
  [
    'files selected row',
    '[role="tree"] [role="treeitem"][aria-selected="true"]',
  ],
  [
    'files selected badge',
    ':has(> [role="treeitem"][aria-selected="true"]) > [data-slot="sidebar-menu-badge"] > *',
  ],
  ['changes repository row', '[role="treeitem"][aria-label*="lines added"]'],
  ['file view footer', 'section[aria-label="Viewer"] footer:not([data-slot])'],
  ['diff toolbar', '[data-slot="diff-toolbar"]'],
  ['diff footer', '[data-slot="diff-footer"]'],
  ['terminal header', '[data-slot="terminal-view"] > :first-child'],
  ['settings title bar', '[data-slot="settings-title-bar"]'],
  [
    'settings nav',
    ':has(> [data-slot="settings-title-bar"]) [data-slot="sidebar"]',
  ],
  ['settings card', ':has(> [data-slot="settings-title-bar"]) main'],
  ['settings footer', ':has(> [data-slot="settings-title-bar"]) main footer'],
  [
    'settings table header',
    ':has(> [data-slot="settings-title-bar"]) main thead tr',
  ],
  [
    'settings table row',
    ':has(> [data-slot="settings-title-bar"]) main tbody tr',
  ],
  // Phase 4.1: the Appearance section (`65:13666`), its selected tile's parts
  // (`65:13362`) and its preview (`65:13174`).
  [
    'appearance heading',
    ':has(> [data-slot="settings-title-bar"]) main header:has(> h1)',
  ],
  ['appearance field label', '#appearance-theme'],
  ['appearance tile', '[role="radio"][aria-checked="true"]'],
  [
    'appearance preview frame',
    '[role="radio"][aria-checked="true"] [data-slot="theme-preview-frame"]',
  ],
  [
    'appearance choice card',
    '[role="radio"][aria-checked="true"] [data-slot="theme-choice-card"]',
  ],
  [
    'appearance check',
    '[role="radio"][aria-checked="true"] [data-slot="theme-check"]',
  ],
  ['appearance description', '[data-slot="theme-description"]'],
  // Phase 4.4: the open context menu (`ContextMenu/Content` `18:645`), an
  // item (`ContextMenu/Item` `16:339`), a destructive item (`16:363`), the
  // separator, an item's icon, the Color submenu; the files name row and the
  // Discard dialog.
  ['context menu', '[data-slot="context-menu-content"]'],
  [
    'context menu item',
    '[data-slot="context-menu-content"] [data-slot="context-menu-item"][data-variant="default"]',
  ],
  [
    'context menu destructive item',
    '[data-slot="context-menu-content"] [data-slot="context-menu-item"][data-variant="destructive"]',
  ],
  [
    'context menu separator',
    '[data-slot="context-menu-content"] [data-slot="context-menu-separator"]',
  ],
  [
    'context menu item icon',
    '[data-slot="context-menu-content"] [data-slot="context-menu-item"] > svg',
  ],
  ['context menu sub trigger', '[data-slot="context-menu-sub-trigger"]'],
  ['context menu sub content', '[data-slot="context-menu-sub-content"]'],
  [
    'context menu radio item',
    '[data-slot="context-menu-sub-content"] [data-slot="context-menu-radio-item"]',
  ],
  [
    'name row input',
    'input:is([aria-label="New file name"], [aria-label="New folder name"])',
  ],
  [
    'name row message',
    ':has(> div > input[aria-invalid="true"]) > p[role="alert"]',
  ],
  ['discard dialog', '[data-slot="alert-dialog-content"]'],
  ['discard dialog title', '[data-slot="alert-dialog-title"]'],
  [
    'discard dialog message',
    '[data-slot="alert-dialog-content"] p[role="alert"]',
  ],
  [
    'discard dialog action',
    '[data-slot="alert-dialog-content"] [data-slot="alert-dialog-action"]',
  ],
];

const PROPERTIES = [
  'display',
  'position',
  'background-color',
  'color',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-radius',
  'box-shadow',
  'padding',
  'margin',
  'gap',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'opacity',
];

/** `getComputedStyle` values and the box of the first visible match of each row. */
export const computedBoxes = (
  contents: WebContents,
  boxes: readonly (readonly [string, string])[] = BOXES,
): Promise<Record<string, unknown>> =>
  inPage(
    contents,
    `Object.fromEntries(${JSON.stringify(boxes)}.map(([name, selector]) => {
      const element = deepAll(selector).find(visible);
      if (!element) return [name, null];
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return [name, {
        selector,
        data: { ...element.dataset },
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        style: Object.fromEntries(${JSON.stringify(PROPERTIES)}.map((p) => [p, style.getPropertyValue(p)])),
      }];
    }))`,
  );

/**
 * Captures the whole content of the window of `key` (`workspace` unless
 * given; `window` is that window) to `<dir>/<node>-<theme>.png`, and the
 * computed boxes to `<node>-<theme>.json`.
 */
export const captureState = async (input: {
  readonly booted: Booted;
  readonly window: BrowserWindow;
  readonly key?: string;
  readonly dir: string;
  readonly node: string;
  readonly state: string;
  readonly theme: 'dark' | 'light';
}): Promise<{ png: string; json: string }> => {
  const contents = input.window.webContents;

  await painted(contents);

  const [width = 0, height = 0] = input.window.getContentSize();
  const take = () =>
    input.booted.platform.windows.capture({
      key: input.key ?? 'workspace',
      rect: { x: 0, y: 0, width, height },
    });
  // Xvfb's software GPU process can die mid-copy (`UnknownVizError`); it
  // restarts, and the next capture of the same page succeeds.
  const shot = await take().catch(async () => {
    await new Promise((done) => setTimeout(done, 1_000));
    await painted(contents);

    return take();
  });
  const base = join(
    input.dir,
    `${input.node.replace(':', '-')}-${input.theme}`,
  );

  await mkdir(input.dir, { recursive: true });
  await writeFile(`${base}.png`, Buffer.from(shot.png, 'base64'));
  await writeFile(
    `${base}.json`,
    `${JSON.stringify(
      {
        node: input.node,
        state: input.state,
        theme: input.theme,
        window: input.key ?? 'workspace',
        content: { width, height },
        capture: { width: shot.width, height: shot.height, scale: shot.scale },
        path: await page<string>(contents, 'location.pathname'),
        boxes: await computedBoxes(contents),
      },
      null,
      2,
    )}\n`,
  );

  return { png: `${base}.png`, json: `${base}.json` };
};

/** The splash check's rows (§4.5 1:1): a name and the selector of the element. */
export const SPLASH_BOXES: readonly (readonly [string, string])[] = [
  ['splash art pane', '[data-art-pane]'],
  ['splash art', '[data-art-pane] > [data-art]'],
  ['splash info pane', '[data-info-pane]'],
  ['splash wordmark', 'svg[aria-label="Doric"]'],
  ['splash footer', '.splash-footer'],
  ['splash status', '.splash-status'],
  ['splash status icon', '.splash-status > svg'],
  ['splash status text', '.splash-status > span'],
  ['splash details', '.splash-details'],
  ['splash actions', '.splash-actions'],
  ['splash primary action', '.splash-actions button[data-variant="primary"]'],
  [
    'splash secondary action',
    '.splash-actions button[data-variant="secondary"]',
  ],
  ['splash divider', '.splash-divider'],
  ['splash credits', '.splash-credits'],
  ['splash author', '.splash-credits > :first-child'],
  ['splash license', '.splash-credits > :last-child'],
  ['splash link', 'a.splash-link'],
  ['splash link icon', 'a.splash-link > svg'],
];

/**
 * Captures the splash window's page to `<dir>/splash-<name>-<theme>.png` and
 * the splash rows' computed boxes to `.json` (`webContents.capturePage()`:
 * the splash is a technical window `doric.windows/v1` does not know).
 */
export const captureSplash = async (input: {
  readonly booted: Booted;
  readonly dir: string;
  readonly name: string;
  readonly theme: 'dark' | 'light';
}): Promise<{ png: string; json: string }> => {
  const window = input.booted.platform.splashWindow;

  if (window === undefined) {
    throw new Error('The splash is not open.');
  }

  const contents = window.webContents;

  await painted(contents);

  const take = () => contents.capturePage();
  // Xvfb's software GPU process can die mid-copy; the next capture succeeds.
  const image = await take().catch(async () => {
    await new Promise((done) => setTimeout(done, 1_000));
    await painted(contents);

    return take();
  });
  const [width = 0, height = 0] = window.getContentSize();
  const base = join(input.dir, `splash-${input.name}-${input.theme}`);

  await mkdir(input.dir, { recursive: true });
  await writeFile(`${base}.png`, image.toPNG());
  await writeFile(
    `${base}.json`,
    `${JSON.stringify(
      {
        node: 'splash',
        state: input.name,
        theme: input.theme,
        window: 'splash',
        content: { width, height },
        capture: image.getSize(),
        path: await page<string>(
          contents,
          'location.pathname + location.search',
        ),
        boxes: await computedBoxes(contents, SPLASH_BOXES),
      },
      null,
      2,
    )}\n`,
  );

  return { png: `${base}.png`, json: `${base}.json` };
};
