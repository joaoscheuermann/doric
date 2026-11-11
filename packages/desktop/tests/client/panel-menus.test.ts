/**
 * The row and tab menus of the panel widgets (§4.4 "primitives that land with
 * their first callers", T-4.4.8, T-4.4.12, T-4.4.16): `FileTree.rowMenu` and
 * `FileTree.pending`, `TabStrip.tabMenu`. A bundle states the menu; the
 * widget only makes the row or the tab its trigger.
 *
 * Contract matrix:
 * - a `contextmenu` event on a row opens the node `rowMenu` answered for it;
 *   a row answered `null`, and a tree without `rowMenu`, open none;
 * - `pending` on an open directory draws its row as the directory's first
 *   child, and in an empty directory instead of the empty notice;
 * - a `contextmenu` event on a tab opens the node `tabMenu` answered for it;
 * - without the props nothing is a context-menu trigger (the degrade path of
 *   S35: an older app's widgets draw none).
 *
 * The imports resolve through the package's export map, so this exercises
 * the files the windows load.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';

import type { ReactNode } from 'react';

import { type InstalledDom, installDom } from './support/dom.js';

/** Globals Base UI and React DOM reach for beyond `installDom`'s. */
const extraGlobals = [
  'HTMLInputElement',
  'HTMLButtonElement',
  'HTMLAnchorElement',
  'SVGElement',
  'ShadowRoot',
  'DocumentFragment',
  'NodeFilter',
  'CustomEvent',
  'FocusEvent',
  'KeyboardEvent',
  'PointerEvent',
  'MouseEvent',
  'ResizeObserver',
  'DOMRect',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const;

let dom: InstalledDom;
let panels: typeof import('desktop/ui/panels');
let menu: typeof import('desktop/ui/context-menu');
let sidebar: typeof import('desktop/ui/sidebar');
let tabs: typeof import('desktop/ui/tabs');
let createRoot: typeof import('react-dom/client').createRoot;
let createElement: typeof import('react').createElement;
let act: (callback: () => void | Promise<void>) => Promise<void>;

before(async () => {
  dom = installDom();
  const window = dom.window as unknown as Record<string, unknown>;
  for (const name of extraGlobals) {
    const value = window[name];
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value:
        typeof value === 'function' && !/^[A-Z]/.test(name)
          ? (value as (...args: unknown[]) => unknown).bind(dom.window)
          : value,
    });
  }
  // happy-dom runs no Web Animations; Base UI asks an element for the
  // animations in progress before it unmounts a popup, and there are none.
  const element = dom.window.Element.prototype as unknown as Record<
    string,
    unknown
  >;
  if (typeof element.getAnimations !== 'function')
    element.getAnimations = (): unknown[] => [];
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const react = await import('react');
  act = react.act as typeof act;
  createElement = react.createElement;
  ({ createRoot } = await import('react-dom/client'));
  [panels, menu, sidebar, tabs] = await Promise.all([
    import('desktop/ui/panels'),
    import('desktop/ui/context-menu'),
    import('desktop/ui/sidebar'),
    import('desktop/ui/tabs'),
  ]);
});

after(async () => {
  for (const name of extraGlobals)
    delete (globalThis as Record<string, unknown>)[name];
  await dom.close();
});

let unmount: (() => Promise<void>) | undefined;

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  document.body.replaceChildren();
});

/** Renders `node` into a fresh element of the document. */
const render = async (node: ReactNode): Promise<void> => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(() => root.render(node));
  unmount = async () => {
    await act(() => root.unmount());
    host.remove();
  };
};

/** Right-clicks `target`, as a reader opens a context menu. */
const contextMenu = async (target: Element): Promise<void> => {
  await act(async () => {
    target.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
      }),
    );
    await new Promise((done) => setTimeout(done, 20));
  });
};

const menuItems = (): string[] =>
  [...document.querySelectorAll('[role="menuitem"]')].map(
    (item) => item.textContent ?? '',
  );

const triggers = (): number =>
  document.querySelectorAll('[data-slot="context-menu-trigger"]').length;

const entries = [
  {
    name: 'src',
    path: 'src',
    type: 'directory',
    children: [{ name: 'main.ts', path: 'src/main.ts', type: 'file' }],
  },
  { name: 'empty', path: 'empty', type: 'directory', children: [] },
  { name: 'README.md', path: 'README.md', type: 'file' },
] as const;

const tree = (
  props: {
    readonly rowMenu?: (node: { readonly path: string }) => ReactNode | null;
    readonly pending?: { readonly directory: string; readonly row: ReactNode };
  } = {},
): ReactNode =>
  createElement(
    sidebar.SidebarProvider,
    null,
    createElement(panels.FileTree, {
      actions: { open: () => undefined, toggle: () => undefined },
      depth: 0,
      entries,
      expanded: new Set(['src', 'empty']),
      ...props,
    }),
  );

