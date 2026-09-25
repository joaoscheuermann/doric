import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  COMMENTS_HEADING,
  composePrompt,
  locateQuote,
  parsePrompt,
  type PromptComment,
  quoteOf,
  REQUEST_HEADING,
} from '../src/domain/comments';

const comment = (id: string, quote: string, body: string): PromptComment => ({
  id,
  quote,
  body,
});

/**
 * The lines as one text, so a literal can show the space a body was written
 * with even when it holds nothing.
 */
const joined = (lines: readonly string[]): string => lines.join('\n');

describe('the quote as it is stored', () => {
  test('is trimmed, with every run of whitespace collapsed to one space', () => {
    assert.equal(quoteOf('  one\n\n  two\tthree '), 'one two three');
  });

  test('is empty when the selection holds nothing', () => {
    assert.equal(quoteOf(' \n\t '), '');
  });
});

describe('the prompt a request becomes', () => {
  test('is the request untouched when there are no comments to carry', () => {
    assert.equal(composePrompt([], 'ship it'), 'ship it');
  });

  test('is the request untouched when every comment has an empty body', () => {
    assert.equal(
      composePrompt([comment('a', 'a quote', '   ')], 'ship it'),
      'ship it',
    );
  });

  test('numbers the comments from one, then writes the request, one blank line apart', () => {
    assert.equal(
      composePrompt(
        [
          comment('a', 'the first quote', 'the first note'),
          comment('b', 'the second quote', 'the second note'),
        ],
        'do the thing',
      ),
      '# User comments\n' +
        '1. "the first quote": the first note\n' +
        '2. "the second quote": the second note\n' +
        '\n' +
        '# User request\n' +
        'do the thing',
    );
  });

  test('drops a comment with an empty body and numbers the ones that stay', () => {
    assert.equal(
      composePrompt(
        [
          comment('a', 'kept', 'a note'),
          comment('b', 'dropped', '  '),
          comment('c', 'kept too', 'another note'),
        ],
        'go',
      ),
      joined([
        COMMENTS_HEADING,
        '1. "kept": a note',
        '2. "kept too": another note',
        '',
        REQUEST_HEADING,
        'go',
      ]),
    );
  });

  test('escapes a quote inside the quote and inside the body', () => {
    assert.equal(
      composePrompt([comment('a', 'he said "no"', 'answer the "why"')], 'go'),
      '# User comments\n' +
        '1. "he said \\"no\\"": answer the \\"why\\"\n' +
        '\n' +
        '# User request\n' +
        'go',
    );
  });

  test('writes a line break in a quote or a body as a space, so a comment stays one line', () => {
    assert.equal(
      composePrompt([comment('a', 'one\ntwo', 'note')], 'go'),
      joined([
        COMMENTS_HEADING,
        '1. "one two": note',
        '',
        REQUEST_HEADING,
        'go',
      ]),
    );
    assert.equal(
      composePrompt([comment('a', 'q', 'one\ntwo')], 'go'),
      joined([COMMENTS_HEADING, '1. "q": one two', '', REQUEST_HEADING, 'go']),
    );
  });
});

describe('reading a sent prompt back', () => {
  test('reads back the comments and the request the prompt was written from', () => {
    const prompt = composePrompt(
      [
        comment('a', 'the first quote', 'the first note'),
        comment('b', 'the second quote', 'the second note'),
      ],
      'do the thing',
    );
    assert.deepEqual(parsePrompt(prompt), {
      comments: [
        { id: 'parsed:1', quote: 'the first quote', body: 'the first note' },
        { id: 'parsed:2', quote: 'the second quote', body: 'the second note' },
      ],
      request: 'do the thing',
    });
  });

  test('reads a quote that holds a quote of its own back whole', () => {
    const prompt = composePrompt(
      [comment('a', 'he said "no"', 'the "why"')],
      'go',
    );
    assert.deepEqual(parsePrompt(prompt).comments, [
      { id: 'parsed:1', quote: 'he said "no"', body: 'the "why"' },
    ]);
  });

  test('reads a body written from several lines back as one line', () => {
    const prompt = composePrompt([comment('a', 'q', 'one\ntwo')], 'go');
    assert.deepEqual(parsePrompt(prompt).comments, [
      { id: 'parsed:1', quote: 'q', body: 'one two' },
    ]);
  });

  test('reads a text with no comments heading as a request alone', () => {
    const text = 'ship the thing\n\nand say what you did';
    assert.deepEqual(parsePrompt(text), { comments: [], request: text });
  });

  test('keeps the text after the first request heading, so a request may hold one', () => {
    const request = 'do it\n\n# User request\n\nagain';
    const prompt = composePrompt([comment('a', 'q', 'a note')], request);
    assert.deepEqual(parsePrompt(prompt), {
      comments: [{ id: 'parsed:1', quote: 'q', body: 'a note' }],
      request,
    });
  });

  test('keeps a request of several lines whole', () => {
    const request = 'first line\n\nsecond line';
    const prompt = composePrompt([comment('a', 'q', 'a note')], request);
    assert.equal(parsePrompt(prompt).request, request);
  });

  test('keeps a comment the log holds with an empty body', () => {
    const prompt = joined([
      COMMENTS_HEADING,
      '1. "the quote": ',
      '',
      REQUEST_HEADING,
      'go',
    ]);
    assert.deepEqual(parsePrompt(prompt), {
      comments: [{ id: 'parsed:1', quote: 'the quote', body: '' }],
      request: 'go',
    });
  });

  test('ends the comments block at the first line that is not a numbered comment', () => {
    const prompt = joined([
      COMMENTS_HEADING,
      '1. "kept": a note',
      '2. "read too": another note',
      'a line that is not a comment',
      '2. "not read": ignored',
    ]);
    assert.deepEqual(parsePrompt(prompt), {
      comments: [
        { id: 'parsed:1', quote: 'kept', body: 'a note' },
        { id: 'parsed:2', quote: 'read too', body: 'another note' },
      ],
      request: 'a line that is not a comment\n2. "not read": ignored',
    });
  });
});

describe('where a quote sits in an answer', () => {
  test('is the range of its first occurrence', () => {
    assert.deepEqual(locateQuote('say it once, say it twice', 'say it'), {
      start: 0,
      end: 6,
    });
  });

  test('is nothing when the answer does not hold the quote', () => {
    assert.equal(locateQuote('an answer', 'a quote'), undefined);
  });

  test('reads the quote as it is written, so case matters', () => {
    assert.equal(locateQuote('the word is here', 'Here'), undefined);
  });

  test('is nothing when the answer breaks the quote across a paragraph', () => {
    const quote = quoteOf('the quick\n\nbrown fox');
    assert.equal(quote, 'the quick brown fox');
    assert.equal(
      locateQuote('the quick\n\nbrown fox jumps over', quote),
      undefined,
    );
  });
});
