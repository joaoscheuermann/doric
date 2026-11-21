// The account's `<account-status>` alone in this process (spec section 9):
// happy-dom's window as the globals (the window code of the layout's
// `tests/client/support/render-workspace.ts`), the account activated on its
// story host by `bindAccount`, and `ui.create('account-status')` mounted in a
// bare container. A test reads the DOM and what the host was asked.

import { UiV1 } from 'bundle/contracts';
import { Window } from 'happy-dom';

import type { AccountFixture } from '../../../stories/support/account-host.js';
import type { FakeHost } from '../../../stories/support/fake-host.js';

/** One mounted `<account-status>`, and the fake host it is bound to. */
export interface RenderedAccount extends FakeHost {
  /** The container the element is mounted in, attached to `document.body`. */
  readonly root: HTMLElement;
  /**
   * The errors the window reported since the element mounted, in order. Each
   * call returns a new array.
   */
  errors(): readonly unknown[];
  /**
   * Disposes the element and mounts a new `account-status` into a fresh
   * `root` on the same bound host. Resolves once the new element settled.
   */
  remount(): Promise<void>;
  /**
   * Disposes the element, removes `root` and runs the account's
   * deactivation (`bindAccount`'s unbind). Idempotent.
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

let current: RenderedAccount | undefined;

/**
 * Mounts `<account-status>` for `fixture`.
 * - Installs happy-dom's window as the globals the first time it is called,
 *   and loads React DOM and the account only after them, so a test file must
 *   not import `react-dom` or account client modules statically.
 * - Binds the account to a fake host built from `fixture` (`bindAccount`) and
 *   mounts `services.use(UiV1).create('account-status')` in a container.
 * - Resolves once the element and the answers it started have settled, so
 *   the about version is in place when the host answers it.
 * - Mounting again first cleans up what is mounted.
 */
export const renderAccount = async (
  fixture: AccountFixture = {},
): Promise<RenderedAccount> => {
  current?.cleanup();
  const window = installWindow();
  const { bindAccount } = await import(
    '../../../stories/support/account-host.js'
  );

  const bound = bindAccount(fixture);
  const ui = bound.services.use(UiV1);
  const errors: unknown[] = [];
  const onError = (event: { readonly error?: unknown }) =>
    errors.push(event.error);
  window.addEventListener('error', onError as never);

  const mount = () => {
    const container = document.createElement('div');
    document.body.append(container);
    const element = ui.create('account-status');
    container.append(element as Node);
    return { container, element };
  };
  let view = mount();
  const unmount = () => {
    ui.dispose(view.element);
    view.container.remove();
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
  const rendered: RenderedAccount = {
    services: bound.services,
    regionItems: bound.regionItems,
    executed: bound.executed,
    get root() {
      return view.container;
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

  await settle();
  return rendered;
};
