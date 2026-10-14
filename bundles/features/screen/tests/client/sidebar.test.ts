// The Screens group as the sidebar mounts it: the element's own React root,
// its reads of `layout.workspace/v1` and of the views mirror, and the row it
// draws.
//
// The layout rebuilds its records on every read, so a read whose snapshot
// identity changes on every call makes `useSyncExternalStore` re-render
// without end — React's "Maximum update depth exceeded" (#185) — and a
// sidebar row's own controls need the sidebar scope the element's root does
// not inherit from the layout (D9-17, as `git` and `files` wrap theirs).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import type { Services } from 'bundle/contracts';
import type { ReactElementInstance } from 'desktop/ui';
import { Window } from 'happy-dom';

import type { ScreenView } from '../../src/contracts/index.js';

const window = new Window();
const globals = globalThis as unknown as Record<string, unknown>;
const installed = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLIFrameElement',
  'Node',
  'Element',
  'Event',
  'customElements',
  'MutationObserver',
] as const;

let act: (callback: () => void | Promise<void>) => Promise<void>;
let defineScreenElements: typeof import('../../src/client/elements.js')['defineScreenElements'];
let createScreenViewsStore: typeof import('../../src/client/store.js')['createScreenViewsStore'];
let LayoutWorkspaceV1: typeof import('../../src/client/peers.js')['LayoutWorkspaceV1'];
let ScreenViewsV1: typeof import('../../src/contracts/index.js')['ScreenViewsV1'];

before(async () => {
  for (const name of installed) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: window[name as keyof Window],
      writable: true,
    });
  }
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  act = (await import('react')).act;

  ({ defineScreenElements } = await import('../../src/client/elements.js'));
  ({ createScreenViewsStore } = await import('../../src/client/store.js'));
  ({ LayoutWorkspaceV1 } = await import('../../src/client/peers.js'));
  ({ ScreenViewsV1 } = await import('../../src/contracts/index.js'));
});

after(async () => {
  await window.happyDOM.abort();
  await window.happyDOM.close();
});

/** The services stub: only what the element's hooks reach, by contract. */
const servicesFor = (apiOf: (contract: unknown) => unknown): Services =>
  ({
    provide: () => ({ dispose: () => undefined }),
    use: (contract: unknown) => apiOf(contract),
    whenAvailable: (
      contract: unknown,
      callback: (api: unknown, provider: unknown) => unknown,
    ) => {
      const cleanup = callback(apiOf(contract), {
        bundleId: 'probe',
        version: '1.0.0',
      });

      return {
        dispose: () => {
          if (typeof cleanup === 'function') (cleanup as () => void)();
        },
      };
    },
  }) as unknown as Services;

const view: ScreenView = {
  id: 'v1',
  label: 'Doric',
  projectId: 'p1',
  status: { kind: 'ready', path: '/screen/token/', display: ':1' },
};

test('the Screens group mounts, settles and names a new view', async () => {
  const store = createScreenViewsStore();
  store.set([view]);

  const thread = { id: 't1', projectId: 'p1' };
  let selections = 0;
  const workspace = {
    // The layout's records: a fresh object per read, as it builds them.
    selectedThread: () => ({ ...thread }),
    selection: () => {
      selections += 1;

      return { project: { id: 'p1', name: 'Doric' }, thread: { ...thread } };
    },
    subscribe: () => ({ dispose: () => undefined }),
  };

  const added: unknown[] = [];
  const screens = {
    add: async (input: unknown) => {
      added.push(input);

      return view;
    },
    open: async () => undefined,
    remove: async () => undefined,
    retry: async () => undefined,
  };

  const services = servicesFor((contract) =>
    contract === LayoutWorkspaceV1 ? workspace : screens,
  );
  const tag = 'screen-sidebar-test';
  window.customElements.define(
    tag,
    defineScreenElements({ store }).sidebar as never,
  );
  const element = window.document.createElement(
    tag,
  ) as unknown as ReactElementInstance;
  element.services = services;

  try {
    await act(() => {
      (window.document.body as unknown as HTMLElement).appendChild(element);
    });

    assert.match(element.textContent ?? '', /Screens/);
    assert.match(element.textContent ?? '', /Doric/);
    // A read that keeps its identity settles after a handful of them; the
    // loop this guards against reads thousands.
    assert.ok(selections < 50, `selection() was read ${selections} times`);

    const action = element.querySelector('[aria-label="New screen view"]');
    assert.notEqual(action, null);
    await act(() => {
      (action as unknown as { click(): void }).click();
    });
    assert.deepEqual(added, [{ projectId: 'p1', label: 'Doric' }]);
    assert.equal(ScreenViewsV1.id, 'screen.views/v1');
  } finally {
    await act(() => element.dispose());
    window.document.body.replaceChildren();
  }
});
