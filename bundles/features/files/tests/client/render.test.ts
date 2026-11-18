// The Files view of the Project panel rendered in happy-dom over the stories'
// fakes: the layout's selection, the files client's tree read and the
// expansion store. Smoke test of the client test setup (Part 4.4b).

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { type Rendered, render, settle } from './support/render.js';

let rendered: Rendered | undefined;

afterEach(() => {
  rendered?.cleanup();
  rendered = undefined;
});

/** What `commands/v1` was asked to execute, in order. */
type Executed = { readonly id: string; readonly input: unknown };

const renderTree = async (): Promise<{
  readonly view: Rendered;
  readonly executed: readonly Executed[];
}> => {
  const executed: Executed[] = [];
  const view = await render(async () => {
    const { createElement } = await import('react');
    const { SidebarScope } = await import('desktop/ui/sidebar');
    const { FilesTreeView } = await import(
      '../../src/client/tree/files-tree.js'
    );
    const { seedExpansion, seedFilesClient } = await import(
      '../../stories/support/files-client.js'
    );
    const { openDirectories, project, thread, workspaceTree } = await import(
      '../../stories/support/fixtures.js'
    );
    const { still, storyServices } = await import(
      '../../stories/support/services.js'
    );
    seedFilesClient({
      read: { status: 'ready', value: workspaceTree },
      fetching: false,
    });
    const { rootOf } = await import('../../src/client/sandbox-store.js');
    seedExpansion(project.id, rootOf(thread.cwd), openDirectories);
    const services = storyServices({
      apis: {
        'layout.workspace/v1': {
          ...still,
          selection: () => ({ project, thread }),
        },
        'layout.tabs/v2': { ...still, current: () => undefined },
        'commands/v1': {
          execute: async (id: string, input: unknown) => {
            executed.push({ id, input });
          },
        },
      },
    });
    return createElement(
      SidebarScope,
      null,
      createElement(FilesTreeView, { services }),
    );
  });
  rendered = view;
  return { view, executed };
};

/** The tree's rows named `name`. */
const rowsNamed = (root: HTMLElement, name: string): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(
    `[role="tree"] [role="treeitem"][aria-label="${name}"]`,
  ),
];

test('the Files view lists the opened directories and opens a file on click', async () => {
  const { view, executed } = await renderTree();

  assert.equal(rowsNamed(view.root, 'payment-form.tsx').length, 1);
  assert.equal(
    rowsNamed(view.root, 'totals.ts').length,
    0,
    'a file in a closed directory is not listed',
  );

  rowsNamed(view.root, 'payment-form.tsx')[0]?.click();
  await settle();

  assert.deepEqual(executed, [
    {
      id: 'files.open-file/v1',
      input: {
        projectId: 'prj_checkout',
        path: 'apps/web/src/checkout/payment-form.tsx',
      },
    },
  ]);
});

test('T-4.5: the Files tree scrolls sideways: no clipped viewport and a list as wide as its rows', async () => {
  const { view } = await renderTree();

  const tree = view.root.querySelector<HTMLElement>('[role="tree"]');
  assert.ok(tree, 'the view draws no tree');
  assert.ok(tree.classList.contains('w-max'), tree.className);
  assert.ok(tree.classList.contains('min-w-full'), tree.className);

  const area = tree.closest<HTMLElement>('[data-slot="scroll-area"]');
  assert.ok(area, 'the tree is not in a scroll area');
  const viewport = area.querySelector<HTMLElement>(
    '[data-slot="scroll-area-viewport"]',
  );
  assert.ok(viewport, 'the scroll area has no viewport');
  for (const element of [area, viewport]) {
    assert.ok(
      !element.className.includes('overflow-x-hidden'),
      `the viewport clips sideways: ${element.className}`,
    );
  }
});

/** What the files client part's activation asked of its fake services. */
type Activation = {
  readonly selected: readonly string[];
  readonly defined: readonly string[];
  readonly added: readonly {
    readonly region: string;
    readonly item: unknown;
  }[];
  readonly cleanup: () => void;
};

/** Activates the files client part over fakes, `layout.panel/v3` among them. */
const activateClient = async (): Promise<Activation> => {
  const { installWindow } = await import('./support/render.js');
  installWindow();
  const { still, storyServices } = await import(
    '../../stories/support/services.js'
  );
  const { activate } = await import('../../src/client/index.js');
  const disposed = { dispose: () => undefined };
  const selected: string[] = [];
  const defined: string[] = [];
  const added: { region: string; item: unknown }[] = [];
  const services = storyServices({
    apis: {
      'ui/v1': {
        define: (tag: string) => {
          defined.push(tag);
          return disposed;
        },
      },
      'commands/v1': { register: () => disposed },
      'regions/v1': {
        add: (region: string, item: unknown) => {
          added.push({ region, item });
          return disposed;
        },
      },
      'hooks/v1': { whenAvailable: () => disposed },
      'layout.panel/v3': {
        ...still,
        select: (id: string) => {
          selected.push(id);
        },
      },
    },
  });
  const cleanup = activate({ services } as unknown as Parameters<
    typeof activate
  >[0]);
  return {
    selected,
    defined,
    added,
    cleanup: () => {
      if (typeof cleanup === 'function') cleanup();
    },
  };
};

// Bundle isolation 4(a) change 3 (T4.5, the files part): layout.panel/v3
// starts with no view, so the files client part selects its own when it
// activates.
test('T4.5: the files client part selects the Files view once, through layout.panel/v3, when it activates', async (t) => {
  const activation = await activateClient();
  t.after(activation.cleanup);

  assert.deepEqual(activation.selected, ['files']);
});

// Bundle isolation 4(a) change 3: the Files view's icon in the panel is the
// element `files-file-icon`, which the files client part defines; the panel
// item names no `icon` kind.
test('the Files panel item is drawn with the files-file-icon element the client part defines', async (t) => {
  const activation = await activateClient();
  t.after(activation.cleanup);

  assert.ok(
    activation.defined.includes('files-file-icon'),
    `defined: ${activation.defined.join(', ')}`,
  );
  assert.deepEqual(
    activation.added
      .filter(({ region }) => region === 'shell.panel')
      .map(({ item }) => (item as { readonly props?: unknown }).props),
    [{ label: 'Files', iconTag: 'files-file-icon' }],
  );
});
