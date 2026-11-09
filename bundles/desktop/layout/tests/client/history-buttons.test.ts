// Back/Forward in the sidebar header (§4.2, S35, T-4.2.12), as the reader
// meets them: two buttons named "Back" and "Forward" in the header, each
// disabled when `navigation/v1`'s `history()` says it cannot move. The group
// is drawn only when `desktop/ui/button-group` loads and the app lists the
// history methods; otherwise the header renders without it.

import assert from 'node:assert/strict';
import { afterEach, before, test } from 'node:test';

import { ContractError, type Services } from 'bundle/contracts';
import { Window } from 'happy-dom';

import type * as HeaderModule from '../../src/client/components/organisms/sidebar-header.js';
import type * as ServicesModule from '../../src/client/services/layout-services.js';

type History = { canGoBack: boolean; canGoForward: boolean };

let header: typeof HeaderModule;
let layoutServices: typeof ServicesModule;
let render: (element: unknown) => Promise<HTMLElement>;
let unmount: () => void = () => undefined;
let errors: unknown[] = [];

before(async () => {
  const window = new Window({ url: 'http://localhost/' });
  // The window's globals React and Base UI reach for, as
  // `support/render-workspace.ts` installs them (Node's own `navigator` is a
  // getter, so each is defined, not assigned).
  const names = [
    'window',
    'document',
    'navigator',
    'localStorage',
    'MutationObserver',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    ...Object.getOwnPropertyNames(window).filter((name) =>
      /^(HTML|SVG)\w*Element$|^\w*Event$|^(Node|Element|Text|DocumentFragment|ShadowRoot)$/.test(
        name,
      ),
    ),
  ];
  for (const name of names) {
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
  header = await import(
    '../../src/client/components/organisms/sidebar-header.js'
  );
  layoutServices = await import(
    '../../src/client/services/layout-services.js'
  );
  const { flushSync } = await import('react-dom');
  const { createRoot } = await import('react-dom/client');
  render = async (element) => {
    const host = window.document.createElement('div');
    window.document.body.append(host as never);
    const root = createRoot(host as unknown as HTMLElement, {
      onUncaughtError: (error) => errors.push(error),
    });
    flushSync(() => root.render(element as never));
    unmount = () => {
      root.unmount();
      host.remove();
    };
    await settle();
    return host as unknown as HTMLElement;
  };
});

afterEach(() => {
  unmount();
  unmount = () => undefined;
  layoutServices.setLayoutServices(undefined);
  errors = [];
});

const settle = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) {
    await new Promise<void>((done) => setImmediate(done));
  }
};

/**
 * A window's `navigation/v1` whose `history()` answers `state` (or throws
 * what `fails` names), recording the Back and Forward calls; `set()` changes
 * the answer and runs the `subscribe` listeners, as a navigation would.
 */
