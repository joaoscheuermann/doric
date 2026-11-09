// A5 "Reveal in Files" (§4.4, S16; T-4.4.1 for A5): the file tab the
// `files.open-file/v1` command opens carries one menu entry, a closure of the
// files bundle. Running it shows the Files panel, opens every ancestor
// directory of the file under the tree's root (the Thread's working
// directory) and selects the file's tab, so the tree selects the file's row.
// A file outside that root only shows the panel.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import type { Services } from 'bundle/contracts';
import type { Thread } from 'runtime/contracts';

import { installWindow, type Rendered, render } from './support/render.js';

let rendered: Rendered | undefined;

afterEach(() => {
  rendered?.cleanup();
  rendered = undefined;
  document.body.replaceChildren();
});

type Fakes = {
  readonly services: Services;
  readonly shown: string[];
  readonly focused: string[];
};

const fakes = async (thread: Thread): Promise<Fakes> => {
  installWindow();
  const fixtures = await import('../../stories/support/fixtures.js');
  const { still, storyServices } = await import(
    '../../stories/support/services.js'
  );
  const shown: string[] = [];
  const focused: string[] = [];
  let current: string | undefined;
  const services = storyServices({
    apis: {
      'layout.panel/v1': {
        ...still,
        show: (id: string) => {
          shown.push(id);
        },
      },
      'layout.workspace/v1': {
        ...still,
        selection: () => ({ project: fixtures.project, thread }),
      },
      'layout.tabs/v1': {
        ...still,
        focus: async ({ id }: { readonly id: string }) => {
          focused.push(id);
          current = id;
        },
        current: () => (current === undefined ? undefined : { id: current }),
      },
      'commands/v1': { execute: async () => undefined },
    },
  });
  return { services, shown, focused };
};

/** The open directories of the Project's tree rooted at `cwd`. */
const openOf = async (cwd: string): Promise<string[]> => {
  const { expansionScope, expansionStore } = await import(
    '../../src/client/stores/expansion.js'
  );
  const { rootOf } = await import('../../src/client/sandbox-store.js');
  const scope = expansionScope('prj_checkout', rootOf(cwd));
  return [...(expansionStore.getState().views[scope] ?? [])].sort();
};

/** Runs the file tab's "Reveal in Files" entry. */
const reveal = async (services: Services, path: string): Promise<void> => {
  const { fileTab } = await import('../../src/client/commands.js');
  const tab = fileTab({ projectId: 'prj_checkout', path }, services);
  assert.deepEqual(
    tab.menu?.map((item) => item.label),
    ['Reveal in Files'],
  );
  tab.menu?.find((item) => item.label === 'Reveal in Files')?.run();
};

describe('A5 Reveal in Files', () => {
  test('shows the Files panel, opens the file ancestors and selects its row', async () => {
    const fixtures = await import('../../stories/support/fixtures.js');
    const { resetExpansion } = await import(
      '../../src/client/stores/expansion.js'
    );
    resetExpansion();
    const { services, shown, focused } = await fakes(fixtures.thread);
    const path = 'apps/web/src/checkout/payment-form.tsx';

    await reveal(services, path);

    assert.deepEqual(shown, ['files']);
    assert.deepEqual(focused, [`file:${path}`]);
    assert.deepEqual(await openOf('/workspace'), [
      'apps',
      'apps/web',
      'apps/web/src',
      'apps/web/src/checkout',
    ]);

    rendered = await render(async () => {
      const { createElement } = await import('react');
      const { SidebarScope } = await import('desktop/ui/sidebar');
      const { FilesTreeView } = await import(
        '../../src/client/tree/files-tree.js'
      );
      const { seedFilesClient } = await import(
        '../../stories/support/files-client.js'
      );
      seedFilesClient({
        read: { status: 'ready', value: fixtures.workspaceTree },
        fetching: false,
      });
      return createElement(
        SidebarScope,
        null,
        createElement(FilesTreeView, { services }),
      );
    });
    const row = document.querySelector<HTMLElement>(
      '[role="tree"] [role="treeitem"][aria-label="payment-form.tsx"]',
    );
    assert.ok(row, 'the file row is listed');
    assert.equal(row.getAttribute('aria-selected'), 'true');
  });

  test('opens only the ancestors below the Thread working directory', async () => {
    const fixtures = await import('../../stories/support/fixtures.js');
    const { resetExpansion } = await import(
      '../../src/client/stores/expansion.js'
    );
    resetExpansion();
    const { services, shown } = await fakes(fixtures.nestedThread);

    await reveal(services, 'apps/web/src/checkout/payment-form.tsx');

    assert.deepEqual(shown, ['files']);
    assert.deepEqual(await openOf('/workspace/apps/web'), [
      'apps/web/src',
      'apps/web/src/checkout',
    ]);
  });

  test('a file outside the tree root only shows the panel', async () => {
    const fixtures = await import('../../stories/support/fixtures.js');
    const { resetExpansion } = await import(
      '../../src/client/stores/expansion.js'
    );
    resetExpansion();
    const { services, shown } = await fakes(fixtures.nestedThread);

    await reveal(services, 'packages/pricing/src/totals.ts');

    assert.deepEqual(shown, ['files']);
    assert.deepEqual(await openOf('/workspace/apps/web'), []);
  });
});
