import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  restOnBottom,
  restsOnTail,
  scrollPlan,
} from '../src/domain/conversation-scroll';

describe('conversation scroll', () => {
  test('opens the surface on the input when the first sync runs', () => {
    assert.equal(
      scrollPlan({ opening: true, navigating: false, atTail: false }),
      'open',
    );
    assert.equal(
      scrollPlan({ opening: true, navigating: false, atTail: true }),
      'open',
    );
  });

  test('follows the input for a reader resting on the tail as the transcript grows', () => {
    assert.equal(
      scrollPlan({ opening: false, navigating: false, atTail: true }),
      'follow',
    );
  });

  test('holds a reader who left the tail exactly where the pass found them', () => {
    assert.equal(
      scrollPlan({ opening: false, navigating: false, atTail: false }),
      'hold',
    );
  });

  test('lets a trail jump reach its destination while turns continue streaming', () => {
    assert.equal(
      scrollPlan({ opening: false, navigating: true, atTail: false }),
      'navigate',
    );
    assert.equal(
      scrollPlan({ opening: false, navigating: true, atTail: true }),
      'navigate',
    );
  });

  test('rests a block on the bottom edge of the viewport', () => {
    assert.equal(restOnBottom(1200, 600, 900), 600);
    assert.equal(restOnBottom(900, 600, 900), 300);
  });

  test('stops a block the surface cannot bring that low at the surface own end', () => {
    assert.equal(restOnBottom(1500, 600, 900), 900);
    assert.equal(restOnBottom(200, 600, 900), 0);
  });

  test('counts a reader at the input or below it as resting on the tail', () => {
    assert.equal(restsOnTail(600, 600), true);
    assert.equal(restsOnTail(900, 600), true);
    assert.equal(restsOnTail(598, 600), true);
    assert.equal(restsOnTail(500, 600), false);
  });
});
