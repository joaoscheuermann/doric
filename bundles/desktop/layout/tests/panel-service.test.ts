// layout.panel/v3 (spec part 2i, S36; bundle isolation 4a T4.5): the Project
// panel always shows; the contract only selects which `layout.panel` view it
// draws, and a window's panel starts with no view selected.

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { createTestServices } from 'bundle/testing';

import {
  movedPanelOrder,
  panelOrder,
} from '../src/client/domain/panel-order.js';
import { createLayoutPanelV3 } from '../src/client/services/layout-panel.js';
import { panelStore, resetPanel } from '../src/client/stores/panel.js';
import { LayoutPanelV3, layoutPanelMethods } from '../src/contracts/index.js';

const setup = () => {
  const harness = createTestServices({
    bundle: { id: 'files' },
    provide: [createLayoutPanelV3()],
  });
  return {
    panel: harness.services.use(LayoutPanelV3),
    dispose: harness.dispose,
  };
};

beforeEach(resetPanel);

describe('layout.panel/v3', () => {
  // T4.5, the last part: under v3 the panel starts with no view selected.
  test('a fresh panel store answers no active view', () => {
    assert.equal(panelStore.getState().active, undefined);
  });

  test('select(files) on a fresh store selects Files and notifies the panel', async () => {
    const { panel, dispose } = setup();
    let heard = 0;
    const unsubscribe = panelStore.subscribe(() => {
      heard += 1;
    });

    panel.select('files');

    unsubscribe();
    assert.equal(panelStore.getState().active, 'files');
    assert.equal(heard, 1, 'Selecting Files changed nothing the panel draws.');
    await dispose();
  });

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
