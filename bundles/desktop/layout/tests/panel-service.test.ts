// layout.panel/v2 (spec part 2i, S36): the Project panel always shows; the
// contract only selects which `layout.panel` view it draws.

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { createTestServices } from 'bundle/testing';

import {
  movedPanelOrder,
  panelOrder,
} from '../src/client/domain/panel-order.js';
import { createLayoutPanel } from '../src/client/services/layout-panel.js';
import { panelStore, resetPanel } from '../src/client/stores/panel.js';
import { LayoutPanelV2, layoutPanelMethods } from '../src/contracts/index.js';

const setup = () => {
  const harness = createTestServices({
    bundle: { id: 'files' },
    provide: [createLayoutPanel()],
  });
  return {
    panel: harness.services.use(LayoutPanelV2),
    dispose: harness.dispose,
  };
};

beforeEach(resetPanel);

describe('layout.panel/v2', () => {
  test('select selects the view it names', async () => {
    const { panel, dispose } = setup();

    panel.select('changes');
    assert.equal(panelStore.getState().active, 'changes');

    panel.select('files');
    assert.equal(panelStore.getState().active, 'files');
    await dispose();
  });

  test('the contract has select only', () => {
    assert.deepEqual(Object.keys(layoutPanelMethods), ['select']);
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
