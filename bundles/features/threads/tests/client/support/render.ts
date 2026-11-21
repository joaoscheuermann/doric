// One element of the threads bundle's client part in this process, alone:
// happy-dom's window as the globals (as `bundles/runtime/default/tests/client/support/render.ts`
// installs them) and one custom element mounted in `document.body`.
//
// Bundle isolation 5(b), change 3 (AC5.3): `mountElement` mounts the
// `thread-spawn` element as the chat creates a registered tool element —
// `services` and `view` set, then connected. No chat window and no chat built
// part; `./window.ts` is not used.

import type { Services } from 'bundle/contracts';
import type { ReactElementInstance } from 'desktop/ui/react-element';
import { Window } from 'happy-dom';

/** The window's globals a rendered element reaches for, as chat's harness lists them. */
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

/** One custom element mounted alone in `document.body`. */
export interface MountedElement<V> {
  readonly element: HTMLElement & { view: V; toggle?(): void };
  /** The `chat-block-chosen` details the element dispatched, in order. */
  readonly chosen: readonly boolean[];
  /** Sets a new `view` object on the same element and settles. */
  setView(view: V): Promise<void>;
  /** Removes the element. Idempotent. */
  cleanup(): void;
}

let mounted: { cleanup(): void } | undefined;

/**
 * Defines `tag` once in happy-dom's registry, creates the element, sets
 * `services` and `view` on it, appends it to `document.body` and settles.
 * - Installs the window first; the module that built `element` must have
 *   been imported after `installWindow()` (React DOM reads the globals).
 * - Mounting again cleans up an element still mounted.
 */
export const mountElement = async <V>(
  tag: string,
  element: new () => ReactElementInstance,
  input: { readonly services: Services; readonly view: V },
): Promise<MountedElement<V>> => {
  mounted?.cleanup();
  installWindow();
  if (customElements.get(tag) === undefined)
    customElements.define(tag, element);
  const node = document.createElement(
    tag,
  ) as unknown as ReactElementInstance & {
    view: V;
    toggle?(): void;
  };
  const chosen: boolean[] = [];
  node.addEventListener('chat-block-chosen', (event) => {
    const detail = (event as CustomEvent<{ readonly chosen: boolean }>).detail;
    chosen.push(detail.chosen);
  });
  node.services = input.services;
  node.view = input.view;
  document.body.append(node);
  await settle();
  let cleaned = false;
  const result: MountedElement<V> = {
    element: node,
    chosen,
    setView: async (view) => {
      node.view = view;
      await settle();
    },
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      if (mounted === result) mounted = undefined;
      node.remove();
      node.dispose();
    },
  };
  mounted = result;
  return result;
};
