// A6 (ui-redesign §4.4, T-4.4.1): a comparison tab's context menu holds
// "Open file", which runs `files.open-file/v1` with the compared workspace
// path, the command the diff toolbar's Open file runs. The entry is fixed
// when the tab opens, before the diff is read, so a deleted file's tab has it
// too: `files.open-file/v1` then opens a tab that shows "This file cannot be
// shown" (the files bundle's not-found view).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CommandsV1,
  commandsMethods,
  defineMethod,
  defineService,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import {
  LayoutTabsV1,
  layoutTabsMethods,
  type TabRequest,
} from 'layout/contracts';
import { FileIcon } from 'lucide-react';
import { isValidElement } from 'react';

import { openComparisonCommand } from '../../src/client/commands.js';

const setup = () => {
  const opened: TabRequest[] = [];
  const executed: (readonly [unknown, unknown])[] = [];
  const harness = createTestServices({
    bundle: { id: 'git-client' },
    provide: [
      defineService(LayoutTabsV1.id, {
        open: defineMethod({
          ...layoutTabsMethods.open,
          execute: async (request: TabRequest) => {
            opened.push(request);
          },
        }),
      }),
      defineService(CommandsV1.id, {
        register: defineMethod({
          ...commandsMethods.register,
          execute: () => ({ dispose: () => undefined }),
        }),
        execute: defineMethod({
          ...commandsMethods.execute,
          execute: async ([id, input]: [unknown, unknown?]) => {
            executed.push([id, input]);
          },
        }),
      }),
    ],
  });
  const open = async (input: {
    readonly repository: string;
    readonly path: string;
  }): Promise<TabRequest> => {
    await openComparisonCommand.execute(
      openComparisonCommand.input.parse({ projectId: 'project-1', ...input }),
      harness.call({}),
      harness.services,
    );
    const tab = opened.at(-1);
    assert.ok(tab, 'a tab opened');
    return tab;
  };
  return { open, executed, dispose: harness.dispose };
};

/** Waits for the command a menu entry started. */
const settle = () => new Promise<void>((done) => setImmediate(done));

describe('A6 Open file on a comparison tab', () => {
  for (const [kind, path] of [
    ['changed', 'src/main.ts'],
    ['deleted', 'src/removed.ts'],
  ] as const) {
    test(`a ${kind} file's tab opens the file at its workspace path`, async (t) => {
      const { open, executed, dispose } = setup();
      t.after(dispose);

      const tab = await open({ repository: 'packages/app', path });
      assert.deepEqual(
        tab.menu?.map(({ label, destructive }) => ({ label, destructive })),
        [{ label: 'Open file', destructive: undefined }],
      );
      // Figma's ViewerTabDiff "Open file" leads with lucide `file` (S6).
      const icon = (tab.menu?.[0] as { icon?: unknown } | undefined)?.icon;
      assert.ok(isValidElement(icon), 'the entry carries a React element icon');
      assert.equal(icon.type, FileIcon);
      tab.menu?.[0]?.run();
      await settle();

      assert.deepEqual(executed, [
        [
          'files.open-file/v1',
          { projectId: 'project-1', path: `packages/app/${path}` },
        ],
      ]);
    });
  }

  test('a file of the root repository opens at its own path', async (t) => {
    const { open, executed, dispose } = setup();
    t.after(dispose);

    const tab = await open({ repository: '', path: 'README.md' });
    tab.menu?.[0]?.run();
    await settle();

    assert.deepEqual(executed, [
      ['files.open-file/v1', { projectId: 'project-1', path: 'README.md' }],
    ]);
  });
});
