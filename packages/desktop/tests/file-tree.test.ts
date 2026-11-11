/**
 * `FileTree` draws only the rows its scroller shows: a tree with thousands of
 * rows under open directories stays a screenful of DOM, scrolling draws the
 * rows scrolled to, and the focused row stays mounted while scrolled away. It
 * keeps drawing what it drew before — the selected row, the pending row, the
 * empty-directory notice — and an open directory that is loading shows one
 * Loading line in place of its children.
 *
 * happy-dom has no layout, so the scroller is given a fixed viewport height
 * and the tree lays out from the top of the scroller's content.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';

import type { FileTreeActions, TreeNode } from 'desktop/ui/panels';
import { Window } from 'happy-dom';

const window = new Window({ width: 1024, height: 768 });
const installed = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Node',
  'Element',
  'Event',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const;

type Panels = typeof import('desktop/ui/panels');

let panels: Panels;
let SidebarProvider: typeof import('desktop/ui/sidebar').SidebarProvider;
let SidebarMenu: typeof import('desktop/ui/sidebar').SidebarMenu;
let createRoot: typeof import('react-dom/client').createRoot;
let act: (callback: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import('react').createElement;

before(async () => {
  for (const name of installed) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: (window as unknown as Record<string, unknown>)[name],
      writable: true,
    });
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const react = await import('react');
  act = react.act as typeof act;
  createElement = react.createElement;
  ({ createRoot } = await import('react-dom/client'));
  panels = await import('desktop/ui/panels');
  ({ SidebarProvider, SidebarMenu } = await import('desktop/ui/sidebar'));
});

after(async () => {
  await window.happyDOM.close();
});

/** A row is 28 px; the viewport shows ten of them. */
const viewportHeight = 280;

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0).reverse()) await unmount();
});

type TreeProps = {
  readonly entries: readonly TreeNode[];
  readonly expanded: ReadonlySet<string>;
  readonly actions?: FileTreeActions;
  readonly selectedPath?: string;
  readonly pending?: { readonly directory: string; readonly row: unknown };
  readonly loading?: ReadonlySet<string>;
};

const idle: FileTreeActions = {
  open: () => undefined,
  toggle: () => undefined,
};

/**
 * Mounts the tree in a vertical scroller, the way the Files panel does, and
 * lays the scroller's content out from its top: every element inside sits
 * `scrollTop` above the viewport's top edge.
 */
const mount = async (
  props: TreeProps,
  options: { readonly scrollsAfterMount?: boolean } = {},
) => {
  const scroller = document.createElement('div');
  // A scroll area may apply its overflow only after it has measured itself,
  // so the tree can mount inside a box that does not scroll yet.
  scroller.style.overflowY =
    options.scrollsAfterMount === true ? 'visible' : 'auto';
  let scrollTop = 0;
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, get: () => viewportHeight },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    },
  });
  const rect = (top: number) =>
    ({
      top,
      bottom: top,
      left: 0,
      right: 0,
      width: 0,
      height: 0,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  const original = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function (this: Node) {
    if ((this as unknown) === scroller) return rect(0);
    if (scroller.contains(this)) return rect(-scrollTop);
    return original.call(this as never);
  } as never;
  document.body.append(scroller);
  const root = createRoot(scroller as unknown as Element);
  const render = (next: TreeProps) =>
    act(() => {
      root.render(
        createElement(
          SidebarProvider,
          null,
          createElement(
            SidebarMenu,
            { role: 'tree' },
            createElement(panels.FileTree, {
              actions: next.actions ?? idle,
              depth: 0,
              entries: next.entries,
              expanded: next.expanded,
              ...(next.selectedPath === undefined
                ? {}
                : { selectedPath: next.selectedPath }),
              ...(next.pending === undefined
                ? {}
                : {
                    pending: next.pending as {
                      directory: string;
                      row: never;
                    },
                  }),
              ...(next.loading === undefined ? {} : { loading: next.loading }),
            }),
          ),
        ),
      );
    });
  await render(props);
  if (options.scrollsAfterMount === true) {
    scroller.style.overflowY = 'auto';
  }
  unmounts.push(async () => {
    await act(() => root.unmount());
    scroller.remove();
    window.HTMLElement.prototype.getBoundingClientRect = original;
  });
  return {
    scroller,
    render,
    scrollTo: (top: number) =>
      act(() => {
        scrollTop = top;
        scroller.dispatchEvent(new window.Event('scroll') as never);
      }),
    /** Scrolls the way the browser does: no act, nothing flushed after. */
    scrollNow: (top: number) => {
      scrollTop = top;
      scroller.dispatchEvent(new window.Event('scroll') as never);
    },
    labels: (): readonly string[] =>
      Array.from(scroller.querySelectorAll('[role="treeitem"]')).map(
        (row) => row.getAttribute('aria-label') ?? '',
      ),
    row: (label: string): HTMLElement | null =>
      scroller.querySelector(`[role="treeitem"][aria-label="${label}"]`),
  };
};

const file = (path: string): TreeNode => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  type: 'file',
});

