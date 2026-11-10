// One client view of the git bundle in this process: happy-dom's window as
// the globals (as `bundles/desktop/layout/tests/client/support/render-workspace.ts`
// installs them) and a React element rendered into `document.body`. A test
// builds the element over the stories' fakes (`stories/support/`) and reads
// the DOM and what the fakes were asked.

import { Window } from 'happy-dom';
import type { ReactElement } from 'react';

/** One rendered view. */
export interface Rendered {
  /** The element the view renders into, attached to `document.body`. */
  readonly root: HTMLElement;
  /**
   * The errors React could not recover from since the view rendered, in
   * order: such an error unmounts the view and leaves `root` empty. Each call
   * returns a new array.
   */
  errors(): readonly unknown[];
  /**
   * Unmounts the view and removes `root`. Idempotent. Call it before the next
   * `render`, at the latest in the test's `after`/`finally`.
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
export const installWindow = (): Window => {
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

let current: Rendered | undefined;

/**
 * Renders the element `view` builds.
 * - Installs happy-dom's window as the globals the first time it is called,
 *   then calls `view`; React DOM and the bundle's client modules must load
 *   after the window, so a test file imports them inside `view` (dynamic
 *   `import()`), never statically.
 * - Renders with `createRoot` and `flushSync`, and resolves once the first
 *   render and the answers it started have settled.
 * - Rejects if rendering throws. Rendering again cleans up a view still
 *   rendered.
 */
export const render = async (
  view: () => Promise<ReactElement> | ReactElement,
): Promise<Rendered> => {
  current?.cleanup();
  installWindow();
  const element = await view();
  const { flushSync } = await import('react-dom');
  const { createRoot } = await import('react-dom/client');

  const root = document.createElement('div');
  document.body.append(root);
  const errors: unknown[] = [];
  const reactRoot = createRoot(root, {
    onUncaughtError: (error) => errors.push(error),
  });
  let cleaned = false;
  const rendered: Rendered = {
    root,
    errors: () => [...errors],
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      if (current === rendered) current = undefined;
      reactRoot.unmount();
      root.remove();
    },
  };
  current = rendered;
  try {
    flushSync(() => reactRoot.render(element));
    await settle();
  } catch (error) {
    rendered.cleanup();
    throw error;
  }
  if (errors.length > 0) {
    rendered.cleanup();
    throw errors[0];
  }
  return rendered;
};
