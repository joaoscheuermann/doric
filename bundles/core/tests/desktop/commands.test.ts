import assert from 'node:assert/strict';
import test from 'node:test';

import { CommandsV1, type Disposable, defineCommand } from 'bundle/contracts';
import { OpenSettingsCommandV1 } from 'core/contracts';
import { z } from 'zod';

import { bootDesktop, probe } from '../support/desktop.js';

const settingsAppearance = {
  size: { width: 960, height: 720, minWidth: 720, minHeight: 520 },
  titleBar: 'integrated',
  background: 'window',
};

const codeOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: unknown }).code;
  }

  return 'resolved';
};

void test('core.open-settings/v1 opens the settings window at /settings, or at the path it is given', async () => {
  const desktop = await bootDesktop([]);

  try {
    const commands = desktop.services.use(CommandsV1);

    // Menus and keybindings execute with an empty input (decision 77).
    await commands.execute('core.open-settings/v1', {}, desktop.call());
    await commands.execute(
      OpenSettingsCommandV1,
      { path: '/settings/providers' },
      desktop.call(),
    );

    assert.deepEqual(
      desktop.received('doric.windows/v1.open').map(({ input }) => input),
      [
        { key: 'settings', path: '/settings', appearance: settingsAppearance },
        {
          key: 'settings',
          path: '/settings/providers',
          appearance: settingsAppearance,
        },
      ],
    );
  } finally {
    await desktop.stop();
  }
});

void test('a command input the command rejects is invalid_input, and nothing opens', async () => {
  const desktop = await bootDesktop([]);

  try {
    const commands = desktop.services.use(CommandsV1);

    assert.equal(
      await codeOf(
        commands.execute('core.open-settings/v1', { path: 3 }, desktop.call()),
      ),
      'invalid_input',
    );
    assert.deepEqual(desktop.received('doric.windows/v1.open'), []);
  } finally {
    await desktop.stop();
  }
});

void test('a command another bundle registers runs once per execution with its input', async () => {
  const runs: unknown[] = [];
  const desktop = await bootDesktop([
    probe('graph', {
      requires: ['commands/v1@^1.0.0'],
      provides: [['graph.ping/v1', 'command']],
      activate: ({ services }) => {
        services.use(CommandsV1).register(
          defineCommand({
            id: 'graph.ping/v1',
            input: z.object({ times: z.number().default(1) }).strict(),
            execute: (input, call) => {
              runs.push({ input, caller: call.caller.bundleId });
            },
          }),
        );
      },
    }),
  ]);

  try {
    await desktop.services
      .use(CommandsV1)
      .execute('graph.ping/v1', {}, desktop.call());

    assert.deepEqual(runs, [{ input: { times: 1 }, caller: 'doric' }]);
  } finally {
    await desktop.stop();
  }
});

void test('executing an ID nobody registered here is unknown_command', async () => {
  const desktop = await bootDesktop([]);

  try {
    assert.equal(
      await codeOf(
        desktop.services
          .use(CommandsV1)
          .execute('graph.missing/v1', {}, desktop.call()),
      ),
      'unknown_command',
    );
  } finally {
    await desktop.stop();
  }
});

void test('a second registration of the same command ID is a registration_conflict; disposing frees the ID', async () => {
  const outcomes: unknown[] = [];
  let first: Disposable | undefined;
  const ping = defineCommand({
    id: 'graph.ping/v1',
    input: z.object({}).strict(),
    execute: () => undefined,
  });
  const desktop = await bootDesktop([
    probe('graph', {
      requires: ['commands/v1@^1.0.0'],
      provides: [['graph.ping/v1', 'command']],
      activate: ({ services }) => {
        const commands = services.use(CommandsV1);

        first = commands.register(ping);

        try {
          commands.register(ping);
          outcomes.push('registered twice');
        } catch (error) {
          outcomes.push((error as { code?: unknown }).code);
        }
      },
    }),
  ]);

  try {
    const commands = desktop.services.use(CommandsV1);

    assert.equal(
      await codeOf(commands.execute('graph.ping/v1', {}, desktop.call())),
      'resolved',
    );

    first?.dispose();

    assert.equal(
      await codeOf(commands.execute('graph.ping/v1', {}, desktop.call())),
      'unknown_command',
    );
    assert.deepEqual(outcomes, ['registration_conflict']);
  } finally {
    await desktop.stop();
  }
});
