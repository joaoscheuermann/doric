// The sidebar's vertical stack (the layout's own structure): the Threads group
// on top, the `layout.sidebar` region's group below it, and the drag handle
// between them. The region's group is the stack's second half only while the
// region has items: an empty region shows nothing, so the sidebar is the
// Threads group alone, as it was before the stack existed (stage 9 §5.4).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { showsSidebarRegion } from '../src/client/domain/sidebar-stack.js';

describe('the sidebar stack', () => {
  test('an empty region leaves the Threads group the whole sidebar', () => {
    assert.equal(showsSidebarRegion([]), false);
  });

  test('the first item draws the region its own group', () => {
    assert.equal(showsSidebarRegion(['first-item']), true);
  });

  test('every further item keeps the region shown', () => {
    assert.equal(showsSidebarRegion(['first-item', 'second-item']), true);
  });
});
