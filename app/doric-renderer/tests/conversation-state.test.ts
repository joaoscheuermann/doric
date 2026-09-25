import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { PromptComment } from '../src/domain/comments';
import {
  type ConversationState,
  conversationState,
  emptyConversationState,
} from '../src/domain/conversation';

const comment = (id: string, body: string): PromptComment => ({
  body,
  id,
  quote: 'say it',
});

describe('the surface state', () => {
  test('adds a comment, rewrites a body, and leaves an unknown body alone', () => {
    const added = conversationState(emptyConversationState, {
      kind: 'comment-added',
      comment: comment('c1', 'first'),
    });
    assert.deepEqual(added.comments, [comment('c1', 'first')]);
    const rewritten = conversationState(added, {
      kind: 'comment-body',
      id: 'c1',
      body: 'second',
    });
    assert.deepEqual(rewritten.comments, [comment('c1', 'second')]);
    const untouched = conversationState(rewritten, {
      kind: 'comment-body',
      id: 'nope',
      body: 'x',
    });
    assert.equal(untouched, rewritten);
  });

  test('removes a comment by its id', () => {
    const state: ConversationState = {
      ...emptyConversationState,
      comments: [comment('c1', 'a'), comment('c2', 'b')],
    };
    assert.deepEqual(
      conversationState(state, { kind: 'comment-removed', id: 'c1' }).comments,
      [comment('c2', 'b')],
    );
  });

  test('toggles a fold key on, then off', () => {
    const opened = conversationState(emptyConversationState, {
      kind: 'fold-toggled',
      key: 'agent:a:seg:0',
    });
    assert.deepEqual([...opened.open], ['agent:a:seg:0']);
    const closed = conversationState(opened, {
      kind: 'fold-toggled',
      key: 'agent:a:seg:0',
    });
    assert.deepEqual([...closed.open], []);
  });

  test('seeds an edit with the comments the prompt already held, apart from the ones being written', () => {
    const typing: ConversationState = {
      ...emptyConversationState,
      comments: [comment('c1', 'mine')],
    };
    const started = conversationState(typing, {
      kind: 'edit-started',
      promptId: 'a',
      comments: [comment('parsed:1', 'held')],
    });
    assert.equal(started.editing, 'a');
    assert.deepEqual(started.editComments, [comment('parsed:1', 'held')]);
    assert.deepEqual(started.comments, [comment('c1', 'mine')]);

    // The edit's own comments go back where they came from on cancel, and what
    // the person was writing before the edit is still theirs.
    const cancelled = conversationState(started, { kind: 'edit-cancelled' });
    assert.equal(cancelled.editing, undefined);
    assert.deepEqual(cancelled.editComments, []);
    assert.deepEqual(cancelled.comments, [comment('c1', 'mine')]);
  });

  test('rewrites the body of a comment on either side of an edit', () => {
    const state: ConversationState = {
      editing: 'a',
      open: new Set<string>(),
      comments: [comment('c1', 'mine')],
      editComments: [comment('parsed:1', 'held')],
    };
    const edited = conversationState(state, {
      kind: 'comment-body',
      id: 'parsed:1',
      body: 'rewritten',
    });
    assert.deepEqual(edited.editComments, [comment('parsed:1', 'rewritten')]);
    assert.deepEqual(edited.comments, [comment('c1', 'mine')]);
  });

  test('clears the comments and the edit on submit, but keeps the folds', () => {
    const state: ConversationState = {
      editing: 'a',
      open: new Set(['agent:a:seg:0']),
      comments: [comment('c1', 'sent')],
      editComments: [comment('parsed:1', 'held')],
    };
    const submitted = conversationState(state, { kind: 'submitted' });
    assert.equal(submitted.editing, undefined);
    assert.deepEqual(submitted.comments, []);
    assert.deepEqual(submitted.editComments, []);
    assert.deepEqual([...submitted.open], ['agent:a:seg:0']);
  });
});
