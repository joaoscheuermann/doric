import assert from 'node:assert/strict';
import test from 'node:test';

import { nextStop } from '../src/domain/caret-navigation';
import {
  AGENT_TURN_BLOCK,
  isUndeletableBlock,
  QUEUE_BLOCK,
  USER_PROMPT_BLOCK,
} from '../src/domain/conversation-nodes';
import {
  composerAction,
  latestQueue,
  queueChanged,
  queueDetail,
  queueItems,
  visibleQueueItems,
} from '../src/domain/queue';
import type { ThreadEvent } from '../src/domain/workspace';

const event = (type: string): ThreadEvent => ({
  projectId: 'p',
  threadId: 't',
  promptId: 'input',
  sequence: 1,
  createdAt: '',
  type,
  event: { text: 'full input\nwith details' },
});

void test('hides a sole running input but shows paused work and current plus next without changing footer actions', () => {
  const current = {
    promptId: 'current',
    source: { kind: 'user' as const },
    label: 'You',
    preview: 'Current input',
    acceptedAt: '',
  };
  const next = { ...current, promptId: 'next' };
  const running = {
    revision: 1,
    paused: false,
    stopping: false,
    current,
    items: [],
  };
  assert.deepEqual(visibleQueueItems(running), []);
  assert.equal(composerAction(true, running), 'pause');
  assert.deepEqual(
    visibleQueueItems({ ...running, items: [next] }).map(
      (item) => item.promptId,
    ),
    ['current', 'next'],
  );
  assert.deepEqual(
    visibleQueueItems({ ...running, paused: true }).map(
      (item) => item.promptId,
    ),
    ['current'],
  );
  assert.deepEqual(
    visibleQueueItems({ ...running, stopping: true }).map(
      (item) => item.promptId,
    ),
    ['current'],
  );
  const resumable = { ...running, current: undefined, resumable: current };
  assert.deepEqual(
    visibleQueueItems(resumable).map((item) => item.promptId),
    ['current'],
  );
  assert.equal(composerAction(false, resumable), 'resume');
  assert.deepEqual(
    visibleQueueItems({ ...running, current: undefined, items: [next] }).map(
      (item) => item.promptId,
    ),
    ['next'],
  );
  assert.deepEqual(
    visibleQueueItems({ ...running, current: undefined, paused: true }),
    [],
  );
  assert.deepEqual(visibleQueueItems(undefined), []);
});

void test('an older queue response cannot restore already consumed inputs', () => {
  const current = { revision: 9, paused: false, stopping: false, items: [] };
  const older = { ...current, revision: 8, paused: true };
  assert.equal(latestQueue(current, older), current);
  assert.equal(latestQueue(older, current), current);
  assert.equal(latestQueue(undefined, current), current);
});

void test('queue changes refresh its snapshot while token streaming does not', () => {
  for (const type of [
    'prompt.accepted',
    'prompt.edited',
    'prompt.paused',
    'prompt.resumed',
    'prompt.finished',
    'queue.paused',
    'queue.resumed',
    'queue.updated',
    'history.truncated',
  ])
    assert.equal(
      queueChanged({ kind: 'event', event: event(type) }),
      true,
      type,
    );
  assert.equal(
    queueChanged({ kind: 'event', event: event('agent.text.delta') }),
    false,
  );
  assert.equal(
    queueDetail([event('agent.text.delta'), event('prompt.accepted')], 'input'),
    'full input\nwith details',
  );
  assert.equal(
    queueDetail([event('prompt.accepted')], 'another-input'),
    undefined,
  );
  assert.equal(
    queueDetail(
      [
        event('prompt.accepted'),
        {
          ...event('prompt.edited'),
          sequence: 2,
          event: { text: 'Edited full text' },
        },
      ],
      'input',
    ),
    'Edited full text',
  );
});

void test('the queue survives transcript deletion and is a caret stop in both directions', () => {
  const blocks = [AGENT_TURN_BLOCK, QUEUE_BLOCK, USER_PROMPT_BLOCK];
  assert.equal(isUndeletableBlock(QUEUE_BLOCK), true);
  assert.equal(nextStop(blocks, 0, 'next'), 1);
  assert.equal(nextStop(blocks, 2, 'previous'), 1);
});

void test('the footer sends with an empty queue, resumes pending work and pauses an active or stopping run', () => {
  const empty = { revision: 1, paused: false, stopping: false, items: [] };
  const item = {
    promptId: 'current',
    source: { kind: 'user' as const },
    label: 'You',
    preview: 'current',
    acceptedAt: '',
  };
  assert.equal(composerAction(false, empty), 'send');
  assert.equal(composerAction(false, { ...empty, paused: true }), 'send');
  assert.equal(
    composerAction(false, { ...empty, paused: true, resumable: item }),
    'resume',
  );
  assert.equal(composerAction(false, { ...empty, items: [item] }), 'resume');
  assert.equal(composerAction(true, { ...empty, items: [item] }), 'pause');
  assert.equal(composerAction(false, { ...empty, stopping: true }), 'pause');
  assert.deepEqual(
    queueItems({
      ...empty,
      current: item,
      resumable: item,
      items: [{ ...item, promptId: 'next' }],
    }).map((entry) => entry.promptId),
    ['current', 'next'],
  );
});
