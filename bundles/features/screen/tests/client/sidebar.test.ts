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
    /** Records `remove` and `retry` calls as `[method, id]`. */
    readonly calls?: [string, unknown][];
    readonly views: readonly ScreenView[];
    readonly workspace: ReturnType<typeof workspaceFor>;
    /** Serves no `screen.views/v1`, which disables every row. */
    readonly withoutScreens?: boolean;
  },
) => {
  const {
    added = [],
    calls = [],
    views,
    workspace,
    withoutScreens = false,
  } = options;
  const store = createScreenViewsStore();
  store.set(views);

  const screens = {
    add: async (input: unknown) => {
      added.push(input);

      return view;
    },
    open: async () => undefined,
    remove: async (id: unknown) => {
      calls.push(['remove', id]);
    },
    retry: async (id: unknown) => {
      calls.push(['retry', id]);
    },
  };
  const services = servicesFor((contract) =>
    contract === LayoutWorkspaceV1
      ? workspace
      : withoutScreens
        ? undefined
        : screens,
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
    // No Project, no notice: the pane is empty, as the MCP pane's is.
    assert.doesNotMatch(element.textContent ?? '', /No screens open/);
    assert.equal((element.textContent ?? '').trim(), '');
    assert.equal(element.querySelectorAll('li').length, 0);
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

// Sidebar alignment, rows (spec: docs/designs/sidebar-alignment.md §9.5,
// pane rows): the row's icon on the header chevron's
// column, its label and status to the right edge, and its actions laid over
// that edge on hover or focus, in place of the status. happy-dom computes no
// layout, so the look is observable only as the classes that draw it.

/** The classes of `classes` that `element` does not carry. */
const missingClasses = (element: Element, classes: string): string[] =>
  classes
    .split(/\s+/)
    .filter((name) => name !== '' && !element.classList.contains(name));

const classesOf = (element: Element): string[] =>
  (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

/** The Thread row's hover reveal, on the menu item. */
const ON_HOVER =
  'pointer-events-none opacity-0 after:inset-0 group-hover/menu-item:pointer-events-auto group-hover/menu-item:opacity-100 group-has-[:focus-visible]/menu-item:pointer-events-auto group-has-[:focus-visible]/menu-item:opacity-100';

/** A row action's paper hover square and outline (spec §11, T-5.9). */
const ACTION_STATES =
  'hover:bg-[var(--paper-ghost-pressed)] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-[var(--sidebar-ring)]';

const failed: ScreenView = {
  id: 'v3',
  label: 'Inspector',
  projectId: 'p1',
  status: { kind: 'failed' },
};

/** The row (`li`) whose text holds `label`. */
const rowNamed = (root: Element, label: string): HTMLElement => {
  const row = [...root.querySelectorAll('li')].find((item) =>
    (item.textContent ?? '').includes(label),
  );
  assert.ok(row !== undefined, `No row for "${label}".`);
  return row as unknown as HTMLElement;
};

/** The row's own menu button. */
const rowButton = (root: Element, label: string): HTMLElement => {
  const button = rowNamed(root, label).querySelector(
    '[data-slot="sidebar-menu-button"]',
  );
  assert.ok(button !== null, `The row for "${label}" has no menu button.`);
  return button as unknown as HTMLElement;
};

/** The button under `root` labelled `name`, if any. */
const findButton = (root: Element, name: string): HTMLElement | undefined =>
  [...root.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === name,
  ) as unknown as HTMLElement | undefined;

const buttonNamed = (root: Element, name: string): HTMLElement => {
  const button = findButton(root, name);
  assert.ok(button !== undefined, `No button named "${name}".`);
  return button;
};

const withRows = async (
  views: readonly ScreenView[],
  check: (
    element: HTMLElement,
    calls: [string, unknown][],
  ) => Promise<void> | void,
  project: { readonly id: string; readonly name: string } | undefined = {
    id: 'p1',
    name: 'Doric',
  },
): Promise<void> => {
  const calls: [string, unknown][] = [];
  const { element } = await mountIn('sidebar', {
    calls,
    views,
    workspace: workspaceFor(project),
  });

  try {
    await check(element as unknown as HTMLElement, calls);
  } finally {
    await act(() => element.dispose());
    window.document.body.replaceChildren();
  }
};

test("a view row's icon sits on the chevron column and its label runs to the right edge", async () => {
  await withRows([view, failed], (element) => {
    for (const label of ['Doric', 'Inspector']) {
      const button = rowButton(element, label);
      assert.deepEqual(
        missingClasses(
          button,
          'pl-1.5 pr-2.5 rounded-[4px] group-has-data-[sidebar=menu-action]/menu-item:pr-2.5',
        ),
        [],
        `The ${label} row is not aligned.`,
      );
      assert.deepEqual(
        classesOf(button).filter((name) =>
          ['pl-3', 'pr-8', 'pr-14'].includes(name),
        ),
        [],
        `The ${label} row keeps room for its actions.`,
      );
    }
  });
});

test("a ready row's Remove is laid over the right edge on hover or focus", async () => {
  await withRows([view], (element) => {
    const remove = buttonNamed(rowNamed(element, 'Doric'), 'Remove Doric');
    assert.deepEqual(missingClasses(remove, `right-1 ${ON_HOVER}`), []);
    assert.equal(remove.style.top, '0.25rem');
    assert.equal(remove.classList.contains('md:opacity-0'), false);
    assert.deepEqual(
      missingClasses(
        remove,
        `${ACTION_STATES} focus-visible:ring-2 ring-sidebar-ring`,
      ),
      [],
    );
    assert.equal(remove.classList.contains('hover:bg-sidebar-accent'), false);
  });
});

test("a failed row's Retry sits left of Remove, revealed with it; a ready row has none", async () => {
  await withRows([view, failed], (element) => {
    const retry = buttonNamed(
      rowNamed(element, 'Inspector'),
      'Retry Inspector',
    );
    assert.deepEqual(missingClasses(retry, `right-7 ${ON_HOVER}`), []);
    assert.equal(retry.style.top, '0.25rem');
    assert.deepEqual(
      missingClasses(
        retry,
        `${ACTION_STATES} focus-visible:ring-2 ring-sidebar-ring`,
      ),
      [],
    );
    assert.equal(retry.classList.contains('hover:bg-sidebar-accent'), false);
    assert.equal(
      findButton(rowNamed(element, 'Doric'), 'Retry Doric'),
      undefined,
    );
  });
});

test("a row's status fades out while its actions show", async () => {
  await withRows([view], (element) => {
    const status = [
      ...rowButton(element, 'Doric').querySelectorAll('span'),
    ].find((span) => span.textContent === ':1');
    assert.ok(status !== undefined, 'The Doric row shows no status.');
    assert.deepEqual(
      missingClasses(
        status as unknown as Element,
        'group-hover/menu-item:opacity-0 group-has-[:focus-visible]/menu-item:opacity-0',
      ),
      [],
    );
  });
});

// Phase 5 (docs/designs/sidebar-alignment.md §11.6, D24; T-5.9, T-5.14): a
// view row's item takes the unselected fill and the outline keyed on its menu
// button; the button draws no fill or ring; reveals follow keyboard focus only.
const UNSELECTED_FILL =
  'rounded-[4px] hover:bg-[var(--paper-ghost-hover)] active:bg-[var(--paper-ghost-pressed)]';
const MENU_BUTTON_RING =
  'has-[[data-slot=sidebar-menu-button]:focus-visible]:outline-2 has-[[data-slot=sidebar-menu-button]:focus-visible]:-outline-offset-2 has-[[data-slot=sidebar-menu-button]:focus-visible]:outline-[var(--sidebar-ring)]';
const NO_FILL_BUTTON =
  'bg-transparent hover:bg-transparent active:bg-transparent data-active:bg-transparent focus-visible:ring-0';

test('T-5.9: each view row has the unselected fill and the menu-button ring; its button draws no fill', async () => {
  await withRows([view, failed], (element) => {
    for (const label of ['Doric', 'Inspector']) {
      const row = rowNamed(element, label);
      assert.deepEqual(
        missingClasses(row, `${UNSELECTED_FILL} ${MENU_BUTTON_RING}`),
        [],
        `The ${label} row lacks its states.`,
      );
      assert.equal(row.classList.contains('bg-sidebar-accent'), false);
      const button = rowButton(element, label);
      assert.deepEqual(missingClasses(button, NO_FILL_BUTTON), []);
      assert.deepEqual(
        classesOf(button).filter((name) =>
          [
            'hover:bg-sidebar-accent',
            'active:bg-sidebar-accent',
            'data-active:bg-sidebar-accent',
            'focus-visible:ring-2',
            'hover:text-sidebar-foreground',
            'group-hover/menu-item:bg-sidebar-accent',
            'group-focus-within/menu-item:bg-sidebar-accent',
          ].includes(name),
        ),
        [],
        `The ${label} button keeps a fill or ring of its own.`,
      );
    }
  });
});

test('T-5.9: a disabled row, without the screens service, takes no fill or ring', async () => {
  const { element } = await mountIn('sidebar', {
    views: [view, failed],
    workspace: workspaceFor({ id: 'p1', name: 'Doric' }),
    withoutScreens: true,
  });
  try {
    const root = element as unknown as HTMLElement;
    for (const label of ['Doric', 'Inspector']) {
      const row = rowNamed(root, label);
      assert.ok(
        rowButton(root, label).hasAttribute('disabled') ||
          rowButton(root, label).hasAttribute('data-disabled') ||
          rowButton(root, label).getAttribute('aria-disabled') === 'true',
        `The ${label} row is not disabled without the screens service.`,
      );
      assert.deepEqual(
        classesOf(row).filter(
          (name) =>
            name === 'rounded-[4px]' ||
            name.startsWith('hover:bg-[') ||
            name.startsWith('active:bg-[') ||
            name.startsWith('has-['),
        ),
        [],
        `The disabled ${label} row takes the row states.`,
      );
    }
  } finally {
    await act(() => element.dispose());
    window.document.body.replaceChildren();
  }
});

test('T-5.14: no view row reveals on focus-within', async () => {
  await withRows([view, failed], (element) => {
    for (const label of ['Doric', 'Inspector']) {
      const row = rowNamed(element, label);
      assert.deepEqual(
        [row, ...row.querySelectorAll('*')].flatMap((node) =>
          classesOf(node).filter((name) =>
            name.startsWith('group-focus-within/menu-item:'),
          ),
        ),
        [],
        `The ${label} row reveals on focus-within.`,
      );
    }
  });
});

test("a row's Remove and Retry act on its view", async () => {
  await withRows([view, failed], async (element, calls) => {
    await act(() => {
      buttonNamed(rowNamed(element, 'Doric'), 'Remove Doric').click();
    });
    await act(() => {
      buttonNamed(rowNamed(element, 'Inspector'), 'Retry Inspector').click();
    });
    assert.deepEqual(calls, [
      ['remove', 'v1'],
      ['retry', 'v3'],
    ]);
  });
});

test('an open pane with no views for the Project says so, and not once one is open', async () => {
  await withRows([other], (element) => {
    assert.equal((element.textContent ?? '').trim(), 'No screens open');
    assert.equal(element.querySelectorAll('li').length, 0);
  });
  await withRows([view, other], (element) => {
    assert.doesNotMatch(element.textContent ?? '', /No screens open/);
    assert.equal(element.querySelectorAll('li').length, 1);
  });
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
test('the screen manifest is 2.0.3 and requires layout.stack/v2@^2.0.0, not v1', () => {
  const manifest = JSON.parse(
    readFileSync('bundles/features/screen/manifest.json', 'utf8'),
  ) as { version: string; requires: string[] };

  assert.equal(manifest.version, '2.0.3');
  assert.ok(manifest.requires.includes('layout.stack/v2@^2.0.0'));
  assert.ok(
    !manifest.requires.some((entry) => entry.startsWith('layout.stack/v1@')),
    'The screen bundle still requires layout.stack/v1.',
  );
});
