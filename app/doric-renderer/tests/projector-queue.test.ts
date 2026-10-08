import assert from 'node:assert/strict';
import test from 'node:test';

import { caretKind } from '../src/domain/caret-navigation';
import { QUEUED_TURN_BLOCK } from '../src/domain/conversation-nodes';
import { syncPlan } from '../src/domain/conversation-sync';
import { withPendingTurns } from '../src/domain/pending-turns';
import { emptyProjection, projectEvents } from '../src/domain/projector';
import { queueAuthor } from '../src/domain/queue';
import {
  applyThreadUpdate,
  emptyThreadChats,
  openThread,
  startPending,
} from '../src/domain/thread-chats';
import type { ThreadEvent } from '../src/domain/workspace';

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

void test('editing changes the dispatched input while preserving queued receipts through live updates and replay', () => {
  const receipts = [accepted(1, 'one', true), event(2, 'one', 'prompt.queued')];
  const waiting = projectEvents(emptyProjection, receipts);
  const changes = [event(3, 'one', 'prompt.edited', { text: 'Updated input' })];
  const edited = projectEvents(waiting, changes);
  assert.deepEqual(edited.turns, waiting.turns);
  const dispatch = event(4, 'one', 'prompt.started');
  const executed = projectEvents(edited, [dispatch]);
  assert.deepEqual(executed.turns[0], waiting.turns[0]);
  const user = executed.turns.find((turn) => turn.type === 'user');
  assert.ok(user?.type === 'user');
  assert.equal(user.text, 'Updated input');
  assert.deepEqual(
    executed,
    projectEvents(emptyProjection, [...receipts, ...changes, dispatch]),
  );
  const rewound = projectEvents(executed, [
    event(5, 'one', 'history.truncated', { afterSequence: 2 }),
  ]);
  assert.equal(rewound.inputs.get('one')?.text, 'one input');
  assert.deepEqual(rewound.turns, waiting.turns);
});

void test('keeps the Queued receipt at submission and appends the full prompt only after the prior answer', () => {
  const events = [
    accepted(1, 'first', false),
    event(2, 'first', 'prompt.started'),
    event(3, 'first', 'agent.started'),
    event(4, 'first', 'text.delta', { delta: 'working' }),
    accepted(5, 'second', true),
    event(6, 'second', 'prompt.queued'),
  ];
  const waiting = projectEvents(emptyProjection, events);
  assert.deepEqual(
    waiting.turns.map((turn) => [turn.type, turn.promptId]),
    [
      ['user', 'first'],
      ['agent', 'first'],
      ['queued', 'second'],
    ],
  );
  assert.equal(waiting.turns.at(-1)?.type, 'queued');
  assert.equal(syncPlan([], waiting.turns, 20).steps.at(-1)?.author, null);
  const complete = [
    ...events,
    event(7, 'first', 'text.delta', { delta: ' done' }),
    event(8, 'first', 'prompt.finished', {
      text: 'working done',
      status: 'completed',
    }),
    event(9, 'second', 'prompt.started'),
    event(10, 'second', 'agent.started'),
  ];
  const incremental = projectEvents(waiting, complete.slice(events.length));
  assert.deepEqual(incremental, projectEvents(emptyProjection, complete));
  assert.deepEqual(
    incremental.turns.map((turn) => [turn.type, turn.promptId]),
    [
      ['user', 'first'],
      ['agent', 'first'],
      ['queued', 'second'],
      ['agent', 'first'],
      ['user', 'second'],
    ],
  );
  assert.deepEqual(incremental.turns[2], waiting.turns[2]);
  assert.deepEqual(
    incremental.turns
      .filter((turn) => turn.type === 'agent')
      .map((turn) => turn.text),
    ['working', ' done'],
  );
  assert.equal(incremental.turns.at(-1)?.events[0]?.sequence, 9);
  assert.deepEqual(projectEvents(incremental, complete), incremental);
  assert.equal(caretKind(QUEUED_TURN_BLOCK), 'furniture');
});

void test('acceptance alone is not execution, and resuming never appends the prompt twice', () => {
  const acceptedOnly = projectEvents(emptyProjection, [
    accepted(1, 'one', false),
  ]);
  assert.deepEqual(acceptedOnly.turns, []);
  const started = projectEvents(acceptedOnly, [
    event(2, 'one', 'prompt.started'),
    event(3, 'one', 'agent.started'),
  ]);
  const resumed = projectEvents(started, [
    event(4, 'one', 'prompt.paused', { reason: 'reader_stopped' }),
    event(5, 'one', 'prompt.resumed', { attempt: 1 }),
    event(6, 'one', 'prompt.started'),
    event(7, 'one', 'agent.started'),
  ]);
  assert.equal(resumed.turns.filter((turn) => turn.type === 'user').length, 1);
  assert.equal(
    resumed.turns.filter((turn) => turn.type === 'queued').length,
    0,
  );
  assert.equal(
    resumed.turns.filter(
      (turn) => turn.type === 'lifecycle' && turn.lifecycle.kind === 'resume',
    ).length,
    1,
  );
});

void test('legacy acceptance stays visible and a new dispatch event does not duplicate it', () => {
  const old = event(1, 'legacy', 'prompt.accepted', {
    text: 'Legacy input',
    source: { kind: 'user' },
  });
  const projection = projectEvents(emptyProjection, [
    old,
    event(2, 'legacy', 'prompt.started'),
  ]);
  assert.equal(projection.turns.length, 1);
  assert.equal(projection.turns[0].events[0].sequence, 1);
});

