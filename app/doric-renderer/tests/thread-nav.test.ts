import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { DelegatedInput } from '../src/domain/delegated';
import type {
  AgentTurn,
  ThinkingTurn,
  Turn,
  UserTurn,
} from '../src/domain/projector';
import { activeMarkerIndex, promptMarkers } from '../src/domain/thread-nav';
import type { ThreadEvent } from '../src/domain/workspace';

const event = (sequence: number): ThreadEvent => ({
  projectId: 'project',
  threadId: 'thread',
  promptId: 'prompt',
  sequence,
  type: 'text.delta',
  event: { type: 'text.delta', delta: '' },
  createdAt: '2026-01-01T00:00:00.000Z',
});

const user = (
  promptId: string,
  sequence: number,
  text = 'question',
): UserTurn => ({
  type: 'user',
  promptId,
  events: [event(sequence)],
  text,
  accepted: true,
  awaiting: false,
});

/** A prompt the reader sent that the log does not hold yet. */
const sent = (text: string): UserTurn => ({
  type: 'user',
  promptId: '',
  events: [],
  text,
  accepted: false,
  awaiting: false,
});

const delegatedInput: DelegatedInput = {
  kind: 'result',
  threadId: 'child',
  text: 'done',
};

const delegated = (promptId: string, sequence: number): UserTurn => ({
  ...user(promptId, sequence),
  text: '',
  delegated: delegatedInput,
});

const agent = (promptId: string, sequence: number): AgentTurn => ({
  type: 'agent',
  promptId,
  events: [event(sequence)],
  text: 'answer',
  status: 'completed',
});

const thinking = (promptId: string, sequence: number): ThinkingTurn => ({
  type: 'thinking',
  promptId,
  events: [event(sequence)],
  text: 'thought',
  streaming: false,
});

describe('promptMarkers', () => {
  test('stands one marker per prompt the reader wrote, in transcript order', () => {
    const turns: readonly Turn[] = [
      user('a', 1),
      agent('a', 2),
      user('b', 3),
      thinking('b', 4),
      user('c', 5),
    ];

    assert.deepEqual(
      promptMarkers(turns).map((marker) => marker.promptId),
      ['a', 'b', 'c'],
    );
  });

  test('takes no marker for a prompt the host has not accepted yet', () => {
    const turns: readonly Turn[] = [user('a', 1), agent('a', 2), sent('words')];

    assert.deepEqual(
      promptMarkers(turns).map((marker) => marker.promptId),
      ['a'],
    );
  });

  test('takes no marker for a delegated input', () => {
    const turns: readonly Turn[] = [
      user('a', 1),
      delegated('d', 2),
      user('b', 3),
    ];

    assert.deepEqual(
      promptMarkers(turns).map((marker) => marker.promptId),
      ['a', 'b'],
    );
  });

  test('carries the prompt words as the handle content', () => {
    const markers = promptMarkers([user('a', 1, 'First line\nsecond line')]);

    assert.deepEqual(
      markers.map((marker) => marker.text),
      ['First line\nsecond line'],
    );
  });

  test('trims the words a handle carries', () => {
    const markers = promptMarkers([user('a', 1, '  question  ')]);

    assert.deepEqual(
      markers.map((marker) => marker.text),
      ['question'],
    );
  });
});

describe('activeMarkerIndex', () => {
  test('names the prompt the viewport top is at', () => {
    assert.equal(activeMarkerIndex([100, 500], 500), 1);
  });

  test('names the nearest prompt above the viewport top between markers', () => {
    assert.equal(activeMarkerIndex([100, 500, 900], 499.5), 0);
  });

  test('names the first prompt while the reader is above every marker', () => {
    assert.equal(activeMarkerIndex([100, 500], 0), 0);
  });

  test('names the last prompt once the reader is past every marker', () => {
    assert.equal(activeMarkerIndex([100, 500], 1200), 1);
  });

  test('skips a block the surface has not drawn yet', () => {
    assert.equal(activeMarkerIndex([100, null, 900], 950), 2);
    assert.equal(activeMarkerIndex([null, 500], 400), 1);
  });

  test('highlights nothing when no marker is drawn', () => {
    assert.equal(activeMarkerIndex([], 300), -1);
    assert.equal(activeMarkerIndex([null, null], 300), -1);
  });
});
