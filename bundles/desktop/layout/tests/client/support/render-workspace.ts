// The layout's whole workspace view in this process: happy-dom's window as
// the globals (as `tests/project-tabs-navigation.test.ts:12-17` installs
// them), the layout activated on the story host by `bindLayout`, and
// `WorkspaceView` rendered as `<layout-workspace>` renders it. A test reads
// the DOM and what the host was asked; the host is the stories' fake host.

import { Window } from 'happy-dom';

import type { FakeHost } from '../../../stories/support/fake-host.js';
import type { LayoutFixture } from '../../../stories/support/layout-host.js';

/** One rendered workspace, and the fake host it is bound to. */
export interface RenderedWorkspace extends FakeHost {
  /** The element the view renders into, attached to `document.body`. */
  readonly root: HTMLElement;
  /**
   * The errors React could not recover from since the view rendered, in
   * order: such an error unmounts the view and leaves `root` empty. Each call
   * returns a new array.
   */
  errors(): readonly unknown[];
  /**
   * Unmounts the view and renders a new `WorkspaceView` into a fresh `root`
   * on the same bound host, as the core outlet does when the route pattern
   * changes (`bundles/foundation/core/src/client/elements/outlet.ts:3-4`):
   * host state (navigation, projects, region items) carries over, the view's
   * own React state does not. `root` then names the new element. Resolves
   * once the new render has settled; rejects if it throws.
   */
  remount(): Promise<void>;
  /**
   * Unmounts the view, removes `root` and runs the layout's deactivation
   * (`bindLayout`'s unbind). Idempotent. Call it before the next
   * `renderWorkspace`, at the latest in the test's `after`/`finally`.
   */
  cleanup(): void;
}

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

/**
 * Renders the workspace for `fixture`.
 * - Installs happy-dom's `window`, `document` and `localStorage` as globals
 *   the first time it is called. It loads React DOM and the layout only after
 *   them, so a test file must not import `react-dom` or layout client modules
 *   statically.
 * - Binds the layout to a fake host built from `fixture` (`bindLayout`, with
 *   the app's region items) and renders `WorkspaceView` with `createRoot` and
 *   `flushSync`.
 * - Resolves once the first render and the answers it started have settled,
 *   so the about version is in place when the host answers it.
 * - `<core-region>` is the stories' stand-in (`defineStoryElements`,
 *   `story-elements.ts:26-40`), which draws `regionItems(name)` as
 *   placeholders, so a region's seeded items appear in `root`.
 * - Rejects if rendering throws. Binding again unbinds a workspace still
 *   bound.
 */
export const renderWorkspace = async (
  fixture: LayoutFixture = {},
): Promise<RenderedWorkspace> => {
  current?.cleanup();
  installWindow();
  const { createElement } = await import('react');
  const { flushSync } = await import('react-dom');
  const { createRoot } = await import('react-dom/client');
  const { bindLayout } = await import(
    '../../../stories/support/layout-host.js'
  );
  const { WorkspaceView } = await import(
    '../../../src/client/views/workspace-view.js'
  );

  const bound = bindLayout(fixture);
  const errors: unknown[] = [];
  const mount = () => {
    const element = document.createElement('div');
    document.body.append(element);
    const root = createRoot(element, {
      onUncaughtError: (error) => errors.push(error),
    });
    return { element, root };
  };
  let view = mount();

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (current === rendered) current = undefined;
    view.root.unmount();
    view.element.remove();
    bound.unbind();
  };
  const show = async (): Promise<void> => {
    try {
      flushSync(() => view.root.render(createElement(WorkspaceView)));
      await settle();
    } catch (error) {
      cleanup();
      throw error;
    }
    if (errors.length > 0) {
      cleanup();
      throw errors[0];
    }
  };
  const rendered: RenderedWorkspace = {
    services: bound.services,
    regionItems: bound.regionItems,
    executed: bound.executed,
    get root() {
      return view.element;
    },
    errors: () => [...errors],
    remount: async () => {
      view.root.unmount();
      view.element.remove();
      view = mount();
      await show();
    },
    cleanup,
  };
  current = rendered;

  await show();
  return rendered;
};
