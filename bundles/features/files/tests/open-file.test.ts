// files.open-file/v1 (stage 10, §3.6): the command opens a sandbox file as a
// tab of the active owner, with the id, title, icon and tooltip the workspace's
// file tabs had (`file:<path>`, the file's name, the whole path), through a
// fake layout.tabs/v1 that keeps the tabs it was asked to open.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type BoundCommand,
  CommandsV1,
  ContractError,
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

import { filePathOf, openFileCommand } from '../src/client/commands.js';
import { OPEN_FILE_COMMAND } from '../src/contracts/index.js';

const setup = (owner: string | null = 'thread-1') => {
  const tabs: TabRequest[] = [];
  const commands = new Map<string, BoundCommand>();
  const harness = createTestServices({
    bundle: { id: 'files' },
    provide: [
      defineService(LayoutTabsV1, {
        open: defineMethod({
          ...layoutTabsMethods.open,
          execute: async (input: TabRequest) => {
            if (owner === null)
              throw new ContractError(
                'unavailable',
                'No thread or project is selected.',
              );
            if (!tabs.some((tab) => tab.id === input.id)) tabs.push(input);
          },
        }),
        close: defineMethod({
          ...layoutTabsMethods.close,
          execute: async () => undefined,
        }),
        focus: defineMethod({
          ...layoutTabsMethods.focus,
          execute: async () => undefined,
        }),
        current: defineMethod({
          ...layoutTabsMethods.current,
          execute: () => {
            const last = tabs.at(-1);
            return last === undefined ? undefined : { id: last.id };
          },
        }),
        subscribe: defineMethod({
          ...layoutTabsMethods.subscribe,
          execute: () => ({ dispose: () => undefined }),
        }),
      }),
      defineService(CommandsV1.id, {
        register: defineMethod({
          ...commandsMethods.register,
          execute: (command: BoundCommand) => {
            commands.set(command.id, command);
            return { dispose: () => commands.delete(command.id) };
          },
        }),
        execute: defineMethod({
          ...commandsMethods.execute,
          execute: async ([id, input]: [unknown, unknown?], call) => {
            const command = commands.get(id as string);
            if (command === undefined) throw new Error('unknown_command');
            await command.execute(command.input.parse(input), call);
          },
        }),
      }),
    ],
  });
  const registry = harness.services.use(CommandsV1);
  registry.register(openFileCommand);
  return { tabs, commands: registry, dispose: harness.dispose };
};

describe('files.open-file/v1', () => {
  test('opens the file as a tab named for it, with the whole path as its tooltip', async (t) => {
    const { tabs, commands, dispose } = setup();
    t.after(dispose);

    await commands.execute(OPEN_FILE_COMMAND, {
      projectId: 'p-1',
      path: 'src/deep/b.ts',
    });

    assert.deepEqual(tabs, [
      {
        id: 'file:src/deep/b.ts',
        title: 'b.ts',
        tag: 'files-file-view',
        props: { projectId: 'p-1', path: 'src/deep/b.ts' },
        icon: 'file',
        tooltip: 'src/deep/b.ts',
      },
    ]);
  });

  test('a file at the workspace root is titled by its own name', async (t) => {
    const { tabs, commands, dispose } = setup();
    t.after(dispose);

    await commands.execute(OPEN_FILE_COMMAND, {
      projectId: 'p-1',
      path: 'README.md',
    });

    assert.equal(tabs[0]?.id, 'file:README.md');
    assert.equal(tabs[0]?.title, 'README.md');
  });

  test('the current file tab names the row the tree selects; another tab names none', () => {
    assert.equal(filePathOf('file:src/a.ts'), 'src/a.ts');
    assert.equal(
      filePathOf(JSON.stringify(['diff', 'p-1', '', 'src/a.ts'])),
      undefined,
    );
    assert.equal(filePathOf('terminal:term-1'), undefined);
    assert.equal(filePathOf(undefined), undefined);
  });

  test('without a Thread or Project to own the tab, the command fails and opens nothing', async (t) => {
    const { tabs, commands, dispose } = setup(null);
    t.after(dispose);

    await assert.rejects(
      commands.execute(OPEN_FILE_COMMAND, { projectId: 'p-1', path: 'a.ts' }),
    );
    assert.deepEqual(tabs, []);
  });

  test('refuses an input without a Project or path', async (t) => {
    const { tabs, commands, dispose } = setup();
    t.after(dispose);

    await assert.rejects(commands.execute(OPEN_FILE_COMMAND, { path: 'a.ts' }));
    assert.deepEqual(tabs, []);
  });
});
