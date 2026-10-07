import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  atEnd,
  preserveVisibleBlock,
  scrollPlan,
} from '../src/domain/conversation-scroll';

describe('conversation scroll', () => {
  test('opens the surface at the end when the first sync runs', () => {
    assert.equal(
      scrollPlan({ opening: true, navigating: false, following: false }),
      'open',
    );
    assert.equal(
      scrollPlan({ opening: true, navigating: false, following: true }),
      'open',
    );
  });

  test('follows the end through transcript updates until the reader scrolls', () => {
    assert.equal(
      scrollPlan({ opening: false, navigating: false, following: true }),
      'follow',
    );
  });

  test('holds a reader who stopped following the end', () => {
    assert.equal(
      scrollPlan({ opening: false, navigating: false, following: false }),
      'hold',
    );
  });

  test('lets a trail jump reach its destination while turns continue streaming', () => {
    assert.equal(
      scrollPlan({ opening: false, navigating: true, following: false }),
      'navigate',
    );
    assert.equal(
      scrollPlan({ opening: false, navigating: true, following: true }),
      'navigate',
    );
  });

  test('resumes following when a reader scrolls within the end tolerance', () => {
    assert.equal(atEnd(568, 1000, 400), true);
    assert.equal(atEnd(567, 1000, 400), false);
    assert.equal(atEnd(600, 1000, 400), true);
    assert.equal(atEnd(0, 300, 400), true);
  });

  test('preserves a manual scroll made while new content is inserted above the visible block', () => {
    // The reader moves from 500 to 420 while the block moves from 1000 to 1100.
    assert.equal(preserveVisibleBlock(420, 1000, 1100), 520);
    assert.equal(preserveVisibleBlock(420, 1000, 1000), 420);
  });
});
