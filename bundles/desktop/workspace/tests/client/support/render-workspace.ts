// The workspace's elements in this process (bundle isolation 4(c), spec
// section 9): happy-dom's window as the globals, the workspace activated on
// the story host by `bindWorkspace`, and the items the workspace adds to the
// shell's slots mounted as the frame mounts them, each in its own container
// under one `root`: `shell.titlebar.tabs`, `shell.sidebar`, `shell.page`,
// `shell.sidebar.footer`, then the element of the route the path matches, as
// the core's outlet draws it, then the window's `<Toaster>`. The frame's own
// DOM (the sidebar, the stack, the viewer, the notices) is not drawn: its
// cases are the layout's (`L/tests/client/shell.test.ts`). A test reads the
// DOM and what the host was asked; the host is the stories' fake host
// (`stories/support/fake-host.ts`), which records the calls of the shell's
// `layout.tabs/v2`.

import { Window } from 'happy-dom';

import type { FakeHost } from '../../../stories/support/fake-host.js';
import type { WorkspaceFixture } from '../../../stories/support/workspace-host.js';

/** One rendered workspace, and the fake host it is bound to. */
export interface RenderedWorkspace extends FakeHost {
  /** The element the slots render into, attached to `document.body`. */
  readonly root: HTMLElement;
  /**
   * The errors the elements could not recover from since they mounted, in
   * order. Each call returns a new array.
   */
  errors(): readonly unknown[];
  /**
   * Unmounts every mounted item and mounts them again into a fresh `root`
   * on the same bound host, as the core outlet does when the route pattern
   * changes: host state (navigation, records, region items) carries over, the
   * elements' own state does not. Resolves once the new mount has settled.
   */
  remount(): Promise<void>;
  /**
   * Unmounts the items, removes `root` and runs the workspace's deactivation
   * (`bindWorkspace`'s unbind). Idempotent.
   */
  cleanup(): void;
}

/** The shell slots the workspace fills, in the order the frame draws them. */
export const workspaceSlots = [
  'shell.titlebar.tabs',
  'shell.sidebar',
  'shell.page',
  'shell.sidebar.footer',
] as const;

/** The window's globals a rendered view reaches for, as chat's harness lists them. */
const globalNames = (window: Window): string[] => [
  'window',
  'document',
  'navigator',
  'location',
  'history',
  'localStorage',
  'sessionStorage',
  'customElements',
  'MutationObserver',
  'getComputedStyle',
  'getSelection',
  'matchMedia',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'innerWidth',
  'innerHeight',
  ...Object.getOwnPropertyNames(window).filter((name) =>
    /^(HTML|SVG)\w*Element$|^\w*Event$|^(Node|Element|Text|Comment|DocumentFragment|ShadowRoot|Range|Selection|StaticRange|DOMRect|ResizeObserver|IntersectionObserver|DataTransfer|NodeFilter)$/.test(
      name,
    ),
  ),
];

let installed: Window | undefined;

/** Installs happy-dom's window as the process's globals, once. */
const installWindow = (): Window => {
  if (installed !== undefined) return installed;
  const window = new Window({
    url: 'http://localhost/',
    width: 1280,
    height: 800,
  });
  // happy-dom runs no Web Animations and implements `getAnimations` on shadow
  // roots alone; base-ui asks an element for the animations in progress
  // before it unmounts a popup, and here, truthfully, there are none.
  const element = window.Element.prototype as unknown as Record<
    string,
    unknown
  >;
  if (typeof element.getAnimations !== 'function')
    element.getAnimations = (): unknown[] => [];
  // happy-dom lays nothing out, so every `offsetLeft` is 0. react-resizable-
  // panels orders a horizontal group's panels and separators by
  // `element.offsetLeft`, then `offsetWidth`
  // (`react-resizable-panels/dist/react-resizable-panels.js:325-333`); with
  // all ties a panel mounted between siblings sorts last, unlike in a browser.
  // Stand in a row in document order: 100px per position among the parent's
  // element children. `offsetWidth` stays happy-dom's, as the library also
  // sizes panels from it.
  Object.defineProperty(window.HTMLElement.prototype, 'offsetLeft', {
    configurable: true,
    get(this: HTMLElement): number {
      const siblings = this.parentElement?.children;
      return siblings === undefined
        ? 0
        : Array.prototype.indexOf.call(siblings, this) * 100;
    },
  });
  for (const name of globalNames(window)) {
    const value = (window as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value:
        typeof value === 'function' && !/^[A-Z]/.test(name)
          ? (value as (...args: unknown[]) => unknown).bind(window)
          : value,
    });
  }
  installed = window;
  return window;
};

