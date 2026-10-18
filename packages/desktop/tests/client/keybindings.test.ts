import assert from 'node:assert/strict';
import test from 'node:test';

import { installKeybindings } from '../../src/client/index.js';
import {
  describe,
  fakeDesktop,
  fakeKeyTarget,
  windowCatalog,
} from './support/fixtures.js';

const setup = (mac: boolean) => {
  const desktop = fakeDesktop(describe(), windowCatalog([], { core: 'core' }));
  const target = fakeKeyTarget();
  const installed = installKeybindings({ desktop, target, mac });

  return { desktop, target, installed };
};

void test('one capture-phase keydown listener follows the window table', () => {
  const { desktop, target } = setup(true);

  assert.equal(target.listeners.length, 1);
  assert.equal(target.listeners[0]?.capture, true);
  assert.deepEqual(
    desktop.subscriptions.map(({ envelope }) => ({
      contract: envelope.contract,
      method: envelope.method,
      bundleId: envelope.bundleId,
    })),
    [{ contract: 'doric.shell/v1', method: 'keybindings', bundleId: null }],
  );
});

void test('with the empty stage-8 table no key is intercepted', () => {
  const { desktop, target } = setup(true);

  desktop.push('doric.shell/v1', 'keybindings', []);

  for (const press of [
    { key: 'k', metaKey: true },
    { key: 'c', metaKey: true },
    { key: 'Enter' },
    { key: 'Escape' },
  ]) {
    assert.equal(target.press(press), false);
  }

  assert.deepEqual(desktop.shell('keybinding'), []);
});

void test('a matching key is prevented and sent to main; others pass through', () => {
  const { desktop, target } = setup(true);

  desktop.push('doric.shell/v1', 'keybindings', [
    { key: 'CmdOrCtrl+Shift+P', command: 'core.palette/v1' },
  ]);

  assert.equal(target.press({ key: 'P', metaKey: true, shiftKey: true }), true);
  assert.equal(target.press({ key: 'p', metaKey: true }), false);
  assert.equal(
    target.press({ key: 'p', ctrlKey: true, shiftKey: true }),
    false,
  );
  assert.deepEqual(desktop.shell('keybinding'), [{ key: 'CmdOrCtrl+Shift+P' }]);
});

void test('CmdOrCtrl is Control outside macOS', () => {
  const { desktop, target } = setup(false);

  desktop.push('doric.shell/v1', 'keybindings', [
    { key: 'CmdOrCtrl+K', command: 'core.search/v1' },
  ]);

  assert.equal(target.press({ key: 'k', ctrlKey: true }), true);
  assert.equal(target.press({ key: 'k', metaKey: true }), false);
});

void test('a new table replaces the previous one and dispose removes the listener', () => {
  const { desktop, target, installed } = setup(true);

  desktop.push('doric.shell/v1', 'keybindings', [
    { key: 'CmdOrCtrl+K', command: 'core.search/v1' },
  ]);
  desktop.push('doric.shell/v1', 'keybindings', [
    { key: 'Alt+Up', command: 'core.up/v1' },
  ]);

  assert.equal(target.press({ key: 'k', metaKey: true }), false);
  assert.equal(target.press({ key: 'ArrowUp', altKey: true }), true);

  installed.dispose();

  assert.equal(target.listeners.length, 0);
  assert.equal(desktop.subscriptions[0]?.unsubscribed, true);
});
