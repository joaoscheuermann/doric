import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { DelegatedInput } from '../src/domain/delegated';
import type {
  AgentTurn,
  QueuedTurn,
  ThinkingTurn,
  Turn,
  UserTurn,
} from '../src/domain/projector';
import {
  activeMarkerIndex,
  markerEmphasis,
  markerScrollTop,
  threadMarkers,
} from '../src/domain/thread-nav';
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

const queued = (promptId: string, sequence: number): QueuedTurn => ({
  type: 'queued',
  promptId,
  events: [event(sequence)],
  items: [
    { promptId, text: 'First queued prompt', source: { kind: 'user' } },
    {
      promptId: `${promptId}-next`,
      text: 'Second queued prompt',
      source: { kind: 'user' },
    },
  ],
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

describe('threadMarkers', () => {
  test('stands one marker per prompt the reader wrote, in transcript order', () => {
    const turns: readonly Turn[] = [
      user('a', 1),
      agent('a', 2),
      user('b', 3),
      thinking('b', 4),
      user('c', 5),
    ];

    assert.deepEqual(
      threadMarkers(turns).map((marker) => marker.promptId),
      ['a', 'b', 'c'],
    );
  });

  test('takes no marker for a prompt the host has not accepted yet', () => {
    const turns: readonly Turn[] = [user('a', 1), agent('a', 2), sent('words')];

    assert.deepEqual(
      threadMarkers(turns).map((marker) => marker.promptId),
      ['a'],
    );
  });

  test('adds a result handle at the delegated turn but skips a parent instruction', () => {
    const turns: readonly Turn[] = [
      user('a', 1),
      delegated('d', 2),
      {
        ...delegated('parent', 3),
        delegated: { kind: 'parent', threadId: 'parent', text: 'task' },
      },
      user('b', 4),
    ];

    assert.deepEqual(
      threadMarkers(turns).map((marker) => [marker.kind, marker.promptId]),
      [
        ['prompt', 'a'],
        ['result', 'd'],
        ['prompt', 'b'],
      ],
    );
    assert.equal(threadMarkers(turns)[1]?.text, 'done');
    const result = threadMarkers(turns).find(
      (marker) => marker.kind === 'result',
    );
    assert.equal(result?.threadId, 'child');
  });

  test('adds one queued handle for a grouped receipt before its later prompt', () => {
    const markers = threadMarkers([
      queued('a', 1),
      user('a', 2),
      agent('a', 3),
    ]);

    assert.deepEqual(
      markers.map((marker) => [marker.kind, marker.promptId]),
      [
        ['queued', 'a'],
        ['prompt', 'a'],
      ],
    );
    assert.equal(
      markers[0]?.text,
      'First queued prompt\n\nSecond queued prompt',
    );
  });

  test('carries the prompt words as the handle content', () => {
    const markers = threadMarkers([user('a', 1, 'First line\nsecond line')]);

    assert.deepEqual(
      markers.map((marker) => marker.text),
      ['First line\nsecond line'],
    );
  });

  test('trims the words a handle carries', () => {
    const markers = threadMarkers([user('a', 1, '  question  ')]);

    assert.deepEqual(
      markers.map((marker) => marker.text),
      ['question'],
    );
  });
});

describe('markerScrollTop', () => {
  test('places an interior marker at 40% of the viewport', () => {
    assert.equal(markerScrollTop(1400, 1000, 2000), 1000);
  });

  test('keeps first and last markers within the available scroll range', () => {
    assert.equal(markerScrollTop(24, 1000, 2000), 0);
    assert.equal(markerScrollTop(2600, 1000, 2000), 2000);
  });
});

describe('activeMarkerIndex', () => {
  const prompts = (tops: readonly (number | null)[]) =>
    tops.map((top) => ({ kind: 'prompt' as const, top }));

  test('names the prompt the viewport top is at', () => {
    assert.equal(activeMarkerIndex(prompts([100, 500]), 500, 300), 1);
  });

  test('names the nearest prompt above the reading line between markers', () => {
    assert.equal(activeMarkerIndex(prompts([100, 500, 900]), 350, 300), 0);
  });

  test('names the prompt crossing the reading line at 40% of the viewport', () => {
    assert.equal(activeMarkerIndex(prompts([100, 500]), 350, 400), 1);
  });

  test('names the first prompt while the reader is above every marker', () => {
    assert.equal(activeMarkerIndex(prompts([100, 500]), 0, 300), 0);
  });

  test('names the last prompt once the reader is past every marker', () => {
    assert.equal(activeMarkerIndex(prompts([100, 500]), 1200, 300), 1);
  });

  test('skips a block the surface has not drawn yet', () => {
    assert.equal(activeMarkerIndex(prompts([100, null, 900]), 950, 300), 2);
    assert.equal(activeMarkerIndex(prompts([null, 500]), 400, 300), 1);
  });

  test('highlights nothing when no marker is drawn', () => {
    assert.equal(activeMarkerIndex([], 300, 300), -1);
    assert.equal(activeMarkerIndex(prompts([null, null]), 300, 300), -1);
  });

  test('highlights a subthread result when it appears below the viewport top', () => {
    const markers = [
      { kind: 'prompt' as const, top: 100 },
      { kind: 'result' as const, top: 550 },
    ];

    assert.equal(activeMarkerIndex(markers, 300, 300), 1);
    assert.equal(activeMarkerIndex(markers, 300, 250), 0);
  });
});

describe('markerEmphasis', () => {
  test('steps down symmetrically from the hovered handle to distant handles', () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((index) => markerEmphasis(index, 5)),
      [3, 3, 2, 1, 0, 1, 2, 3, 3],
    );
  });

  test('leaves every handle at its resting emphasis when none is hovered', () => {
    assert.equal(markerEmphasis(0, -1), 3);
  });
});
