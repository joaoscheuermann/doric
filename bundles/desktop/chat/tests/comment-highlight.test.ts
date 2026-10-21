// Where a comment's quoted words stand among the text runs a block draws: the
// transcript keeps the passage highlighted by finding the seat's quote again
// each time the answer is drawn, whitespace aside, at the occurrence nearest
// where the reader's selection started.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  locateQuote,
  solidLength,
} from '../src/client/domain/comment-highlight.js';

describe('locateQuote', () => {
  test('finds the words inside one run', () => {
    assert.deepEqual(
      locateQuote(['It lives in src/parser.ts.'], 'src/parser.ts'),
      {
        start: { segment: 0, offset: 12 },
        end: { segment: 0, offset: 25 },
      },
    );
  });

  test('finds words that run across several runs and blocks, whitespace aside', () => {
    // Two paragraphs: the selection's text joins them with a blank line the
    // drawn blocks do not hold, and a bold run splits the first one.
    const runs = ['The card ', 'now', ' follows', 'Dark mode broke'];

    assert.deepEqual(locateQuote(runs, 'now follows\n\nDark mode'), {
      start: { segment: 1, offset: 0 },
      end: { segment: 3, offset: 9 },
    });
  });

  test('takes the occurrence nearest where the selection started', () => {
    const runs = ['the form, then the form again'];
    const second = solidLength('the form, then ');

    assert.deepEqual(locateQuote(runs, 'the form'), {
      start: { segment: 0, offset: 0 },
      end: { segment: 0, offset: 8 },
    });
    assert.deepEqual(locateQuote(runs, 'the form', second), {
      start: { segment: 0, offset: 15 },
      end: { segment: 0, offset: 23 },
    });
  });

  test('answers nothing once the runs no longer hold the words', () => {
    assert.equal(
      locateQuote(['It lives in src/lexer.ts.'], 'src/parser.ts'),
      undefined,
    );
    assert.equal(locateQuote([], 'src/parser.ts'), undefined);
  });

  test('answers nothing for a quote without words', () => {
    assert.equal(locateQuote(['It lives here.'], ' \n '), undefined);
  });
});

describe('solidLength', () => {
  test('counts the characters that are not whitespace', () => {
    assert.equal(solidLength(' a b\n\tc '), 3);
    assert.equal(solidLength(''), 0);
  });
});
