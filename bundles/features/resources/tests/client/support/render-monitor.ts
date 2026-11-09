// The `<resources-monitor>` element in this process: happy-dom's window as the
// globals (as `bundles/desktop/layout/tests/client/support/render-workspace.ts`
// installs them, with its `getAnimations` stand-in for Base UI's popups), and
// the element built by `defineResourcesElements` around a test-owned
// `QueryClient`, so a test advances the polls with `refetchQueries` instead of
// waiting for the 3 s interval.

import type { QueryClient } from '@tanstack/react-query';
import type { Services } from 'bundle/contracts';
import { Window } from 'happy-dom';

/** The window's globals a rendered element reaches for, as layout's harness lists them. */
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

/** Presses `element` as a mouse does: pointer and mouse down, up, click. */
export const press = async (element: HTMLElement): Promise<void> => {
  const init = {
    bubbles: true,
    cancelable: true,
    button: 0,
    pointerId: 1,
    pointerType: 'mouse',
  };
  element.dispatchEvent(new PointerEvent('pointerdown', init));
  element.dispatchEvent(new MouseEvent('mousedown', init));
  element.dispatchEvent(new PointerEvent('pointerup', init));
  element.dispatchEvent(new MouseEvent('mouseup', init));
  element.click();
  await settle();
};

/** One mounted `<resources-monitor>`, and the query client it renders under. */
export interface RenderedMonitor {
  /** The element, attached to `document.body`. */
  readonly root: HTMLElement;
  /** The client every poll of the element goes through. */
  readonly client: QueryClient;
  /** Refetches every active query, then lets React commit the answers. */
  advance(): Promise<void>;
  /** Removes the element, lets it unmount, and clears the client. Idempotent. */
  cleanup(): Promise<void>;
}

let defined = 0;

/**
 * Mounts `<resources-monitor>` with `services`, under a fresh client with the
 * activation's settings (`createStoryQueryClient`). It installs the window
 * first and loads React DOM and the element only after it, so a test file
 * must not import `react-dom` or the client modules statically. It resolves
 * once the first render and the reads it started have settled.
 */
export const renderMonitor = async (
  services: Services,
): Promise<RenderedMonitor> => {
  installWindow();
  const { createStoryQueryClient } = await import(
    '../../../stories/support/query.js'
  );
  const { defineResourcesElements } = await import(
    '../../../src/client/elements.js'
  );

  const client = createStoryQueryClient();
  defined += 1;
  const tag = `test-resources-monitor-${defined}`;
  customElements.define(tag, defineResourcesElements(client).monitor);
  const root = document.createElement(tag) as HTMLElement & {
    services: Services;
  };
  root.services = services;
  document.body.append(root);
  await settle();

  let cleaned = false;
  return {
    root,
    client,
    advance: async () => {
      await client.refetchQueries();
      await settle();
    },
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      root.remove();
      await settle();
      client.clear();
    },
  };
};
