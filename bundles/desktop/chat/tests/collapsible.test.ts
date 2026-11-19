import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { blockOpen, blockToggled } from 'desktop/ui/collapsible-block';

import {
  replyOpenness,
  settledOpenness,
  terminalResultOpenness,
  thinkingOpenness,
  toolOpenness,
} from '../src/client/domain/collapsible.js';

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
      blockOpen(
        null,
        toolOpenness('failed', 'ls', undefined, {
          code: '',
          message: 'denied',
          causes: [],
        }),
      ),
      false,
    );
  });

  test('a tool-call block with openByDefault stays open once settled until the reader closes it', () => {
    const settled = toolOpenness(
      'finished',
      '{"path":"a.ts"}',
      '{"success":true}',
      undefined,
      true,
    );
    assert.equal(settled.active, false);
    assert.equal(blockOpen(null, settled), true);
    assert.equal(blockToggled(null, settled), false);
    assert.equal(blockOpen(false, settled), false);
  });

  test('a tool-call block without openByDefault folds once settled', () => {
    const settled = toolOpenness(
      'finished',
      '{"path":"a.ts"}',
      '{"success":true}',
      undefined,
      false,
    );
    assert.equal(blockOpen(null, settled), false);
    assert.equal(blockToggled(null, settled), true);
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
});
