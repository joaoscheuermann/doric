// The Files view over the real sandbox store, whose tree is read per
// directory: the root's rows show first, a folder opened before its children
// were read draws one "Loading…" line under it until they arrive, and Reveal
// in Files, which opens a whole chain of folders, reads it in one call. The host is a fake `files/v1.directories` over an
// in-memory workspace that records each call and can hold its answer.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import type { DirectoryListing } from '../../src/client/reads/project-files.js';
import { type Rendered, render, settle } from './support/render.js';

let rendered: Rendered | undefined;

afterEach(async () => {
  rendered?.cleanup();
  rendered = undefined;
  document.body.replaceChildren();
  const { setFilesClient } = await import('../../src/client/state.js');
  const { resetExpansion } = await import(
    '../../src/client/stores/expansion.js'
  );
  setFilesClient(undefined);
  resetExpansion();
});

const WORKSPACE: Record<string, readonly string[]> = {
  '': ['apps', 'README.md'],
  apps: ['web'],
  'apps/web': ['src', 'package.json'],
  'apps/web/src': ['main.tsx'],
};

type Host = {
  readonly calls: (readonly string[])[];
  hold: boolean;
  release(): void;
};

const setup = async (): Promise<{
  readonly host: Host;
  readonly services: import('bundle/contracts').Services;
}> => {
  let waiting: (() => void)[] = [];
  const host: Host = {
    calls: [],
    hold: false,
    release: () => {
      const answers = waiting;
      waiting = [];
      for (const answer of answers) answer();
    },
  };
  const services = await (async () => {
    const { createSandboxStore } = await import(
      '../../src/client/sandbox-store.js'
    );
    const { setFilesClient } = await import('../../src/client/state.js');
    const fixtures = await import('../../stories/support/fixtures.js');
    const { still, storyServices } = await import(
      '../../stories/support/services.js'
    );
    const store = createSandboxStore(() => ({
      tree: async () => {
        throw new Error('The tree is not read whole.');
      },
      file: async () => ({ status: 'not_found' }),
      directories: async (_projectId, paths) => {
        host.calls.push([...paths]);
        if (host.hold)
          await new Promise<void>((resolve) => waiting.push(resolve));
        const directories: Record<string, DirectoryListing> = {};
        for (const path of paths) {
          const names = WORKSPACE[path];
          directories[path] =
            names === undefined
              ? { status: 'not_found' }
              : {
                  status: 'listed',
                  entries: names.map((name) => {
                    const child = path === '' ? name : `${path}/${name}`;
                    return {
                      name,
                      path: child,
                      type:
                        WORKSPACE[child] === undefined ? 'file' : 'directory',
                    };
                  }),
                };
        }
        return { status: 'ready', directories };
      },
    }));
    setFilesClient({
      store,
      coordinator: {
        register: () => ({ dispose: () => undefined }),
        request: () => undefined,
        setWorkspace: () => undefined,
        dispose: () => undefined,
      },
    });
    let current: string | undefined;
    return storyServices({
      apis: {
        'layout.workspace/v1': {
          ...still,
          selection: () => ({
            project: fixtures.project,
            thread: { ...fixtures.thread, cwd: '/workspace' },
          }),
        },
        'layout.tabs/v1': {
          ...still,
          focus: async ({ id }: { readonly id: string }) => {
            current = id;
          },
          current: () => (current === undefined ? undefined : { id: current }),
        },
        'layout.panel/v2': { ...still, select: () => undefined },
        'commands/v1': { execute: async () => undefined },
      },
    });
  })();
  rendered = await render(async () => {
    const { createElement } = await import('react');
    const { SidebarScope } = await import('desktop/ui/sidebar');
    const { FilesTreeView } = await import(
      '../../src/client/tree/files-tree.js'
    );
    return createElement(
      SidebarScope,
      null,
      createElement(FilesTreeView, { services }),
    );
  });
  return { host, services };
};

const row = (name: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(
    `[role="tree"] [role="treeitem"][aria-label="${name}"]`,
  );

const text = (): string =>
  (document.querySelector('[role="tree"]')?.textContent ?? '').replace(
    /\s+/g,
    ' ',
  );

describe('the Files view reads its tree per directory', () => {
  test('shows the root, then a Loading line under a folder until its children arrive', async () => {
    const { loadingDirectoryNotice } = await import('desktop/ui/panels');
    const { host } = await setup();

    assert.deepEqual(host.calls, [['']]);
    assert.ok(row('apps'));
    assert.ok(row('README.md'));
    assert.equal(row('web'), null);

    host.hold = true;
    row('apps')?.click();
    await settle();

    assert.deepEqual(host.calls.at(-1), ['apps']);
    assert.ok(text().includes(loadingDirectoryNotice));
    assert.equal(row('apps')?.getAttribute('aria-busy'), 'true');

    host.release();
    await settle();

    assert.ok(row('web'));
    assert.ok(!text().includes(loadingDirectoryNotice));
  });

  test('Reveal in Files reads the revealed chain in one call and opens it', async () => {
    const { host, services } = await setup();
    host.calls.length = 0;
    const { fileTab } = await import('../../src/client/commands.js');
    const path = 'apps/web/src/main.tsx';
    const tab = fileTab({ projectId: 'prj_checkout', path }, services);

    tab.menu?.find((item) => item.label === 'Reveal in Files')?.run();
    await settle();

    assert.equal(host.calls.length, 1);
    assert.deepEqual([...(host.calls[0] ?? [])].sort(), [
      'apps',
      'apps/web',
      'apps/web/src',
    ]);
    assert.equal(row('apps')?.getAttribute('aria-expanded'), 'true');
    assert.equal(row('web')?.getAttribute('aria-expanded'), 'true');
  });
});
