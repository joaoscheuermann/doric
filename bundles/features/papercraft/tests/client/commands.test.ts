// The canvas window's chords: `CmdOrCtrl+Enter` is the window's send, and
// with `papercraft.approve/v1` gone (D25) no chord approves.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PAPERCRAFT_KEYBINDINGS } from '../../src/contracts/index.js';

test('in the canvas window CmdOrCtrl+Enter sends, and CmdOrCtrl+Shift+Enter is bound to nothing', () => {
  const commandOf = (key: string) =>
    PAPERCRAFT_KEYBINDINGS.filter((binding) => binding.key === key).map(
      (binding) => binding.command,
    );

  assert.deepEqual(commandOf('CmdOrCtrl+Enter'), ['papercraft.send/v1']);
  assert.deepEqual(commandOf('CmdOrCtrl+Shift+Enter'), []);
});
