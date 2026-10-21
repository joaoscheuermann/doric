// The inline comment entry's vocabulary, stated in terms of its arguments: what
// a key does while the comment is written or edited, and whether its note holds
// words.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type CommentEntryState,
  commentKeyAction,
  hasWords,
} from '../src/client/domain/comment-entry.js';
import type { NoteKey } from '../src/client/domain/composer-stack.js';

/** A key, as the entry reads it. */
const key = (
  name: string,
  modifiers: { readonly shift?: boolean; readonly mod?: boolean } = {},
): NoteKey => ({
  key: name,
  mod: modifiers.mod ?? false,
  shift: modifiers.shift ?? false,
});

/** The entry holding words, with no composition in progress. */
const writing: CommentEntryState = { empty: false, composing: false };
/** The entry holding no words. */
const empty: CommentEntryState = { empty: true, composing: false };
/** An input method composing the words. */
const composing: CommentEntryState = { empty: false, composing: true };

describe('commentKeyAction', () => {
  test('commits with Enter once the note holds words', () => {
    assert.equal(commentKeyAction(key('Enter'), writing), 'commit');
  });

  test('writes a newline with Shift+Enter', () => {
    assert.equal(
      commentKeyAction(key('Enter', { shift: true }), writing),
      'newline',
    );
  });

  test('leaves Enter to the note while it is empty', () => {
    assert.equal(commentKeyAction(key('Enter'), empty), 'default');
  });

  test('leaves Cmd/Ctrl+Enter to the window’s send', () => {
    assert.equal(
      commentKeyAction(key('Enter', { mod: true }), writing),
      'default',
    );
  });

  test('removes the comment with Escape, written or empty', () => {
    assert.equal(commentKeyAction(key('Escape'), writing), 'remove');
    assert.equal(commentKeyAction(key('Escape'), empty), 'remove');
  });

  test('removes the comment with Backspace or Delete on an empty note', () => {
    assert.equal(commentKeyAction(key('Backspace'), empty), 'remove');
    assert.equal(commentKeyAction(key('Delete'), empty), 'remove');
  });

  test('leaves Backspace to the note while it holds words', () => {
    assert.equal(commentKeyAction(key('Backspace'), writing), 'default');
  });

  test('leaves every key to the input method while a composition is in progress', () => {
    assert.equal(commentKeyAction(key('Enter'), composing), 'default');
    assert.equal(commentKeyAction(key('Escape'), composing), 'default');
    assert.equal(
      commentKeyAction(key('Backspace'), { empty: true, composing: true }),
      'default',
    );
  });

  test('leaves a letter to the note', () => {
    assert.equal(commentKeyAction(key('a'), writing), 'default');
  });
});

describe('hasWords', () => {
  test('a note with a word holds words, whitespace around it or not', () => {
    assert.equal(hasWords('rename this'), true);
    assert.equal(hasWords('  x \n'), true);
  });

  test('a note of nothing or of whitespace alone is empty', () => {
    assert.equal(hasWords(''), false);
    assert.equal(hasWords('   '), false);
    assert.equal(hasWords(' \n\t '), false);
  });
});
