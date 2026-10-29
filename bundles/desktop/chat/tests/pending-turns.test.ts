import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type SentComment,
  withPendingTurns,
  withSentThreads,
} from '../src/client/domain/pending-turns.js';
import type {
  AgentTurn,
  Turn,
  UserTurn,
} from '../src/client/domain/projector.js';

const prompt = (text: string, awaiting = false): UserTurn => ({
  type: 'user',
  promptId: 'one',
  events: [],
  text,
  accepted: true,
  awaiting,
  comments: [],
});

const answer = (): AgentTurn => ({
  type: 'agent',
  promptId: 'one',
  events: [],
  text: 'hi',
  status: 'streaming',
});

const types = (turns: readonly Turn[]): readonly string[] =>
  turns.map((turn) => turn.type);

describe('the turns a surface waits for', () => {
  test('leaves the log its own turns when nothing is pending', () => {
    const turns = [prompt('hi'), answer()];
    assert.equal(withPendingTurns(turns, undefined), turns);
  });

  test('draws the words the reader sent, which the log does not hold yet', () => {
    const drawn = withPendingTurns([prompt('hi')], {
      text: 'next',
      before: 1,
    });

    assert.deepEqual(types(drawn), ['user', 'user']);
    const sent = drawn[1];
    assert.equal(sent?.type === 'user' && sent.accepted, false);
    assert.equal(sent?.type === 'user' && sent.text, 'next');
  });

  test('stops drawing them once the log has accepted one more prompt', () => {
    const turns = [prompt('hi'), { ...prompt('next'), promptId: 'two' }];
    assert.equal(withPendingTurns(turns, { text: 'next', before: 1 }), turns);
  });

  test("draws the agent's first step while the last prompt is unanswered", () => {
    const drawn = withPendingTurns([prompt('hi', true)], undefined);

    assert.deepEqual(types(drawn), ['user', 'thinking']);
    const step = drawn[1];
    assert.equal(step?.type === 'thinking' && step.streaming, true);
    assert.equal(step?.type === 'thinking' && step.text, '');
    assert.equal(step?.promptId, 'one');
  });

  test('draws no step for a prompt that already produced something', () => {
    const turns = [prompt('hi'), answer()];
    assert.equal(withPendingTurns(turns, undefined), turns);
  });

  test('keeps the waiting step before a newer prompt', () => {
    const drawn = withPendingTurns([prompt('hi', true)], {
      text: 'next',
      before: 1,
    });
    assert.deepEqual(types(drawn), ['user', 'thinking', 'user']);
  });

  test('does not bring the words back when the answer becomes the last turn', () => {
    const turns = [prompt('hi'), answer()];
    assert.equal(withPendingTurns(turns, { text: 'hi', before: 0 }), turns);
  });

  test("draws the words when a bundle's instruction is among the log's prompts", () => {
    // The coding workflow's instruction is not a prompt the reader sent, so
    // it is not among the reader's prompts counted when the words left.
    const instruction: UserTurn = {
      ...prompt(''),
      promptId: 'workflow',
      instruction: { bundleId: 'default', reason: 'coding-workflow' },
    };
    const drawn = withPendingTurns(
      [instruction, { ...prompt('hi'), promptId: 'two' }, answer()],
      { text: 'next', before: 1 },
    );

    assert.deepEqual(types(drawn), ['user', 'user', 'agent', 'user']);
    const sent = drawn.at(-1);
    assert.equal(sent?.type === 'user' && sent.text, 'next');
    assert.equal(sent?.type === 'user' && sent.accepted, false);
  });

  test("draws the words when a background terminal's result is among the log's prompts", () => {
    const result: UserTurn = {
      ...prompt(''),
      promptId: 'terminal',
      terminal: {
        terminalId: 't1',
        promptId: 'one',
        command: 'npm test',
        exitCode: 0,
        reason: 'exited',
        durationMs: 10,
        stdout: '',
        stderr: '',
      },
    };
    const drawn = withPendingTurns([prompt('hi'), answer(), result], {
      text: 'next',
      before: 1,
    });

    const sent = drawn.at(-1);
    assert.equal(sent?.type === 'user' && sent.text, 'next');
    assert.equal(sent?.type === 'user' && sent.accepted, false);
  });
});

const comment = (commentId: string, text = 'a note') => ({
  commentId,
  target: { kind: 'message', id: 'zero', anchor: { form: 'range', text } },
  text,
});

const sent = (promptId: string, commentId: string): SentComment => ({
  promptId,
  comment: comment(commentId),
});

const commentIds = (turn: Turn | undefined): readonly string[] =>
  turn?.type === 'user' ? turn.comments.map((held) => held.commentId) : [];

describe('the comments a surface draws before the log holds them', () => {
  test('a sent prompt wears the comments it carries above its words', () => {
    const drawn = withPendingTurns([prompt('hi')], {
      text: 'next',
      before: 1,
      comments: [comment('comment-a'), comment('comment-b')],
    });

    assert.deepEqual(commentIds(drawn[1]), ['comment-a', 'comment-b']);
  });

  test('an accepted prompt wears its sent comments after the ones its log holds', () => {
    const logged: UserTurn = {
      ...prompt('hi'),
      comments: [comment('comment-a')],
    };
    const drawn = withPendingTurns([logged, answer()], undefined, [
      sent('one', 'comment-a'),
      sent('one', 'comment-b'),
      sent('other', 'comment-c'),
    ]);

    assert.deepEqual(commentIds(drawn[0]), ['comment-a', 'comment-b']);
  });

  test('leaves the log its own turns once it holds every comment sent', () => {
    const turns = [{ ...prompt('hi'), comments: [comment('comment-a')] }];
    assert.equal(
      withPendingTurns(turns, undefined, [sent('one', 'comment-a')]),
      turns,
    );
  });

  test('folds the comments sent into the threads, as the log will', () => {
    const threads = withSentThreads(new Map(), [sent('one', 'comment-a')]);

    assert.deepEqual(
      threads.get('comment-a')?.messages.map((held) => held.text),
      ['a note'],
    );
    const none = new Map();
    assert.equal(withSentThreads(none, []), none);
  });
});
