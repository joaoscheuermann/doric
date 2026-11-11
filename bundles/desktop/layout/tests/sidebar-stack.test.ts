// The sidebar's stack (`layout.stack/v2`): the panes bundles register, drawn
// in order under the Thread region and pinned to the column's bottom. Nothing
// in the stack resizes (sidebar alignment §9); what is left to the domain is
// the order.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { orderedPanes } from '../src/client/domain/sidebar-stack.js';

describe('the sidebar stack ordering', () => {
  test('sorts by order, absent order last', () => {
    const panes = [
      { id: 'later', order: 20 },
      { id: 'first', order: 0 },
      { id: 'absent' },
      { id: 'middle', order: 10 },
    ];

    assert.deepEqual(
      orderedPanes(panes).map((pane) => pane.id),
      ['first', 'middle', 'later', 'absent'],
    );
  });

  test('keeps the registration order within a tie', () => {
    const panes = [
      { id: 'second', order: 10 },
      { id: 'first', order: 10 },
      { id: 'third', order: 10 },
    ];

    assert.deepEqual(
      orderedPanes(panes).map((pane) => pane.id),
      ['second', 'first', 'third'],
    );
  });

  test('returns a new array and leaves the registration untouched', () => {
    const panes = [
      { id: 'later', order: 20 },
      { id: 'first', order: 0 },
    ];
    const ordered = orderedPanes(panes);

    assert.notEqual(ordered, panes);
    assert.deepEqual(
      panes.map((pane) => pane.id),
      ['later', 'first'],
    );
  });
});
