// The client commands/v1 in a real window: a command a part of the window
// registered runs here; any other runs in desktopMain through
// core.commands/v1, whose refusals reach the caller unchanged.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { CommandsV1, defineCommand, isContractError } from 'bundle/contracts';
import { z } from 'zod';

import { openWindow, probe, type TestWindow } from './support/window.js';

let opened: TestWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

const codeOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return isContractError(error) ? error.code : error;
  }

  return 'resolved';
};

const runs: unknown[] = [];

const withCommand = () =>
  probe(
    'x',
    (services) => {
      services.use(CommandsV1).register(
        defineCommand({
          id: 'x.copy/v1',
          input: z.object({ text: z.string() }).strict(),
          execute: (input, call) => {
            runs.push({ input, caller: call.caller.bundleId });
          },
        }),
      );
    },
    undefined,
    ['x.copy/v1'],
  );

void test('a command registered in the window runs here with its input', async () => {
  runs.length = 0;

  const x = withCommand();

  opened = await openWindow({ probes: [x] });
  await x.services().use(CommandsV1).execute('x.copy/v1', { text: 'hi' });

  assert.deepEqual(runs, [{ input: { text: 'hi' }, caller: 'x' }]);
  assert.deepEqual(opened.received('core.commands/v1.execute'), []);
});

void test('an input the window command rejects is invalid_input', async () => {
  runs.length = 0;

  const x = withCommand();

  opened = await openWindow({ probes: [x] });

  assert.equal(
    await codeOf(
      x.services().use(CommandsV1).execute('x.copy/v1', { text: 3 }),
    ),
    'invalid_input',
  );
  assert.deepEqual(runs, []);
});

void test('a command not registered in the window runs in desktopMain', async () => {
  const x = withCommand();

  opened = await openWindow({ probes: [x] });
  await x.services().use(CommandsV1).execute('core.open-settings/v1');

  assert.deepEqual(
    opened.received('core.commands/v1.execute').map(({ input }) => input),
    [{ id: 'core.open-settings/v1', input: {} }],
  );
});

void test('a command desktopMain does not know either is unknown_command', async () => {
  const x = withCommand();

  opened = await openWindow({
    probes: [x],
    answer: (envelope) =>
      envelope.contract === 'core.commands/v1'
        ? {
            ok: false,
            error: {
              code: 'unknown_command',
              message: 'No command "x.missing/v1" is registered here.',
            },
          }
        : { ok: true, output: undefined },
  });

  assert.equal(
    await codeOf(x.services().use(CommandsV1).execute('x.missing/v1', {})),
    'unknown_command',
  );
});