const row = (name: string): HTMLElement => {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="treeitem"]'),
  ].find((item) => item.getAttribute('aria-label') === name);
  assert.ok(found, `no row named ${name}`);
  return found;
};

/** A file row answers a menu; a directory row answers `null`. */
const filesOnly = (node: { readonly path: string }): ReactNode | null =>
  node.path.endsWith('.md') || node.path.endsWith('.ts')
    ? createElement(menu.ContextMenuItem, null, `Copy ${node.path}`)
    : null;

describe('FileTree rowMenu', () => {
  test('a contextmenu event on a row opens the menu rowMenu answered for it', async () => {
    await render(tree({ rowMenu: filesOnly }));

    await contextMenu(row('README.md'));

    assert.deepEqual(menuItems(), ['Copy README.md']);
  });

  test('a row nested in an open directory opens its own menu', async () => {
    await render(tree({ rowMenu: filesOnly }));

    await contextMenu(row('main.ts'));

    assert.deepEqual(menuItems(), ['Copy src/main.ts']);
  });

  test('a row whose rowMenu answers null opens no context menu', async () => {
    await render(tree({ rowMenu: filesOnly }));

    await contextMenu(row('src'));

    assert.deepEqual(menuItems(), []);
  });

  test('a tree without rowMenu opens no context menu and draws no trigger', async () => {
    await render(tree());

    await contextMenu(row('README.md'));

    assert.deepEqual(menuItems(), []);
    assert.equal(triggers(), 0);
  });
});

describe('FileTree pending', () => {
  const pendingRow = (): ReactNode =>
    createElement('input', { 'aria-label': 'New file name' });

  /**
   * The rows and items drawn inside the open directory `name`, in order: the
   * lines after its row, up to the next row at its level or above (the tree
   * draws its rows flat, each at its `aria-level`), one level deeper.
   */
  const childrenOf = (name: string): string[] => {
    const directory = row(name);
    assert.equal(directory.getAttribute('aria-expanded'), 'true');
    const level = Number(directory.getAttribute('aria-level'));
    const lines = [
      ...(directory.closest('li')?.parentElement?.children ?? []),
    ].filter((item) => item.getAttribute('aria-hidden') !== 'true');
    const start = lines.findIndex((item) => item.contains(directory));
    const children: string[] = [];
    for (const item of lines.slice(start + 1)) {
      const treeitem = item.querySelector('[role="treeitem"]');
      const itemLevel = Number(
        treeitem?.getAttribute('aria-level') ?? level + 1,
      );
      if (itemLevel <= level) break;
      if (itemLevel > level + 1) continue;
      children.push(
        item.querySelector('input')?.getAttribute('aria-label') ??
          treeitem?.getAttribute('aria-label') ??
          (item.textContent ?? '').trim(),
      );
    }
    return children;
  };

  test('draws the pending row as the open directory first child', async () => {
    await render(tree({ pending: { directory: 'src', row: pendingRow() } }));

    assert.deepEqual(childrenOf('src'), ['New file name', 'main.ts']);
  });

  test('replaces the empty-directory notice of an empty directory', async () => {
    await render(tree({ pending: { directory: 'empty', row: pendingRow() } }));

    assert.deepEqual(childrenOf('empty'), ['New file name']);
    assert.ok(!document.body.textContent?.includes('This directory is empty.'));
  });

  test('without pending an empty directory shows its notice', async () => {
    await render(tree());

    assert.deepEqual(childrenOf('empty'), ['This directory is empty.']);
  });
});

describe('TabStrip tabMenu', () => {
  const strip = (tabMenu?: (id: string) => ReactNode): ReactNode =>
    createElement(
      tabs.Tabs,
      { value: 'a' },
      createElement(panels.TabStrip, {
        variant: 'project',
        label: 'Viewer tabs',
        selected: 'a',
        onMove: () => undefined,
        onClose: () => undefined,
        items: [
          { id: 'a', label: 'main.ts', icon: null },
          { id: 'b', label: 'README.md', icon: null },
        ],
        ...(tabMenu === undefined ? {} : { tabMenu }),
      }),
    );

  const tab = (id: string): HTMLElement => {
    const found = document.querySelector<HTMLElement>(`[data-tab-id="${id}"]`);
    assert.ok(found, `no tab ${id}`);
    return found;
  };

  test('a contextmenu event on a tab opens the menu tabMenu answered for it', async () => {
    await render(
      strip((id) =>
        createElement(menu.ContextMenuItem, null, `Close tab ${id}`),
      ),
    );

    await contextMenu(tab('b'));

    assert.deepEqual(menuItems(), ['Close tab b']);
  });

  test('without tabMenu a tab opens no context menu and draws no trigger', async () => {
    await render(strip());

    await contextMenu(tab('b'));

    assert.deepEqual(menuItems(), []);
    assert.equal(triggers(), 0);
  });
});
