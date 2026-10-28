import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  blockOpen,
  blockToggled,
  replyOpenness,
  settledOpenness,
  skillOpenness,
  spawnOpenness,
  terminalResultOpenness,
  thinkingOpenness,
  toolOpenness,
} from '../src/client/domain/collapsible.js';

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

  test('edit and write tool-call blocks stay open by default once settled until the reader closes them', () => {
    for (const toolName of ['edit', 'write'] as const) {
      const settled = toolOpenness(
        'finished',
        '{"path":"a.ts"}',
        '{"success":true,"diff":"1 +ok"}',
        undefined,
        toolName,
      );
      assert.equal(settled.active, false);
      assert.equal(blockOpen(null, settled), true);
      assert.equal(blockToggled(null, settled), false);
    }
  });

  test('an activity summary is folded until the reader opens it', () => {
    assert.equal(blockOpen(null, settledOpenness), false);
    assert.equal(blockToggled(null, settledOpenness), true);
  });

  test('a reply row is folded once its thread is resolved, and open while it waits for the reader or stays open', () => {
    assert.equal(blockOpen(null, replyOpenness('done', 'Fixed.')), false);
    assert.equal(blockOpen(null, replyOpenness('await', '40 or 48px?')), true);
    assert.equal(blockOpen(null, replyOpenness('open', 'Looking.')), true);
  });

  test("the reader's choice on a reply row stands over its thread's state", () => {
    assert.equal(blockOpen(true, replyOpenness('done', 'Fixed.')), true);
    assert.equal(
      blockOpen(false, replyOpenness('await', '40 or 48px?')),
      false,
    );
  });

  test('a background terminal result is folded when it finished cleanly', () => {
    assert.equal(blockOpen(null, terminalResultOpenness(false)), false);
    assert.equal(blockToggled(null, terminalResultOpenness(false)), true);
  });

  test('a background terminal result is open when its command did not finish cleanly', () => {
    assert.equal(blockOpen(null, terminalResultOpenness(true)), true);
  });

  test("the reader's choice on a terminal result stands over the outcome", () => {
    assert.equal(blockOpen(true, terminalResultOpenness(false)), true);
    assert.equal(blockOpen(false, terminalResultOpenness(true)), false);
  });

  test('a thread-spawn block is open while it spawns and when it failed, and folded once it spawned', () => {
    assert.equal(blockOpen(null, spawnOpenness('running')), true);
    assert.equal(blockOpen(null, spawnOpenness('finished')), false);
    assert.equal(blockOpen(null, spawnOpenness('failed')), true);
  });

  test("the reader's choice on a thread-spawn block stands over its call", () => {
    assert.equal(blockOpen(true, spawnOpenness('running')), true);
    // They can fold away a call that is still spawning.
    assert.equal(blockOpen(false, spawnOpenness('running')), false);
  });

  test('a load_skill block is folded while it loads and once loaded, and open when the load failed', () => {
    assert.equal(blockOpen(null, skillOpenness('running')), false);
    assert.equal(blockOpen(null, skillOpenness('finished')), false);
    assert.equal(blockOpen(null, skillOpenness('failed')), true);
  });

  test("the reader's choice on a load_skill block stands over its call", () => {
    assert.equal(blockOpen(true, skillOpenness('running')), true);
    assert.equal(blockOpen(true, skillOpenness('finished')), true);
    assert.equal(blockOpen(false, skillOpenness('failed')), false);
  });
});
