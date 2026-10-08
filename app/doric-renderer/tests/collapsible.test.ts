import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  blockOpen,
  blockToggled,
  settledOpenness,
  thinkingOpenness,
  toolOpenness,
} from '../src/domain/collapsible';

describe('the open state of a folding block', () => {
  test('opens while its work is in progress and has something to show', () => {
    assert.equal(blockOpen(null, { active: true, hasContent: true }), true);
  });

  test('stays folded while the work is unfinished but shows nothing', () => {
    assert.equal(blockOpen(null, { active: true, hasContent: false }), false);
  });

  test('folds away once the work settles', () => {
    assert.equal(blockOpen(null, { active: false, hasContent: true }), false);
    assert.equal(blockOpen(null, { active: false, hasContent: false }), false);
  });

  test("follows the reader's choice over the work", () => {
    assert.equal(blockOpen(true, { active: false, hasContent: false }), true);
    assert.equal(blockOpen(false, { active: true, hasContent: true }), false);
  });
});

describe('the reader toggling a block', () => {
  test('takes the opposite of what the block shows when they have not chosen', () => {
    // The block was open on its own, so closing it is the reader's first word.
    assert.equal(blockToggled(null, { active: true, hasContent: true }), false);
    assert.equal(blockToggled(null, { active: false, hasContent: true }), true);
  });

  test('takes the opposite of their own choice afterwards', () => {
    assert.equal(
      blockToggled(true, { active: false, hasContent: true }),
      false,
    );
    assert.equal(
      blockToggled(false, { active: false, hasContent: true }),
      true,
    );
  });

  test('keeps their choice when the work changes under it', () => {
    // They closed a block that was open while it worked; the work going on
    // must not reopen it.
    const closed = blockToggled(null, { active: true, hasContent: true });
    assert.equal(blockOpen(closed, { active: true, hasContent: true }), false);
    // And the other way: a block they opened stays open once the work settles.
    const opened = blockToggled(null, { active: true, hasContent: false });
    assert.equal(blockOpen(opened, { active: false, hasContent: false }), true);
  });
});

describe('what opens each block on its own', () => {
  test('a thinking block opens while the run streams and its prose has words', () => {
    assert.equal(
      blockOpen(null, thinkingOpenness('weighing the options', true)),
      true,
    );
  });

  test('a thinking block stays folded while the run has read back into nothing', () => {
    assert.equal(blockOpen(null, thinkingOpenness('', true)), false);
  });

  test('a thinking block folds away once the run settles', () => {
    assert.equal(
      blockOpen(null, thinkingOpenness('weighing the options', false)),
      false,
    );
  });

  test('a tool-call block opens while the call runs and shows anything', () => {
    assert.equal(
      blockOpen(null, toolOpenness('running', 'ls', undefined, undefined)),
      true,
    );
    assert.equal(
      blockOpen(null, toolOpenness('running', '', undefined, undefined)),
      false,
    );
  });

  test('a tool-call block folds away once the call settles', () => {
    assert.equal(
      blockOpen(null, toolOpenness('finished', 'ls', 'a.ts', undefined)),
      false,
    );
    assert.equal(
      blockOpen(null, toolOpenness('failed', 'ls', undefined, 'denied')),
      false,
    );
  });

  test('an activity summary is folded until the reader opens it', () => {
    assert.equal(blockOpen(null, settledOpenness), false);
    assert.equal(blockToggled(null, settledOpenness), true);
  });
});
