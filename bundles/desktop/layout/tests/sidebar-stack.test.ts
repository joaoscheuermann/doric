// The sidebar's stack (the layout's own structure): the panes bundles register
// through `layout.stack/v1` and the Threads pane the layout draws itself, in
// order, each behind a draggable divider. A pane is never collapsed past its
// header, so resizing the stack cannot make a group vanish (`PANE_HEADER`); the
// geometry itself only the running window can prove.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  orderedPanes,
  PANE_HEADER,
  paneExpanded,
  THREADS_PANE_ID,
  threadsPane,
} from '../src/client/domain/sidebar-stack.js';

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

describe('the pane the layout draws itself', () => {
  test('is the stack head, open and collapsible', () => {
    assert.equal(threadsPane.id, THREADS_PANE_ID);
    assert.equal(threadsPane.order, 0);
    assert.equal(
      orderedPanes([{ id: 'screens', order: 10 }, threadsPane])[0]?.id,
      THREADS_PANE_ID,
    );
    assert.notEqual(threadsPane.collapsible, false);
    assert.equal(threadsPane.initiallyOpen, undefined);
    // A pane that declares no default size takes what the others leave.
    assert.equal(threadsPane.defaultSize, undefined);
  });
});

describe('whether a pane is expanded', () => {
  test('a header-tall pane is collapsed', () => {
    assert.equal(paneExpanded(28, 28), false);
  });

  test('anything taller than the header is expanded', () => {
    assert.equal(paneExpanded(29, 28), true);
    assert.equal(paneExpanded(120, 28), true);
  });

  test('a pane measured before its header exists is not expanded', () => {
    // The caller ignores the zero-height reading, but the rule stays honest.
    assert.equal(paneExpanded(0, 28), false);
  });

  test('the collapsed height is the header, never zero', () => {
    assert.equal(PANE_HEADER, '1.75rem');
  });
});
