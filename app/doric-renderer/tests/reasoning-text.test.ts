import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { reasoningText } from '../src/utility/reasoning-text';

describe('a run of reasoning read back into prose', () => {
  test('joins the breaks a model streams between words into one flow', () => {
    assert.equal(
      reasoningText('I now\n\n\n have\n\n everything\n\n\n to\n\n answer'),
      'I now have everything to answer',
    );
  });

  test('keeps a word the model split across chunks as one word', () => {
    assert.equal(reasoningText('mim\n\n\nada'), 'mimada');
  });

  test('keeps the paragraph a sentence ends on', () => {
    assert.equal(
      reasoningText('Done.\n\nNext one.\n\nAnd the last.'),
      'Done.\n\nNext one.\n\nAnd the last.',
    );
    // A capital after a blank line opens a paragraph of its own too.
    assert.equal(
      reasoningText('reconcile their work\n\nThis is a big task.'),
      'reconcile their work\n\nThis is a big task.',
    );
  });

  test('keeps the lines the model opens as structure', () => {
    assert.equal(
      reasoningText('The plan:\n- first\n- second'),
      'The plan:\n- first\n- second',
    );
    assert.equal(
      reasoningText('The user wants me to:\n1. one\n2. two'),
      'The user wants me to:\n1. one\n2. two',
    );
  });

  test('trims the whitespace a run starts and ends with', () => {
    assert.equal(reasoningText('\n\n thought\n\n'), 'thought');
    assert.equal(reasoningText('   '), '');
  });
});
