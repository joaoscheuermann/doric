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

  const centre = await inPage<{ x: number; y: number }>(
    contents,
    `(() => {
      const element = deepAll(${JSON.stringify(selectorOf(name, role, within))}).find(visible);
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

  contents.focus();
  contents.sendInputEvent({ type: 'mouseMove', ...centre });
  contents.sendInputEvent({
    type: 'mouseDown',
    ...centre,
    button: 'left',
    clickCount: 1,
  });
  contents.sendInputEvent({
    type: 'mouseUp',
    ...centre,
    button: 'left',
    clickCount: 1,
  });
};

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
  ['sidebar column', '[data-slot="workspace-sidebar-header"] + *'],
  ['sidebar menu', '[data-slot="sidebar-menu"]'],
  ['sidebar menu button', '[data-slot="sidebar-menu-button"]'],
  ['tab bar', '[aria-label="Workspace tabs"]'],
  ['project tab actions', '[data-slot="project-tab-actions"]'],
  ['thread conversation card', '[aria-label="Thread conversation"]'],
  ['dashboard card', '[data-slot="dashboard-content"]'],
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
): Promise<Record<string, unknown>> =>
  inPage(
    contents,
    `Object.fromEntries(${JSON.stringify(BOXES)}.map(([name, selector]) => {
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
 * Captures the whole 1920×1080 content of the `workspace` window to
 * `<dir>/<node>-<theme>.png`, and the computed boxes to `<node>-<theme>.json`.
 */
export const captureState = async (input: {
  readonly booted: Booted;
  readonly window: BrowserWindow;
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
      key: 'workspace',
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
