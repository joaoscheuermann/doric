import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { reasoningText } from '../src/utility/reasoning-text';

describe('a run of reasoning as one flow', () => {
  test('turns the line breaks a model streams between tokens into one flow', () => {
    assert.equal(
      reasoningText('The user is\n\n asking for\n\n\n a\n\n\n "mim'),
      'The user is asking for a "mim',
    );
  });

  test('keeps a word the model split across chunks as one word', () => {
    assert.equal(reasoningText('mim\n\n\nada'), 'mimada');
  });

  test('leaves the single spaces between words alone', () => {
    assert.equal(
      reasoningText('Portuguese\n slang\n for'),
      'Portuguese slang for',
    );
    assert.equal(reasoningText('The user is asking.'), 'The user is asking.');
  });

  test('trims the whitespace a run starts and ends with', () => {
    assert.equal(reasoningText('\n\n thought\n\n'), 'thought');
    assert.equal(reasoningText('   '), '');
  });
});
