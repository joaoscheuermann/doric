// The inline comment entry's vocabulary, stated in terms of its arguments: what
// a key does while the entry is written, and where in the conversation the
// anchor it was opened for sits. The entry stands after the paragraph the
// reader selected, so the seat it writes is the turn and the block of that
// paragraph — the two the stack item carries until the send.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  commentKeyAction,
  type CommentEntryState,
  seatOfAnchor,
} from '../src/client/domain/comment-entry.js';
import type { NoteKey } from '../src/client/domain/composer-stack.js';

/** A key, as the entry reads it. */
const key = (name: string, shift = false): NoteKey => ({
  key: name,
  mod: false,
  shift,
});

/** The entry holding words, with no composition in progress. */
const writing: CommentEntryState = { empty: false, composing: false };

describe('commentKeyAction', () => {
  test('sends with Enter once the entry holds words', () => {
    assert.equal(commentKeyAction(key('Enter'), writing), 'send');
  });

  test('writes a newline with Shift+Enter, keeping the entry open', () => {
    assert.equal(commentKeyAction(key('Enter', true), writing), 'newline');
  });

  test('leaves Enter to the entry while it is empty', () => {
    assert.equal(
      commentKeyAction(key('Enter'), { ...writing, empty: true }),
      'default',
    );
  });

  test('leaves Enter to the input method while a composition is in progress', () => {
    assert.equal(
      commentKeyAction(key('Enter'), { ...writing, composing: true }),
      'default',
    );
  });

  test('leaves a letter to the entry', () => {
    assert.equal(commentKeyAction(key('a'), writing), 'default');
  });
});

describe('seatOfAnchor', () => {
  test('reads the turn and block a range anchor sits in', () => {
    assert.deepEqual(
      seatOfAnchor({
        form: 'range',
        text: 'x',
        turn: 'agent:p:3',
        block: 2,
      }),
      { turn: 'agent:p:3', block: 2 },
    );
  });

  test('answers nothing for an anchor that names no seat', () => {
    assert.equal(seatOfAnchor({ form: 'range', text: 'x' }), undefined);
  });

  test('refuses a seat that is not a turn and a 0-based block', () => {
    assert.equal(
      seatOfAnchor({ form: 'range', text: 'x', turn: 'agent:p:3', block: -1 }),
      undefined,
    );
    assert.equal(
      seatOfAnchor({ form: 'range', text: 'x', turn: 'agent:p:3', block: 1.5 }),
      undefined,
    );
    assert.equal(
      seatOfAnchor({ form: 'range', text: 'x', turn: '', block: 2 }),
      undefined,
    );
  });

  test('answers nothing for a value that is not an anchor', () => {
    assert.equal(seatOfAnchor(undefined), undefined);
    assert.equal(seatOfAnchor(null), undefined);
    assert.equal(seatOfAnchor('agent:p:3'), undefined);
    assert.equal(seatOfAnchor(2), undefined);
  });
});