void test('a queued human input acknowledges sending and preserves the current pause', () => {
  const thread = {
    id: 't',
    projectId: 'p',
    name: 'Thread',
    state: 'ready',
    lastSequence: 0,
    cwd: '/workspace',
    createdAt: '',
    updatedAt: '',
  };
  let chats = openThread(emptyThreadChats, thread, null).chats;
  chats = startPending(chats, 't', 'new input');
  chats = applyThreadUpdate(chats, 't', {
    kind: 'event',
    event: accepted(1, 'new', true),
  }).chats;
  assert.equal(chats.chats.get('t')?.pending, undefined);
  assert.equal(chats.chats.get('t')?.projection.turns.length, 0);

  const projection = projectEvents(emptyProjection, [
    accepted(1, 'old', false),
    event(2, 'old', 'prompt.started'),
    event(3, 'old', 'agent.started'),
    event(4, 'old', 'prompt.paused', { reason: 'reader_stopped' }),
    accepted(5, 'new', true),
    event(6, 'new', 'prompt.queued'),
  ]);
  const pause = projection.turns.find((turn) => turn.type === 'lifecycle');
  assert.ok(pause?.type === 'lifecycle' && pause.lifecycle.kind === 'pause');
  assert.equal(pause.lifecycle.standing, true);
  assert.deepEqual(
    withPendingTurns(projection.turns, { text: 'new input', before: 1 }),
    projection.turns,
  );
});

void test('rewind removes later receipts and reconstructs the same chronological view', () => {
  const events = [
    accepted(1, 'first', false),
    event(2, 'first', 'prompt.started'),
    accepted(3, 'second', true),
    event(4, 'second', 'prompt.queued'),
  ];
  const before = projectEvents(emptyProjection, events);
  const after = projectEvents(before, [
    event(5, 'second', 'history.truncated', { afterSequence: 2 }),
  ]);
  assert.deepEqual(
    after.turns.map((turn) => turn.type),
    ['user'],
  );
  assert.equal(after.inputs.has('second'), false);
});

void test('queue receipts and live rows use the same human identity and preserve machine sources', () => {
  assert.equal(queueAuthor({ kind: 'user' }, 'You'), 'jao.scheuermann');
  assert.equal(queueAuthor({ kind: 'terminal' }), 'Terminal');
  assert.equal(
    queueAuthor({ kind: 'result', threadId: '1234567890' }),
    'Subthread · 12345678',
  );
  assert.equal(
    queueAuthor({ kind: 'parent' }, 'Parent · Review'),
    'Parent · Review',
  );
});

void test('groups consecutive queued receipts without merging execution prompts or repeating pending sends', () => {
  const first = [accepted(1, 'one', true), event(2, 'one', 'prompt.queued')];
  const single = projectEvents(emptyProjection, first);
  const additions = [
    accepted(3, 'two', true),
    event(4, 'two', 'prompt.queued'),
  ];
  const grouped = projectEvents(single, additions);
  assert.equal(grouped.turns.length, 1);
  const receipt = grouped.turns[0];
  assert.ok(receipt?.type === 'queued');
  assert.deepEqual(
    receipt.items.map((item) => [item.promptId, item.text]),
    [
      ['one', 'one input'],
      ['two', 'two input'],
    ],
  );
  const plan = syncPlan([], single.turns, 20);
  const growing = syncPlan(
    plan.steps.map((step) => step.key),
    grouped.turns,
    20,
  );
  assert.equal(growing.steps[0]?.kind, 'update');
  assert.deepEqual(growing.removals, []);
  assert.equal(
    withPendingTurns(grouped.turns, { text: 'two input', before: 1 }),
    grouped.turns,
  );
  assert.deepEqual(
    grouped,
    projectEvents(emptyProjection, [...first, ...additions]),
  );
  const dispatched = projectEvents(grouped, [
    event(5, 'one', 'prompt.started'),
    event(6, 'one', 'prompt.finished', { text: 'done' }),
    event(7, 'two', 'prompt.started'),
  ]);
  assert.deepEqual(
    dispatched.turns
      .filter((turn) => turn.type === 'user')
      .map((turn) => turn.promptId),
    ['one', 'two'],
  );
  assert.deepEqual(dispatched.turns[0], receipt);
});

void test('keeps queued groups separated by visible events and recounts after rewind', () => {
  const before = projectEvents(emptyProjection, [
    accepted(1, 'one', true),
    event(2, 'one', 'prompt.queued'),
    accepted(3, 'two', true),
    event(4, 'two', 'prompt.queued'),
    event(5, 'active', 'text.delta', { delta: 'Still working' }),
    accepted(6, 'three', true),
    event(7, 'three', 'prompt.queued'),
  ]);
  assert.deepEqual(
    before.turns.map((turn) => turn.type),
    ['queued', 'agent', 'queued'],
  );
  const after = projectEvents(before, [
    event(8, 'two', 'history.truncated', { afterSequence: 2 }),
  ]);
  assert.equal(after.turns.length, 1);
  const receipt = after.turns[0];
  assert.ok(receipt?.type === 'queued');
  assert.deepEqual(
    receipt.items.map((item) => item.promptId),
    ['one'],
  );
  assert.deepEqual(
    projectEvents(after, [
      event(8, 'two', 'history.truncated', { afterSequence: 2 }),
    ]),
    after,
  );
});
