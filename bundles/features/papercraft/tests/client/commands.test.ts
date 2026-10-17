// `papercraft.approve/v1` as the keybinding dispatches it: `CmdOrCtrl+Enter`
// carries no input, so the approval targets the canvas the reader touched
// last, at the revision it shows, in that canvas's Project and Thread.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Call, Services } from 'bundle/contracts';

import { PAPERCRAFT_KEYBINDINGS } from '../../src/contracts/index.js';

type Commands = typeof import('../../src/client/commands.js');
type Registry = typeof import('../../src/client/canvas-registry.js');

const load = async (): Promise<[Commands, Registry]> =>
  Promise.all([
    import('../../src/client/commands.js'),
    import('../../src/client/canvas-registry.js'),
  ]);

const controller = (
  artifactId: string,
  revision: number,
  reloads: string[],
) => ({
  artifactId,
  scope: { projectId: 'p1', threadId: 't1' },
  setTool: () => undefined,
  isolate: () => undefined,
  showAll: () => undefined,
  zoomOut: () => undefined,
  zoomReset: () => undefined,
  zoomIn: () => undefined,
  zoomFit: () => undefined,
  selectRevision: () => undefined,
  currentRevision: () => revision,
  reload: () => reloads.push(artifactId),
});

const servicesRecording = (
  approvals: { input: unknown; scope: unknown }[],
): Services =>
  ({
    use: (_contract: unknown, scope?: { projectId?: string }) => {
      if (scope?.projectId === undefined) {
        throw new Error('artifacts/v1 used without a projectId scope');
      }

      return {
        approve: async (input: unknown) => {
          approvals.push({ input, scope });

          return undefined;
        },
      };
    },
  }) as unknown as Services;

test('the approve shortcut is CmdOrCtrl+Enter', () => {
  assert.ok(
    PAPERCRAFT_KEYBINDINGS.some(
      (binding) =>
        binding.command === 'papercraft.approve/v1' &&
        binding.key === 'CmdOrCtrl+Enter',
    ),
  );
});

test('the input-less approval targets the canvas touched last, in its scope', async () => {
  const [commands, registry] = await load();
  const reloads: string[] = [];
  const approvals: { input: unknown; scope: unknown }[] = [];

  const releaseA = registry.registerController(controller('a-1', 3, reloads));
  const releaseB = registry.registerController(controller('b-2', 1, reloads));
  registry.touchController('a-1');

  await commands.approveCommand.execute(
    {},
    {} as Call,
    servicesRecording(approvals),
  );

  assert.deepEqual(approvals, [
    {
      input: { artifactId: 'a-1', revision: 3 },
      scope: { projectId: 'p1', threadId: 't1' },
    },
  ]);
  assert.deepEqual(reloads, ['a-1']);

  releaseB();
  releaseA();
});

test('with no canvas open the approval writes nothing', async () => {
  const [commands] = await load();
  const approvals: { input: unknown; scope: unknown }[] = [];

  await commands.approveCommand.execute(
    {},
    {} as Call,
    servicesRecording(approvals),
  );

  assert.deepEqual(approvals, []);
});
