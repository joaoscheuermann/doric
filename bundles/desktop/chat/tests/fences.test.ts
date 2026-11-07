// The fences of a registered tag in the agent's answers (openui.md D1, D2):
// their keys, bodies and states, read from the turns the transcript draws.
//
// Contract matrix (B1):
// - each fence of a registered tag is one `ChatFence` keyed
//   `<promptId>/<turnSequence>/<index>`, its index counted among the fences of
//   its tag in its turn, in transcript order;
// - a fence with a closer is `closed`;
// - an open fence is `streaming` while its prompt streams, also with a queue
//   receipt after it;
// - an open fence is `unterminated` once a tool call ends its turn, and after
//   `prompt.finished`, `agent.failed` or `agent.cancelled`;
// - a fence of an unregistered tag, or a plain code block, is not listed.
// (The view's `origin` default is drawn in the window:
// `tests/client/conversation-nodes.test.ts`.)

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { threadFences } from '../src/client/domain/fences.js';
import {
  emptyProjection,
  projectEvents,
} from '../src/client/domain/projector.js';
import type { ThreadEvent } from '../src/client/domain/workspace.js';
import type { ChatFence } from '../src/contracts/index.js';

const thread = { projectId: 'p', threadId: 't' } as const;
const both = new Set(['ui-a', 'ui-b']);

const event = (
  sequence: number,
  promptId: string,
  type: string,
  value: Record<string, unknown> = {},
): ThreadEvent => ({
  projectId: 'p',
  threadId: 't',
  promptId,
  type,
  event: { type, ...value },
  sequence,
  createdAt: new Date(sequence * 1000).toISOString(),
});

const accepted = (sequence: number, id: string, queued: boolean) =>
  event(sequence, id, 'prompt.accepted', {
    text: `${id} input`,
    source: { kind: 'user' },
    queued,
  });

/** A prompt that started and has written `text` so far, from sequence 4. */
const writing = (text: string): ThreadEvent[] => [
  accepted(1, 'one', false),
  event(2, 'one', 'prompt.started'),
  event(3, 'one', 'agent.started'),
  event(4, 'one', 'text.delta', { delta: text }),
];

const fencesOf = (
  events: readonly ThreadEvent[],
  tags: ReadonlySet<string> = both,
): readonly ChatFence[] =>
  threadFences(projectEvents(emptyProjection, events).turns, tags, thread);

/** What a fence says, without the Thread it belongs to. */
const brief = (fence: ChatFence) => ({
  key: fence.key,
  promptId: fence.promptId,
  turnSequence: fence.turnSequence,
  index: fence.index,
  info: fence.info,
  body: fence.body,
  state: fence.state,
});

describe('the fences of a Thread', () => {
  test('one closed and one open fence of each tag give four fences, keyed by prompt, turn and index per tag', () => {
    const fences = fencesOf([
      ...writing(
        [
          'Two views:',
          '',
          '```ui-a first',
          'x = 1',
          '```',
          '',
          '```ui-b',
          'y = 2',
          '```',
          '',
          '```ui-a',
          'z = 3',
        ].join('\n'),
      ),
      event(5, 'one', 'tool.started', {
        call: { id: 'c1', name: 'read_file', payload: {} },
      }),
      event(6, 'one', 'text.delta', { delta: '```ui-b\nw = 4' }),
    ]);

    assert.deepEqual(fences.map(brief), [
      {
        key: 'one/4/0',
        promptId: 'one',
        turnSequence: 4,
        index: 0,
        info: 'ui-a first',
        body: 'x = 1',
        state: 'closed',
      },
      {
        key: 'one/4/0',
        promptId: 'one',
        turnSequence: 4,
        index: 0,
        info: 'ui-b',
        body: 'y = 2',
        state: 'closed',
      },
      {
        key: 'one/4/1',
        promptId: 'one',
        turnSequence: 4,
        index: 1,
        info: 'ui-a',
        body: 'z = 3',
        // The tool call ended the turn with the fence still open.
        state: 'unterminated',
      },
      {
        key: 'one/6/0',
        promptId: 'one',
        turnSequence: 6,
        index: 0,
        info: 'ui-b',
        body: 'w = 4',
        state: 'streaming',
      },
    ]);
    for (const fence of fences) {
      assert.equal(fence.projectId, 'p');
      assert.equal(fence.threadId, 't');
    }
  });

  test('a fence of an unregistered tag, and a plain code block, are not listed', () => {
    const fences = fencesOf(
      writing(
        [
          '```ts',
          'const a = 1;',
          '```',
          '',
          '```ui-b',
          'y = 2',
          '```',
          '',
          '```ui-a',
          'x = 1',
          '```',
        ].join('\n'),
      ),
      new Set(['ui-a']),
    );

    assert.deepEqual(
      fences.map((fence) => [fence.info, fence.key]),
      [['ui-a', 'one/4/0']],
    );
  });

  test('an open fence streams while its prompt streams, also with a queue receipt after it', () => {
    const open = writing('```ui-a\nx = 1');
    assert.deepEqual(
      fencesOf(open).map((fence) => fence.state),
      ['streaming'],
    );

    const behindReceipt = fencesOf([
      ...open,
      accepted(5, 'two', true),
      event(6, 'two', 'prompt.queued'),
    ]);
    assert.deepEqual(
      behindReceipt.map((fence) => [fence.key, fence.state]),
      [['one/4/0', 'streaming']],
    );
  });

  test('an open fence is unterminated once its prompt settled: finished, failed or cancelled', () => {
    const open = writing('```ui-a\nx = 1');
    const settled = {
      finished: event(5, 'one', 'prompt.finished', {
        text: '```ui-a\nx = 1',
        status: 'completed',
      }),
      failed: event(5, 'one', 'agent.failed', {
        error: { message: 'The model stopped answering.' },
      }),
      cancelled: event(5, 'one', 'agent.cancelled'),
    };

    for (const [name, last] of Object.entries(settled)) {
      assert.deepEqual(
        fencesOf([...open, last]).map((fence) => [fence.key, fence.state]),
        [['one/4/0', 'unterminated']],
        name,
      );
    }
  });

  test('a fence spanning a queue receipt is one closed fence (B2)', () => {
    const fences = fencesOf([
      ...writing('Pick one:\n\n```ui-a\nx = 1\n'),
      accepted(5, 'two', true),
      event(6, 'two', 'prompt.queued'),
      event(7, 'one', 'text.delta', { delta: 'y = 2\n```' }),
    ]);

    assert.deepEqual(
      fences.map((fence) => [fence.key, fence.body, fence.state]),
      [['one/4/0', 'x = 1\ny = 2', 'closed']],
    );
  });

  test('no registered tag lists no fence', () => {
    assert.deepEqual(fencesOf(writing('```ui-a\nx = 1\n```'), new Set()), []);
  });
});
