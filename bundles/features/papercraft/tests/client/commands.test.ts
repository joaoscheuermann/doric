// The canvas's chords and `papercraft.approve/v1` as its chord dispatches it:
// `CmdOrCtrl+Enter` names chat's send, the approval is
// `CmdOrCtrl+Shift+Enter`, which carries no input, so it targets the canvas
// the reader touched last, at the revision it shows, in that canvas's Project
// and Thread.

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
  sendNow: async () => undefined,
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

test('the bar chords: CmdOrCtrl+Enter names the send, and the approval is CmdOrCtrl+Shift+Enter', () => {
  const commandOf = (key: string) =>
    PAPERCRAFT_KEYBINDINGS.filter((binding) => binding.key === key).map(
      (binding) => binding.command,
    );

  assert.deepEqual(commandOf('CmdOrCtrl+Enter'), ['papercraft.send/v1']);
  assert.deepEqual(commandOf('CmdOrCtrl+Shift+Enter'), [
    'papercraft.approve/v1',
  ]);
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

/* The modal's keys (`keyCommandOf`) and whether a canvas is open (`canvasOpen`) */

const chord = (
  key: string,
  more: Partial<import('../../src/client/commands.js').KeyChord> = {},
): import('../../src/client/commands.js').KeyChord => ({
  key,
  code: '',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  defaultPrevented: false,
  ...more,
});

test('in the modal every bar chord but CmdOrCtrl+Enter dispatches its command, with Cmd or Ctrl', async () => {
  const [commands] = await load();
  const plain: [string, Partial<import('../../src/client/commands.js').KeyChord>, string][] = [
    ['v', { code: 'KeyV' }, 'papercraft.select/v1'],
    ['c', { code: 'KeyC' }, 'papercraft.comment/v1'],
    ['h', { code: 'KeyH' }, 'papercraft.pan/v1'],
    ['i', { code: 'KeyI' }, 'papercraft.isolate/v1'],
    ['I', { code: 'KeyI', shiftKey: true }, 'papercraft.show-all/v1'],
    ['!', { code: 'Digit1', shiftKey: true }, 'papercraft.zoom-fit/v1'],
  ];
  for (const [key, more, command] of plain)
    assert.equal(commands.keyCommandOf(chord(key, more)), command, key);

  const cmdOrCtrl: [string, Partial<import('../../src/client/commands.js').KeyChord>, string][] = [
    ['-', { code: 'Minus' }, 'papercraft.zoom-out/v1'],
    ['0', { code: 'Digit0' }, 'papercraft.zoom-reset/v1'],
    ['=', { code: 'Equal' }, 'papercraft.zoom-in/v1'],
    ['Enter', { code: 'Enter', shiftKey: true }, 'papercraft.approve/v1'],
  ];
  for (const modifier of [{ metaKey: true }, { ctrlKey: true }])
    for (const [key, more, command] of cmdOrCtrl)
      assert.equal(
        commands.keyCommandOf(chord(key, { ...more, ...modifier })),
        command,
        `${JSON.stringify(modifier)} ${key}`,
      );

  // Every chord of the bar is covered above but chat's send.
  const covered = new Set([...plain, ...cmdOrCtrl].map(([, , command]) => command));
  assert.deepEqual(
    new Set(
      PAPERCRAFT_KEYBINDINGS.map((binding) => binding.command).filter(
        (command) => command !== 'papercraft.send/v1',
      ),
    ),
    covered,
  );
});

test('in the modal a taken key, CmdOrCtrl+Enter, an Alt chord or an unknown key dispatch nothing', async () => {
  const [commands] = await load();

  assert.equal(
    commands.keyCommandOf(chord('v', { code: 'KeyV', defaultPrevented: true })),
    undefined,
    'already taken',
  );
  assert.equal(
    commands.keyCommandOf(chord('Enter', { code: 'Enter', metaKey: true })),
    undefined,
    'Cmd+Enter is chat’s',
  );
  assert.equal(
    commands.keyCommandOf(chord('Enter', { code: 'Enter', ctrlKey: true })),
    undefined,
    'Ctrl+Enter is chat’s',
  );
  assert.equal(
    commands.keyCommandOf(chord('v', { code: 'KeyV', altKey: true })),
    undefined,
    'Alt+V',
  );
  assert.equal(
    commands.keyCommandOf(chord('q', { code: 'KeyQ' })),
    undefined,
    'unknown key',
  );
});

test('a canvas is open while its controller is registered', async () => {
  const [, registry] = await load();

  assert.equal(registry.canvasOpen('open-1'), false);
  const release = registry.registerController(controller('open-1', 1, []));
  assert.equal(registry.canvasOpen('open-1'), true);
  assert.equal(registry.canvasOpen('other-2'), false);
  release();
  assert.equal(registry.canvasOpen('open-1'), false);
});
