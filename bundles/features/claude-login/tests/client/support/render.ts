// One client element of the claude-login bundle in this process: happy-dom's
// window as the globals (as the terminal's `tests/client/support/render.ts`
// installs them) and the element mounted alone in `document.body`, as the
// settings window creates an item of `settings.provider.field`: `services`
// and `view` set, then connected. No settings window and no settings part.

import type { Services } from 'bundle/contracts';
import type { ReactElementInstance } from 'desktop/ui/react-element';
import { Window } from 'happy-dom';

/** The window's globals a rendered element reaches for. */
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

/** Waits for queued microtasks, immediates and `milliseconds` of timers. */
export const settle = async (milliseconds = 20): Promise<void> => {
  for (let index = 0; index < 10; index += 1) {
    await new Promise<void>((done) => setImmediate(done));
  }
  await new Promise<void>((done) => setTimeout(done, milliseconds));
  for (let index = 0; index < 10; index += 1) {
    await new Promise<void>((done) => setImmediate(done));
  }
};

/** One `settings-provider-field` event as the element's parent heard it. */
export interface Answer {
  readonly value: unknown;
  readonly bubbles: boolean;
  readonly composed: boolean;
}

/** One custom element mounted alone in `document.body`. */
export interface MountedElement<V> {
  readonly element: HTMLElement & { view: V };
  /**
   * The `settings-provider-field` events that reached the element's parent,
   * in order: an event that does not bubble never reaches it.
   */
  readonly answers: readonly Answer[];
  /** Sets a new `view` object on the same element and settles. */
  setView(view: V): Promise<void>;
  /** Removes the element. Idempotent. */
  cleanup(): void;
}

let mounted: { cleanup(): void } | undefined;

/**
 * Defines `tag` once in happy-dom's registry, creates the element, sets
 * `services` and `view` on it, appends it inside a frame of `document.body`
 * and settles.
 * - Installs the window first; the module that built `element` must have
 *   been imported after `installWindow()` (React DOM reads the globals).
 * - A tag is bound to the first class defined under it: a test that builds a
 *   class of its own passes a tag of its own.
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
  const frame = document.createElement('div');
  const node = document.createElement(
    tag,
  ) as unknown as ReactElementInstance & {
    view: V;
  };
  const answers: Answer[] = [];
  frame.addEventListener('settings-provider-field', (event) => {
    answers.push({
      value: (event as CustomEvent<{ readonly value?: unknown }>).detail?.value,
      bubbles: event.bubbles,
      composed: event.composed,
    });
  });
  node.services = input.services;
  node.view = input.view;
  frame.append(node);
  document.body.append(frame);
  await settle();
  let cleaned = false;
  const result: MountedElement<V> = {
    element: node,
    answers,
    setView: async (view) => {
      node.view = view;
      await settle();
    },
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      if (mounted === result) mounted = undefined;
      frame.remove();
      node.dispose();
    },
  };
  mounted = result;
  return result;
};
