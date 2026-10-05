import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  caretKind,
  enterAction,
  entryItem,
  nextItem,
  nextStop,
} from '../src/domain/caret-navigation';
import {
  ACTIVITY_TURN_BLOCK,
  AGENT_TURN_BLOCK,
  LIFECYCLE_TURN_BLOCK,
  THINKING_TURN_BLOCK,
  TOOL_TURN_BLOCK,
  TURN_AUTHOR_BLOCK,
  USER_PROMPT_BLOCK,
  USER_TURN_BLOCK,
} from '../src/domain/conversation-nodes';

describe('how the caret treats a block', () => {
  test('skips consecutive pause and resume markers in both directions', () => {
    const blocks = [
      AGENT_TURN_BLOCK,
      LIFECYCLE_TURN_BLOCK,
      LIFECYCLE_TURN_BLOCK,
      TURN_AUTHOR_BLOCK,
      USER_PROMPT_BLOCK,
    ];
    assert.equal(nextStop(blocks, 0, 'next'), 4);
    assert.equal(nextStop(blocks, 4, 'previous'), 0);
    assert.equal(enterAction([LIFECYCLE_TURN_BLOCK], false), 'nothing');
  });

  test('stays at the content edge when only lifecycle markers remain', () => {
    assert.equal(
      nextStop([AGENT_TURN_BLOCK, LIFECYCLE_TURN_BLOCK], 0, 'next'),
      undefined,
    );
    assert.equal(
      nextStop([LIFECYCLE_TURN_BLOCK, AGENT_TURN_BLOCK], 1, 'previous'),
      undefined,
    );
  });
  test('focuses delegated instructions and results as widgets and toggles with Enter', () => {
    const result = 'delegated-turn-node';
    assert.equal(caretKind(result), 'widget');
    assert.equal(enterAction([result], false), 'toggle');
    assert.equal(enterAction([result], true), 'default');
    assert.equal(
      nextStop([result, TURN_AUTHOR_BLOCK, USER_PROMPT_BLOCK], 0, 'next'),
      2,
    );
  });
  test('never enters an author line', () => {
    assert.equal(caretKind(TURN_AUTHOR_BLOCK), 'furniture');
  });

  test('focuses a thinking run, a tool call and an activity summary as one stop', () => {
    for (const type of [
      THINKING_TURN_BLOCK,
      TOOL_TURN_BLOCK,
      ACTIVITY_TURN_BLOCK,
    ]) {
      assert.equal(caretKind(type), 'widget', type);
    }
  });

  test('crosses the turns and the prompt as text', () => {
    for (const type of [
      USER_TURN_BLOCK,
      AGENT_TURN_BLOCK,
      USER_PROMPT_BLOCK,
      'heading',
      'table',
      'a-block-this-vocabulary-does-not-know',
    ]) {
      assert.equal(caretKind(type), 'text', type);
    }
  });
});

describe('where the caret stops beside author lines', () => {
  test('moves to the adjacent block when it is a stop itself', () => {
    assert.equal(nextStop([USER_TURN_BLOCK, AGENT_TURN_BLOCK], 0, 'next'), 1);
    assert.equal(
      nextStop([USER_TURN_BLOCK, AGENT_TURN_BLOCK], 1, 'previous'),
      0,
    );
  });

  test('steps over the author line to the block after it', () => {
    const blocks = [USER_TURN_BLOCK, TURN_AUTHOR_BLOCK, AGENT_TURN_BLOCK];
    assert.equal(nextStop(blocks, 0, 'next'), 2);
  });

  test('steps over a run of author lines', () => {
    const blocks = [
      USER_TURN_BLOCK,
      TURN_AUTHOR_BLOCK,
      TURN_AUTHOR_BLOCK,
      THINKING_TURN_BLOCK,
    ];
    assert.equal(nextStop(blocks, 0, 'next'), 3);
    assert.equal(nextStop(blocks, 3, 'previous'), 0);
  });

  test('finds the block before an author line in the other direction', () => {
    const blocks = [USER_TURN_BLOCK, TURN_AUTHOR_BLOCK, AGENT_TURN_BLOCK];
    assert.equal(nextStop(blocks, 1, 'previous'), 0);
    assert.equal(nextStop(blocks, 2, 'previous'), 0);
  });

  test('stops on a widget beside an author line', () => {
    const blocks = [THINKING_TURN_BLOCK, TURN_AUTHOR_BLOCK, USER_PROMPT_BLOCK];
    assert.equal(nextStop(blocks, 1, 'next'), 2);
    assert.equal(nextStop(blocks, 1, 'previous'), 0);
  });

  test('finds no stop past the end or before the start', () => {
    const blocks = [USER_TURN_BLOCK, TURN_AUTHOR_BLOCK];
    assert.equal(nextStop(blocks, 1, 'next'), undefined);
    const led = [TURN_AUTHOR_BLOCK, USER_TURN_BLOCK];
    assert.equal(nextStop(led, 0, 'previous'), undefined);
    assert.equal(nextStop([], 0, 'next'), undefined);
  });
});

describe('how the caret walks the steps of an activity summary', () => {
  test('enters on the header line walking in from above', () => {
    assert.equal(entryItem(3, 'next'), null);
    assert.equal(entryItem(0, 'next'), null);
  });

  test('enters on the last step walking in from below', () => {
    assert.equal(entryItem(3, 'previous'), 2);
  });

  test('enters on the header alone when the summary shows no steps', () => {
    assert.equal(entryItem(0, 'previous'), null);
  });

  test('walks the steps in order from the header down', () => {
    assert.equal(nextItem(null, 3, 'next'), 0);
    assert.equal(nextItem(0, 3, 'next'), 1);
    assert.equal(nextItem(1, 3, 'next'), 2);
  });

  test('walks the steps back up to the header line', () => {
    assert.equal(nextItem(2, 3, 'previous'), 1);
    assert.equal(nextItem(1, 3, 'previous'), 0);
    assert.equal(nextItem(0, 3, 'previous'), null);
  });

  test('leaves past the last step and before the header line', () => {
    assert.equal(nextItem(2, 3, 'next'), 'leave');
    assert.equal(nextItem(null, 3, 'previous'), 'leave');
  });

  test('leaves from the header when the summary shows no steps', () => {
    assert.equal(nextItem(null, 0, 'next'), 'leave');
    assert.equal(nextItem(null, 0, 'previous'), 'leave');
  });
});

describe('what Enter does where the caret is', () => {
  test('opens or closes the one focused widget', () => {
    for (const type of [
      THINKING_TURN_BLOCK,
      TOOL_TURN_BLOCK,
      ACTIVITY_TURN_BLOCK,
    ]) {
      assert.equal(enterAction([type], false), 'toggle', type);
    }
  });

  test('sends on Cmd/Ctrl+Enter instead of toggling', () => {
    assert.equal(enterAction([TOOL_TURN_BLOCK], true), 'default');
    assert.equal(enterAction([], true), 'default');
  });

  test('writes a line in text rather than toggling anything', () => {
    assert.equal(enterAction([], false), 'default');
  });

  test('does nothing on furniture', () => {
    assert.equal(enterAction([TURN_AUTHOR_BLOCK], false), 'nothing');
  });

  test('does nothing over several widgets', () => {
    assert.equal(
      enterAction([THINKING_TURN_BLOCK, TOOL_TURN_BLOCK], false),
      'nothing',
    );
  });

  test('leaves other node selections to the editor', () => {
    assert.equal(enterAction(['table'], false), 'default');
    assert.equal(enterAction([TOOL_TURN_BLOCK, 'table'], false), 'default');
  });
});
