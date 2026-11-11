// The Screens pane as the sidebar mounts it: the element's own React root and
// its reads of `layout.workspace/v1`, the rows of the current Project's views,
// and the header element that opens another view.
//
// The layout draws the group's frame — header, collapse control and panel
// (`layout.stack/v2`) — so these elements draw only the rows and the add
// control. The layout rebuilds its records on every read, so a read whose
// snapshot identity changes on every call makes `useSyncExternalStore`
// re-render without end — React's "Maximum update depth exceeded" (#185) — and
// a sidebar row's own controls need the sidebar scope the element's root does
// not inherit from the layout (D9-17, as `git` and `files` wrap theirs).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';

import type { ClientContext, Services } from 'bundle/contracts';
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

/** The services stub: only what the elements' hooks reach, by contract. */
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

const other: ScreenView = {
  id: 'v2',
  label: 'Elsewhere',
  projectId: 'p2',
  status: { kind: 'waiting' },
};

/** The layout's records: a fresh object per read, as it builds them. */
const workspaceFor = (project?: {
  readonly id: string;
  readonly name: string;
}) => {
  let selections = 0;

  return {
    selectedThread: () =>
      project === undefined ? undefined : { id: 't1', projectId: project.id },
    selection: () => {
      selections += 1;

      return project === undefined
        ? {}
        : { project, thread: { id: 't1', projectId: project.id } };
    },
    subscribe: () => ({ dispose: () => undefined }),
    reads: () => selections,
  };
};

let tag = 0;

type ElementName = 'sidebar' | 'groupAction';

const mount = (
  render: ElementName,
  options: {
    readonly added?: unknown[];
    readonly views: readonly ScreenView[];
    readonly workspace: ReturnType<typeof workspaceFor>;
  },
) => {
  const { added = [], views, workspace } = options;
  const store = createScreenViewsStore();
  store.set(views);

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
  const name = `screen-pane-${tag++}`;
  window.customElements.define(
    name,
    defineScreenElements({ store })[render] as never,
  );
  const element = window.document.createElement(
    name,
  ) as unknown as ReactElementInstance;
  element.services = services;

  return { added, element, name, workspace };
};

const mountIn = async (
  render: ElementName,
  options: Parameters<typeof mount>[1],
) => {
  const mounted = mount(render, options);

  await act(() => {
    (window.document.body as unknown as HTMLElement).appendChild(
      mounted.element,
    );
  });

  return mounted;
};

test('the rows element draws the current Project views only', async () => {
  const workspace = workspaceFor({ id: 'p1', name: 'Doric' });
  const { element } = await mountIn('sidebar', {
    views: [view, other],
    workspace,
  });

  try {
    // The pane carries no header of its own: the layout draws it.
    assert.doesNotMatch(element.textContent ?? '', /Screens/);
    assert.match(element.textContent ?? '', /Doric/);
    assert.doesNotMatch(element.textContent ?? '', /Elsewhere/);
    // A read that keeps its identity settles after a handful of them; the loop
    // this guards against reads thousands.
    assert.ok(
      workspace.reads() < 50,
      `selection() was read ${workspace.reads()} times`,
    );
  } finally {
    await act(() => element.dispose());
    window.document.body.replaceChildren();
  }
});

test('the rows element shows nothing without a selected Project', async () => {
  const { element } = await mountIn('sidebar', {
    views: [view, other],
    workspace: workspaceFor(undefined),
  });

  try {
    assert.doesNotMatch(element.textContent ?? '', /Doric|Elsewhere/);
  } finally {
    await act(() => element.dispose());
    window.document.body.replaceChildren();
  }
});

test('the header element opens the selected Project screen', async () => {
  const added: unknown[] = [];
  const { element } = await mountIn('groupAction', {
    added,
    views: [view],
    workspace: workspaceFor({ id: 'p1', name: 'Doric' }),
  });

  try {
    assert.equal(ScreenViewsV1.id, 'screen.views/v1');
    const action = element.querySelector('[aria-label="New screen view"]');
    assert.notEqual(action, null);

    await act(() => {
      (action as unknown as { click(): void }).click();
    });

    assert.deepEqual(added, [{ projectId: 'p1', label: 'Doric' }]);
  } finally {
    await act(() => element.dispose());
    window.document.body.replaceChildren();
  }
});

test('the header element cannot open a screen without a Project', async () => {
  const added: unknown[] = [];
  const { element } = await mountIn('groupAction', {
    added,
    views: [view],
    workspace: workspaceFor(undefined),
  });

  try {
    const action = element.querySelector(
      '[aria-label="New screen view"]',
    ) as unknown as { disabled: boolean; click(): void };

    assert.equal(action.disabled, true);
    await act(() => action.click());
    assert.deepEqual(added, []);
  } finally {
    await act(() => element.dispose());
    window.document.body.replaceChildren();
  }
});

// T-3.7 (sidebar alignment §9.4, G-d): activating registers the Screens pane
// in the layout's stack through `layout.stack/v2`, as a group with no size.
test('activating registers the Screens pane through layout.stack/v2, without sizes', async () => {
  const { activate } = await import('../../src/client/index.js');
  const idOf = (contract: unknown): string | undefined =>
    (contract as { readonly id?: string }).id;
  const registered: Record<string, unknown>[] = [];
  const stack = {
    register: (pane: Record<string, unknown>) => {
      registered.push(pane);
      return {
        dispose: () => {
          registered.splice(registered.indexOf(pane), 1);
        },
      };
    },
  };
  const services = {
    provide: () => ({ dispose: () => undefined }),
    use: (contract: unknown) =>
      idOf(contract) === 'ui/v1'
        ? { define: () => ({ dispose: () => undefined }) }
        : undefined,
    // Only the stack is available: the desktop part's views never appear.
    whenAvailable: (
      contract: unknown,
      callback: (api: unknown, provider: unknown) => unknown,
    ) => {
      if (idOf(contract) !== 'layout.stack/v2')
        return { dispose: () => undefined };
      const cleanup = callback(stack, { bundleId: 'layout', version: '3.0.0' });
      return {
        dispose: () => {
          if (typeof cleanup === 'function') (cleanup as () => void)();
        },
      };
    },
  } as unknown as Services;

  const cleanup = activate({ services } as ClientContext);
  try {
    assert.deepEqual(
      registered.map((pane) => pane.id),
      ['screen-sidebar'],
      'The Screens pane is not registered once through layout.stack/v2.',
    );
    const [pane] = registered;
    assert.ok(pane);
    assert.equal('minSize' in pane, false, 'The Screens pane has a minSize.');
    assert.equal('maxSize' in pane, false, 'The Screens pane has a maxSize.');
  } finally {
    if (typeof cleanup === 'function') await cleanup();
  }
});

// T-3.8 (sidebar alignment §9.4): the pane is registered through
// `layout.stack/v2`, so the manifest requires it and no longer v1.
test('the screen manifest is 2.0.1 and requires layout.stack/v2@^2.0.0, not v1', () => {
  const manifest = JSON.parse(
    readFileSync('bundles/features/screen/manifest.json', 'utf8'),
  ) as { version: string; requires: string[] };

  assert.equal(manifest.version, '2.0.1');
  assert.ok(manifest.requires.includes('layout.stack/v2@^2.0.0'));
  assert.ok(
    !manifest.requires.some((entry) => entry.startsWith('layout.stack/v1@')),
    'The screen bundle still requires layout.stack/v1.',
  );
});