const fakeNavigation = (
  initial: History,
  fails?: () => never,
): {
  readonly services: Services;
  readonly calls: string[];
  set(next: History): void;
} => {
  let state = initial;
  const calls: string[] = [];
  const listeners = new Set<(match: undefined) => void>();
  const navigation = {
    back: () => calls.push('back'),
    forward: () => calls.push('forward'),
    history: () => (fails === undefined ? state : fails()),
    current: () => undefined,
    subscribe: (listener: (match: undefined) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  const services = {
    use: (contract: { readonly id: string }) => {
      if (contract.id === 'navigation/v1') return navigation;
      throw new Error(`No ${contract.id} here.`);
    },
  } as unknown as Services;
  return {
    services,
    calls,
    set: (next) => {
      state = next;
      for (const listener of [...listeners]) listener(undefined);
    },
  };
};

const realLoad = () => import('desktop/ui/button-group');

const renderHeader = async (
  history: HeaderModule.SidebarHeaderProps['history'],
): Promise<HTMLElement> => {
  const { createElement } = await import('react');
  return render(
    createElement(header.SidebarHeader, {
      onDashboard: () => undefined,
      history,
    }),
  );
};

const named = (root: HTMLElement, name: string): HTMLElement[] =>
  [...root.querySelectorAll('button')].filter(
    (button) => button.getAttribute('aria-label') === name,
  ) as HTMLElement[];

const one = (root: HTMLElement, name: string): HTMLElement => {
  const found = named(root, name);
  assert.equal(found.length, 1, `Expected one "${name}" button.`);
  return found[0] as HTMLElement;
};

const disabled = (button: HTMLElement): boolean =>
  button.hasAttribute('disabled') ||
  button.getAttribute('aria-disabled') === 'true';

/** The header rendered, with its Dashboard button and no Back or Forward. */
const assertHeaderWithoutHistory = (root: HTMLElement): void => {
  assert.deepEqual(errors, []);
  assert.equal(
    root.querySelectorAll('[data-slot="workspace-sidebar-header"]').length,
    1,
    'The sidebar header did not render.',
  );
  one(root, 'Dashboard');
  assert.equal(named(root, 'Back').length, 0, 'A Back button is drawn.');
  assert.equal(named(root, 'Forward').length, 0, 'A Forward button is drawn.');
};

test('with no desktop/ui/button-group the header renders without Back or Forward', async () => {
  const fake = fakeNavigation({ canGoBack: true, canGoForward: true });
  layoutServices.setLayoutServices(fake.services);

  const root = await renderHeader({
    load: () => Promise.reject(new Error('Cannot find module')),
    historyMethods: true,
  });

  assertHeaderWithoutHistory(root);
});

test('when the app does not list the history methods there is no Back or Forward', async () => {
  const fake = fakeNavigation({ canGoBack: true, canGoForward: true });
  layoutServices.setLayoutServices(fake.services);

  const root = await renderHeader({ load: realLoad, historyMethods: false });

  assertHeaderWithoutHistory(root);
});

test("when the core's provider lacks history() there is no Back or Forward", async () => {
  const fake = fakeNavigation({ canGoBack: true, canGoForward: true }, () => {
    throw new ContractError(
      'unavailable',
      'Contract "navigation/v1" has no method "history".',
    );
  });
  layoutServices.setLayoutServices(fake.services);

  const root = await renderHeader({ load: realLoad, historyMethods: true });

  assertHeaderWithoutHistory(root);
});

test('Back and Forward are disabled while history() says neither can move', async () => {
  const fake = fakeNavigation({ canGoBack: false, canGoForward: false });
  layoutServices.setLayoutServices(fake.services);

  const root = await renderHeader({ load: realLoad, historyMethods: true });

  assert.deepEqual(errors, []);
  assert.ok(disabled(one(root, 'Back')), 'Back is enabled.');
  assert.ok(disabled(one(root, 'Forward')), 'Forward is enabled.');
});

test('Back and Forward follow history() after each navigation notice', async () => {
  const fake = fakeNavigation({ canGoBack: false, canGoForward: false });
  layoutServices.setLayoutServices(fake.services);
  const root = await renderHeader({ load: realLoad, historyMethods: true });

  fake.set({ canGoBack: true, canGoForward: false });
  await settle();
  assert.equal(disabled(one(root, 'Back')), false, 'Back stays disabled.');
  assert.ok(disabled(one(root, 'Forward')), 'Forward is enabled.');

  fake.set({ canGoBack: false, canGoForward: true });
  await settle();
  assert.ok(disabled(one(root, 'Back')), 'Back stays enabled.');
  assert.equal(
    disabled(one(root, 'Forward')),
    false,
    'Forward stays disabled.',
  );
});

test('pressing Back calls back() once and pressing Forward calls forward() once', async () => {
  const fake = fakeNavigation({ canGoBack: true, canGoForward: true });
  layoutServices.setLayoutServices(fake.services);
  const root = await renderHeader({ load: realLoad, historyMethods: true });

  one(root, 'Back').click();
  await settle();
  assert.deepEqual(fake.calls, ['back']);

  one(root, 'Forward').click();
  await settle();
  assert.deepEqual(fake.calls, ['back', 'forward']);
});

test('Back and Forward sit together in one group, Back first', async () => {
  const fake = fakeNavigation({ canGoBack: true, canGoForward: true });
  layoutServices.setLayoutServices(fake.services);
  const root = await renderHeader({ load: realLoad, historyMethods: true });

  const group = one(root, 'Back').closest('[role="group"]');
  assert.ok(group !== null, 'Back is not in a group.');
  assert.deepEqual(
    [...group.querySelectorAll('button')].map((button) =>
      button.getAttribute('aria-label'),
    ),
    ['Back', 'Forward'],
  );
});
