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
        'layout.tabs/v1': { ...still, current: () => undefined },
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