/** One open directory, `src`, holding `count` files in order. */
const large = (count: number): readonly TreeNode[] => [
  {
    name: 'src',
    path: 'src',
    type: 'directory',
    children: Array.from({ length: count }, (_, index) =>
      file(`src/file-${String(index).padStart(5, '0')}.ts`),
    ),
  },
];

describe('a large open tree', () => {
  const entries = large(20_000);
  const expanded = new Set(['src']);

  test('draws a bounded number of rows, starting with the first', async () => {
    const tree = await mount({ entries, expanded });
    const labels = tree.labels();
    assert.ok(labels.length < 100, `drew ${labels.length} rows`);
    assert.equal(labels[0], 'src');
    assert.ok(labels.includes('file-00005.ts'));
    assert.ok(!labels.includes('file-19999.ts'));
  });

  test('draws the rows scrolled to, and no longer the first ones', async () => {
    const tree = await mount({ entries, expanded });
    await tree.scrollTo(28 * 10_000);
    const labels = tree.labels();
    assert.ok(labels.length < 100, `drew ${labels.length} rows`);
    assert.ok(labels.includes('file-10000.ts'), labels.join(', '));
    assert.ok(labels.includes('file-10005.ts'), labels.join(', '));
    assert.ok(!labels.includes('file-00000.ts'));

    await tree.scrollTo(28 * 19_995);
    assert.ok(tree.labels().includes('file-19999.ts'));
  });

  test('places each drawn row at its own position in the tree, scrolled or not', async () => {
    const tree = await mount({ entries, expanded });
    // The height above a drawn row: every line before it in the list, drawn
    // rows at 1.75rem and undrawn lines through the spacers that hold them.
    const above = (label: string): number => {
      let total = 0;
      for (const item of Array.from(tree.scroller.querySelectorAll('li'))) {
        if (item.querySelector(`[aria-label="${label}"]`) !== null) {
          return total;
        }
        total +=
          item.getAttribute('aria-hidden') === 'true'
            ? Number.parseFloat(item.style.height)
            : 1.75;
      }
      throw new Error(`${label} is not drawn`);
    };

    assert.equal(above('src'), 0);
    assert.equal(above('file-00004.ts'), 5 * 1.75);

    await tree.scrollTo(28 * 10_000);
    assert.equal(above('file-10000.ts'), 10_001 * 1.75);
  });

  test('follows a container that starts scrolling only after the tree mounted', async () => {
    const tree = await mount(
      { entries, expanded },
      { scrollsAfterMount: true },
    );
    await tree.scrollTo(28 * 10_000);
    assert.ok(
      tree.labels().includes('file-10000.ts'),
      tree.labels().join(', '),
    );
    assert.ok(!tree.labels().includes('file-00000.ts'));
  });

  test('draws the rows scrolled to before the scroll event returns', async () => {
    const tree = await mount({ entries, expanded });
    const previous = (globalThis as Record<string, unknown>)
      .IS_REACT_ACT_ENVIRONMENT;
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
    try {
      // The browser paints right after the scroll event: rows drawn on a
      // later task would show blank space for a frame.
      tree.scrollNow(28 * 12_000);
      assert.ok(
        tree.labels().includes('file-12000.ts'),
        tree.labels().join(', '),
      );
    } finally {
      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT =
        previous;
    }
  });

  test('keeps the focused row mounted and focused while it is scrolled away', async () => {
    const tree = await mount({ entries, expanded });
    const focused = tree.row('file-00003.ts');
    assert.ok(focused);
    await act(() => focused.focus());
    await tree.scrollTo(28 * 10_000);
    assert.ok(focused.isConnected, 'the focused row was unmounted');
    assert.equal(document.activeElement, focused);
    assert.ok(tree.labels().includes('file-10000.ts'));
  });

  test('opens a file row that was scrolled to', async () => {
    const opened: string[] = [];
    const tree = await mount({
      entries,
      expanded,
      actions: { open: (path) => opened.push(path), toggle: () => undefined },
    });
    await tree.scrollTo(28 * 5_000);
    const row = tree.row('file-05000.ts');
    assert.ok(row);
    await act(() => row.click());
    assert.deepEqual(opened, ['src/file-05000.ts']);
  });
});

