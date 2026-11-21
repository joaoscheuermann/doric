/**
 * `ElementHost` and `useRegionItems` (`desktop/ui/element-host`) let any
 * bundle draw an element another bundle defined, given its own `ui/v1` and
 * `regions/v1` (bundle isolation, step 4(a), T4.1).
 *
 * Contract matrix (T4.1):
 * - `ElementHost` places the node `ui.create(tag, props)` answers in its host
 *   while mounted, and calls `ui.dispose(node)` once on unmount.
 * - When `ui.create` throws, it draws a compact notice titled "View failed to
 *   open" and logs `console.error` once, even after a re-render.
 * - `useRegionItems(regions, region)` answers `regions.items(region)`, the
 *   same array across renders while the region is unchanged, and the new
 *   array after the region's `subscribe` listener fires.
 *
 * The imports resolve through the package's export map, so this exercises
 * the files the windows load.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';

import type { Disposable, RegionEntry, Regions, Ui } from 'bundle/contracts';
import { Window } from 'happy-dom';

const window = new Window();
const installed = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLButtonElement',
  'SVGElement',
  'DocumentFragment',
  'Element',
  'Node',
  'NodeFilter',
  'Event',
  'CustomEvent',
  'FocusEvent',
  'KeyboardEvent',
  'PointerEvent',
  'MouseEvent',
  'MutationObserver',
  'ResizeObserver',
  'getComputedStyle',
  'matchMedia',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const;

let hosts: typeof import('desktop/ui/element-host');
let createRoot: typeof import('react-dom/client').createRoot;
let createElement: typeof import('react').createElement;
let act: (callback: () => void | Promise<void>) => Promise<void>;

before(async () => {
  for (const name of installed) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: (window as unknown as Record<string, unknown>)[name],
      writable: true,
    });
  }
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const react = await import('react');
  act = react.act as typeof act;
  createElement = react.createElement;
  ({ createRoot } = await import('react-dom/client'));
  hosts = await import('desktop/ui/element-host');
});

after(async () => {
  await window.happyDOM.abort();
  await window.happyDOM.close();
});

afterEach(() => {
  document.body.replaceChildren();
});

/* ------------------------------------------------------------------ */
/* Fakes and rendering                                                 */
/* ------------------------------------------------------------------ */

/** A `ui/v1` that records its calls; `create` answers a labelled `<div>` or throws. */
const fakeUi = (options: { readonly fails?: boolean } = {}) => {
  const created: {
    readonly tag: string;
    readonly props?: Readonly<Record<string, unknown>>;
    readonly node: HTMLElement;
  }[] = [];
  const disposed: object[] = [];
  const ui: Ui = {
    define: (): Disposable => ({ dispose: () => undefined }),
    create: (tag, props) => {
      if (options.fails) throw new Error('define() was never called');
      const node = document.createElement('div');
      node.dataset.created = tag;
      created.push({ tag, props, node });
      return node;
    },
    dispose: (element) => {
      disposed.push(element);
    },
  };
  return { ui, created, disposed };
};

/** A `regions/v1` whose items are set by the test and whose listeners it fires. */
const fakeRegions = (initial: readonly RegionEntry[]) => {
  let current = initial;
  const listeners = new Set<() => void>();
  const regions: Regions = {
    add: (): Disposable => ({ dispose: () => undefined }),
    items: (region) => (region === 'r' ? current : []),
    subscribe: (region, listener) => {
      if (region === 'r') listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  return {
    regions,
    /** Replaces the items of `r` and tells every listener. */
    change: (next: readonly RegionEntry[]) => {
      current = next;
      for (const listener of [...listeners]) listener();
    },
  };
};

/** A root on a fresh element of the document. */
const mountRoot = () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container as unknown as Element);
  return {
    container,
    render: (node: Parameters<typeof root.render>[0]) =>
      act(() => root.render(node)),
    unmount: () => act(() => root.unmount()),
  };
};

/** The title of a notice, read through its `aria-labelledby`. */
const titleOf = (notice: HTMLElement): string | undefined => {
  const id = notice.getAttribute('aria-labelledby');
  assert.ok(id, 'The notice names no title.');
  return document.getElementById(id)?.textContent?.trim();
};

const noticeIn = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-slot="error-notice"]');

/* ------------------------------------------------------------------ */
/* ElementHost                                                         */
/* ------------------------------------------------------------------ */

describe('ElementHost (T4.1)', () => {
  test('places the node ui.create answers in the host and disposes it once on unmount', async () => {
    const { ui, created, disposed } = fakeUi();
    const props = { projectId: 'p1' };
    const root = mountRoot();

    await root.render(
      createElement(hosts.ElementHost, { ui, tag: 'x-view', props }),
    );

    assert.equal(created.length, 1);
    assert.equal(created[0]?.tag, 'x-view');
    assert.deepEqual(created[0]?.props, props);
    const node = created[0]?.node;
    assert.ok(node);
    assert.ok(
      root.container.contains(node),
      'The created node is not in the host.',
    );
    assert.equal(noticeIn(root.container), null);
    assert.deepEqual(disposed, []);

    await root.unmount();

    assert.equal(disposed.length, 1);
    assert.equal(disposed[0], node);
    assert.ok(!root.container.contains(node));
  });

  test('a ui.create that throws draws a compact "View failed to open" and logs once, even after a re-render', async (t) => {
    const logged = t.mock.method(console, 'error', () => undefined);
    const { ui } = fakeUi({ fails: true });
    const root = mountRoot();

    await root.render(
      createElement(hosts.ElementHost, { ui, tag: 'x-view', props: { a: 1 } }),
    );
    await root.render(
      createElement(hosts.ElementHost, { ui, tag: 'x-view', props: { a: 2 } }),
    );

    const notice = noticeIn(root.container);
    assert.ok(notice, 'No notice was drawn.');
    assert.equal(titleOf(notice), 'View failed to open');
    assert.equal(notice.dataset.variant, 'compact');
    assert.equal(logged.mock.callCount(), 1);
    assert.match(
      String(logged.mock.calls[0]?.arguments[0]),
      /the element <x-view> could not be created/,
    );

    await root.unmount();
  });
});

/* ------------------------------------------------------------------ */
/* useRegionItems                                                      */
/* ------------------------------------------------------------------ */

const entry = (id: string): RegionEntry => ({
  id,
  tag: `x-${id}`,
  owner: 'bundle.test',
});

describe('useRegionItems (T4.1)', () => {
  test("answers the region's items, the same array until the region changes, then the new one", async () => {
    const first = [entry('a'), entry('b')];
    const fake = fakeRegions(first);
    const seen: (readonly RegionEntry[])[] = [];
    const Probe = (props: { readonly round: number }) => {
      seen.push(hosts.useRegionItems(fake.regions, 'r'));
      return createElement('span', null, String(props.round));
    };
    const root = mountRoot();

    await root.render(createElement(Probe, { round: 1 }));
    await root.render(createElement(Probe, { round: 2 }));

    assert.ok(seen.length >= 2, 'The probe did not re-render.');
    for (const items of seen) assert.equal(items, first);

    const second = [entry('c')];
    const rendersBefore = seen.length;
    await act(() => fake.change(second));

    assert.ok(seen.length > rendersBefore, 'The change did not re-render.');
    assert.equal(seen.at(-1), second);

    await root.unmount();
  });
});