/** Waits for queued microtasks, immediates and short timers, after a click or an answer. */
export const settle = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) {
    await new Promise<void>((done) => setImmediate(done));
  }
  await new Promise<void>((done) => setTimeout(done, 20));
  for (let index = 0; index < 10; index += 1) {
    await new Promise<void>((done) => setImmediate(done));
  }
};

let current: RenderedWorkspace | undefined;

type Ui = {
  create(tag: string, props?: Readonly<Record<string, unknown>>): unknown;
  dispose(element: unknown): void;
};
type Regions = {
  items(region: string): readonly {
    readonly id: string;
    readonly tag: string;
    readonly props?: Readonly<Record<string, unknown>>;
  }[];
  subscribe(region: string, listener: () => void): { dispose(): void };
};
type Navigation = {
  current():
    | {
        readonly pattern: string;
        readonly path: string;
        readonly params: Record<string, string>;
      }
    | undefined;
  subscribe(listener: () => void): { dispose(): void };
};

/**
 * `<core-region name>` as the shell's region draws it: each item created
 * through the bound host's `ui/v1`, following the region's changes. Defined
 * once per process; it reads the host bound last.
 */
const defineRegionStandIn = (): void => {
  if (customElements.get('core-region') !== undefined) return;
  customElements.define(
    'core-region',
    class StoryRegion extends HTMLElement {
      #stop: { dispose(): void } | undefined;
      readonly #created = new Map<string, unknown>();

      connectedCallback(): void {
        this.style.display = 'contents';
        if (this.#stop !== undefined || current === undefined) return;
        const name = this.getAttribute('name') ?? '';
        const ui = current.services.use({ id: 'ui/v1' } as never) as Ui;
        const regions = current.services.use({
          id: 'regions/v1',
        } as never) as Regions;
        const draw = () => {
          const items = regions.items(name);
          const wanted = new Set(items.map((item) => item.id));
          for (const [id, element] of [...this.#created]) {
            if (wanted.has(id)) continue;
            this.#created.delete(id);
            ui.dispose(element);
          }
          items.forEach((item, index) => {
            let element = this.#created.get(item.id) as Node | undefined;
            if (element === undefined) {
              element = ui.create(item.tag, item.props) as Node;
              this.#created.set(item.id, element);
            }
            const at = this.childNodes[index] ?? null;
            if (at !== element) this.insertBefore(element, at);
          });
        };
        this.replaceChildren();
        draw();
        this.#stop = regions.subscribe(name, draw);
      }

      disconnectedCallback(): void {
        this.#stop?.dispose();
        this.#stop = undefined;
        this.#created.clear();
      }
    },
  );
};

/**
 * Renders the workspace for `fixture`.
 * - Installs happy-dom's window as the globals the first time it is called,
 *   and loads React DOM and the workspace only after them, so a test file
 *   must not import `react-dom` or workspace client modules statically.
 * - Binds the workspace to a fake host built from `fixture`
 *   (`bindWorkspace`), which activates `src/client/index.ts`.
 * - Mounts, each in its own container (`[data-slot-name="<slot>"]`) under
 *   `root`, the items of `workspaceSlots` as the host's `ui/v1` creates them,
 *   following each slot's changes; then, in `[data-slot-name="outlet"]`, the
 *   element the registered route of the current path creates, following the
 *   route; then, in `[data-slot-name="toaster"]`, the `<Toaster>` of
 *   `desktop/ui/sonner` the frame mounts, which draws the toasts the
 *   workspace posts.
 * - Resolves once the mount and the answers it started have settled.
 * - Rendering again first cleans up what is rendered.
 */
export const renderWorkspace = async (
  fixture: WorkspaceFixture = {},
): Promise<RenderedWorkspace> => {
  current?.cleanup();
  const window = installWindow();
  const { bindWorkspace } = await import(
    '../../../stories/support/workspace-host.js'
  );

  const { createElement } = await import('react');
  const { flushSync } = await import('react-dom');
  const { createRoot } = await import('react-dom/client');
  const { Toaster } = await import('desktop/ui/sonner');

  const bound = bindWorkspace(fixture);
  const ui = bound.services.use({ id: 'ui/v1' } as never) as Ui;
  const regions = bound.services.use({ id: 'regions/v1' } as never) as Regions;
  const navigation = bound.services.use({
    id: 'navigation/v1',
  } as never) as Navigation;
  const errors: unknown[] = [];
  const onError = (event: { readonly error?: unknown }) =>
    errors.push(event.error);
  window.addEventListener('error', onError as never);

  const mount = () => {
    const root = document.createElement('div');
    document.body.append(root);
    const stops: (() => void)[] = [];
    for (const slot of workspaceSlots) {
      const container = document.createElement('div');
      container.dataset.slotName = slot;
      root.append(container);
      const created = new Map<string, unknown>();
      const draw = () => {
        const items = regions.items(slot);
        const wanted = new Set(items.map((item) => item.id));
        for (const [id, element] of [...created]) {
          if (wanted.has(id)) continue;
          created.delete(id);
          ui.dispose(element);
        }
        items.forEach((item, index) => {
          let element = created.get(item.id) as Node | undefined;
          if (element === undefined) {
            element = ui.create(item.tag, item.props) as Node;
            created.set(item.id, element);
          }
          const at = container.childNodes[index] ?? null;
          if (at !== element) container.insertBefore(element, at);
        });
      };
      draw();
      const subscription = regions.subscribe(slot, draw);
      stops.push(() => {
        subscription.dispose();
        for (const element of created.values()) ui.dispose(element);
        created.clear();
      });
    }
    const outlet = document.createElement('div');
    outlet.dataset.slotName = 'outlet';
    root.append(outlet);
    let shown: { key: string; element: unknown } | undefined;
    const route = () => {
      const match = navigation.current();
      const registration =
        match === undefined
          ? undefined
          : bound.routes().find((entry) => entry.path === match.pattern);
      const key =
        match === undefined || registration === undefined
          ? ''
          : `${match.pattern} ${JSON.stringify(match.params)}`;
      if (shown?.key === key) return;
      if (shown !== undefined) ui.dispose(shown.element);
      shown = undefined;
      outlet.replaceChildren();
      if (match === undefined || registration === undefined) return;
      const element = registration.create(match);
      shown = { key, element };
      outlet.append(element as Node);
    };
    route();
    // The frame's toaster (`L/src/client/views/workspace-view.tsx`), the
    // window's one `<Toaster>` from `desktop/ui/sonner`: the toasts the
    // workspace posts through `toast` draw here, as in the window.
    const toaster = document.createElement('div');
    toaster.dataset.slotName = 'toaster';
    root.append(toaster);
    const toasterRoot = createRoot(toaster);
    flushSync(() => toasterRoot.render(createElement(Toaster)));
    stops.push(() => toasterRoot.unmount());
    const following = navigation.subscribe(route);
    stops.push(() => {
      following.dispose();
      if (shown !== undefined) ui.dispose(shown.element);
      shown = undefined;
    });
    return { root, stops };
  };

  defineRegionStandIn();
  let view: ReturnType<typeof mount> | undefined;
  const unmount = () => {
    for (const stop of view?.stops ?? []) stop();
    view?.root.remove();
  };

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (current === rendered) current = undefined;
    unmount();
    window.removeEventListener('error', onError as never);
    bound.unbind();
  };
  const rendered: RenderedWorkspace = {
    services: bound.services,
    regionItems: bound.regionItems,
    executed: bound.executed,
    tabCalls: bound.tabCalls,
    routes: bound.routes,
    records: bound.records,
    notifyRecords: bound.notifyRecords,
    get root() {
      if (view === undefined) throw new Error('The workspace is not mounted.');
      return view.root;
    },
    errors: () => [...errors],
    remount: async () => {
      unmount();
      view = mount();
      await settle();
    },
    cleanup,
  };
  current = rendered;
  view = mount();

  await settle();
  return rendered;
};