describe('what an open directory shows', () => {
  const entries: readonly TreeNode[] = [
    {
      name: 'src',
      path: 'src',
      type: 'directory',
      children: [file('src/a.ts'), file('src/b.ts')],
    },
    { name: 'empty', path: 'empty', type: 'directory', children: [] },
  ];

  test('marks the selected file row selected, and no other', async () => {
    const tree = await mount({
      entries,
      expanded: new Set(['src']),
      selectedPath: 'src/b.ts',
    });
    assert.equal(tree.row('b.ts')?.getAttribute('aria-selected'), 'true');
    assert.equal(tree.row('a.ts')?.getAttribute('aria-selected'), 'false');
  });

  test('an empty directory states that it is empty', async () => {
    const tree = await mount({ entries, expanded: new Set(['empty']) });
    assert.match(tree.scroller.textContent ?? '', /This directory is empty\./u);
  });

  test('the pending row comes first in its directory, before the children', async () => {
    const tree = await mount({
      entries,
      expanded: new Set(['src']),
      pending: {
        directory: 'src',
        row: createElement('input', { 'aria-label': 'New file name' }),
      },
    });
    const order = Array.from(
      tree.scroller.querySelectorAll('[role="treeitem"], input'),
    ).map(
      (element) =>
        element.getAttribute('aria-label') ?? element.tagName.toLowerCase(),
    );
    assert.deepEqual(order, ['src', 'New file name', 'a.ts', 'b.ts', 'empty']);
  });

  test('the pending row replaces the empty notice of an empty directory', async () => {
    const tree = await mount({
      entries,
      expanded: new Set(['empty']),
      pending: {
        directory: 'empty',
        row: createElement('input', { 'aria-label': 'New folder name' }),
      },
    });
    assert.ok(
      tree.scroller.querySelector('input[aria-label="New folder name"]'),
    );
    assert.doesNotMatch(tree.scroller.textContent ?? '', /empty\./u);
  });

  test('an open loading directory shows one Loading line in place of its children', async () => {
    const tree = await mount({
      entries,
      expanded: new Set(['src', 'empty']),
      loading: new Set(['src', 'empty']),
    });
    const text = tree.scroller.textContent ?? '';
    assert.equal(text.match(/Loading…/gu)?.length, 2);
    assert.equal(tree.row('a.ts'), null);
    assert.doesNotMatch(text, /This directory is empty\./u);
    assert.deepEqual(tree.labels(), ['src', 'empty']);
  });

  test('a closed loading directory, and no loading set at all, show no Loading line', async () => {
    const closed = await mount({
      entries,
      expanded: new Set(),
      loading: new Set(['src']),
    });
    assert.doesNotMatch(closed.scroller.textContent ?? '', /Loading/u);

    const open = await mount({ entries, expanded: new Set(['src']) });
    assert.doesNotMatch(open.scroller.textContent ?? '', /Loading/u);
    assert.deepEqual(open.labels(), ['src', 'a.ts', 'b.ts', 'empty']);
  });

  test('a directory that finishes loading draws its children', async () => {
    const tree = await mount({
      entries,
      expanded: new Set(['src']),
      loading: new Set(['src']),
    });
    await tree.render({
      entries,
      expanded: new Set(['src']),
      loading: new Set(),
    });
    assert.deepEqual(tree.labels(), ['src', 'a.ts', 'b.ts', 'empty']);
    assert.doesNotMatch(tree.scroller.textContent ?? '', /Loading/u);
  });
});
