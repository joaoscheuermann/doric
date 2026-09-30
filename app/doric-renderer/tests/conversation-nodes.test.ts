import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ACTIVITY_TURN_BLOCK,
  AGENT_TURN_BLOCK,
  isReadOnlyBlock,
  isUndeletableBlock,
  THINKING_TURN_BLOCK,
  TOOL_TURN_BLOCK,
  TURN_AUTHOR_BLOCK,
  USER_PROMPT_BLOCK,
  USER_TURN_BLOCK,
} from '../src/domain/conversation-nodes';

describe('what a conversation block allows', () => {
  test('keeps every block a deletion could reach', () => {
    for (const type of [
      TURN_AUTHOR_BLOCK,
      USER_TURN_BLOCK,
      AGENT_TURN_BLOCK,
      THINKING_TURN_BLOCK,
      TOOL_TURN_BLOCK,
      ACTIVITY_TURN_BLOCK,
      USER_PROMPT_BLOCK,
    ]) {
      assert.equal(isUndeletableBlock(type), true, type);
    }
    assert.equal(isUndeletableBlock('paragraph'), false);
  });

  test('lets the caret read an agent turn without editing it', () => {
    assert.equal(isReadOnlyBlock(AGENT_TURN_BLOCK), true);
    assert.equal(isReadOnlyBlock(USER_TURN_BLOCK), false);
    assert.equal(isReadOnlyBlock(USER_PROMPT_BLOCK), false);
  });
});
