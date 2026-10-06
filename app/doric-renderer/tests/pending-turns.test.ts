import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { withPendingTurns } from '../src/domain/pending-turns';
import type { AgentTurn, Turn, UserTurn } from '../src/domain/projector';

const prompt = (text: string, awaiting = false): UserTurn => ({
  type: 'user',
  promptId: 'one',
  events: [],
  text,
  accepted: true,
  awaiting,
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
});
