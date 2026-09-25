import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { collapsed, fenced } from '../src/domain/markdown';

describe('markdown that will not be escaped by its own value', () => {
  test('fences a value in three backticks, and names its language', () => {
    assert.equal(fenced('{}', 'json'), '```json\n{}\n```');
  });

  test('uses a longer fence than any the value itself holds', () => {
    assert.equal(fenced('a ``` b'), '````\na ``` b\n````');
  });

  test('keeps a value that holds nothing readable', () => {
    assert.equal(fenced(''), '```\n\n```');
  });
});

describe('folding whitespace back to where it came from', () => {
  test('collapses every run of whitespace to one space', () => {
    const { text, offsets } = collapsed('one\n\ntwo   three');
    assert.equal(text, 'one two three');
    assert.equal(offsets.length, text.length);
  });

  test('points every folded character back at a character of the source', () => {
    const source = 'one\n\ntwo   three';
    const { text, offsets } = collapsed(source);
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character !== ' ') {
        assert.equal(source[offsets[index] ?? -1], character);
      }
    }
  });

  test('maps a quote that spans a line break back to the words selected', () => {
    const source = 'first line\nsecond line';
    const { text, offsets } = collapsed(source);
    assert.equal(text, 'first line second line');
    const quote = 'line second';
    const start = text.indexOf(quote);
    const end = start + quote.length;
    const from = offsets[start] ?? 0;
    const to = (offsets[end - 1] ?? 0) + 1;
    assert.equal(source.slice(from, to), 'line\nsecond');
  });

  test('never leaves a leading or trailing space', () => {
    assert.equal(collapsed('  \n padded \n ').text, 'padded');
    assert.equal(collapsed('\n\n').text, '');
  });

  test('keeps a surrogate pair whole, so an emoji is never sliced in half', () => {
    const source = 'a \ud83c\udf89 b';
    const { text, offsets } = collapsed(source);
    assert.equal(text, source);
    assert.equal(
      source.slice(offsets[2] ?? 0, (offsets[3] ?? 0) + 1),
      '\ud83c\udf89',
    );
  });
});
