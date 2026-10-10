// layout.panel/v1 (R-9.2): the Project panel starts open on Files, `show`
// opens it and selects a view (the footer's changes button), `toggle` flips
// it, and subscribers hear each change until they dispose.

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { createTestServices } from 'bundle/testing';

import {
  movedPanelOrder,
  panelOrder,
} from '../src/client/domain/panel-order.js';
import { createLayoutPanel } from '../src/client/services/layout-panel.js';
import { panelStore, resetPanel } from '../src/client/stores/panel.js';
import { LayoutPanelV1 } from '../src/contracts/index.js';

const setup = () => {
  const harness = createTestServices({
    bundle: { id: 'git' },
    provide: [createLayoutPanel()],
  });
  return {
    panel: harness.services.use(LayoutPanelV1),
    dispose: harness.dispose,
  };
};

beforeEach(resetPanel);

describe('layout.panel/v1', () => {
  test('the panel starts open on the Files view', async () => {
    const { panel, dispose } = setup();
    assert.equal(panel.isOpen(), true);
    assert.equal(panel.active(), 'files');
    await dispose();
  });

  test('show opens a closed panel on the view it names', async () => {
    const { panel, dispose } = setup();
    panel.toggle();
    assert.equal(panel.isOpen(), false);

    panel.show('changes');

    assert.equal(panel.isOpen(), true);
    assert.equal(panel.active(), 'changes');
    await dispose();
  });

  test('the reader closing the panel by its handle is what the contract reports', async () => {
    const { panel, dispose } = setup();
    panelStore.getState().setOpen(false);
    assert.equal(panel.isOpen(), false);
    panelStore.getState().select('changes');
    assert.equal(panel.active(), 'changes');
    await dispose();
  });

  test('subscribers hear each change until they dispose', async () => {
    const { panel, dispose } = setup();
    let heard = 0;
    const subscription = panel.subscribe(() => {
      heard += 1;
    });

    panel.toggle();
    panel.show('files');
    panel.show('files');
    subscription.dispose();
    panel.toggle();

    assert.equal(heard, 2);
    await dispose();
  });
});

describe('Project views order', () => {
  test('new views join after the ones the reader holds, in region order', () => {
    assert.deepEqual(panelOrder([], ['files', 'changes']), [
      'files',
      'changes',
    ]);
    assert.deepEqual(
      panelOrder(['changes', 'files'], ['files', 'changes', 'resources']),
      ['changes', 'files', 'resources'],
    );
  });

  test('a view that leaves the panel leaves the order', () => {
    assert.deepEqual(panelOrder(['changes', 'files'], ['files']), ['files']);
  });

  test('an unchanged set keeps the same order value', () => {
    const order = ['changes', 'files'];
    assert.equal(panelOrder(order, ['files', 'changes']), order);
  });

  test('dragging a view onto another moves it there', () => {
    assert.deepEqual(
      movedPanelOrder(['files', 'changes'], 'changes', 'files'),
      ['changes', 'files'],
    );
  });
});
