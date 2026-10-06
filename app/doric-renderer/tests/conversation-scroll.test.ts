import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { scrollPlan } from '../src/domain/conversation-scroll';

describe('conversation scroll', () => {
  test('opens the surface on the input when the first sync runs', () => {
    assert.equal(
      scrollPlan({
        opening: true,
        filling: false,
        atBottom: true,
        navigating: false,
      }),
      'open',
    );
    assert.equal(
      scrollPlan({
        opening: true,
        filling: false,
        atBottom: false,
        navigating: false,
      }),
      'open',
    );
  });

  test('opens the surface on the input even while a fill pass could pin the tail', () => {
    assert.equal(
      scrollPlan({
        opening: true,
        filling: true,
        atBottom: true,
        navigating: false,
      }),
      'open',
    );
  });

  test('keeps the tail in view while the transcript fills in for a reader at the bottom', () => {
    assert.equal(
      scrollPlan({
        opening: false,
        filling: true,
        atBottom: true,
        navigating: false,
      }),
      'pin',
    );
  });

  test('leaves the reader where they are while the transcript fills in once they scroll up', () => {
    assert.equal(
      scrollPlan({
        opening: false,
        filling: true,
        atBottom: false,
        navigating: false,
      }),
      'hold',
    );
  });

  test('leaves a reader at the bottom where they are once the conversation is loaded', () => {
    assert.equal(
      scrollPlan({
        opening: false,
        filling: false,
        atBottom: true,
        navigating: false,
      }),
      'hold',
    );
  });

  test('leaves a reader who scrolled up where they are once the conversation is loaded', () => {
    assert.equal(
      scrollPlan({
        opening: false,
        filling: false,
        atBottom: false,
        navigating: false,
      }),
      'hold',
    );
  });

  test('lets a trail jump reach its destination while turns continue streaming', () => {
    assert.equal(
      scrollPlan({
        opening: false,
        filling: false,
        atBottom: false,
        navigating: true,
      }),
      'navigate',
    );
    assert.equal(
      scrollPlan({
        opening: false,
        filling: true,
        atBottom: true,
        navigating: true,
      }),
      'navigate',
    );
  });
});
