// The window side: every live event of a held Thread is reported with the
// shown Thread and focus sampled when it is received; nothing else is.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createObserver,
  type ThreadUpdateInput,
} from '../src/client/observer.js';
import type { PromptObservation } from '../src/contracts/index.js';

const event = {
  projectId: 'project',
  threadId: 'thread',
  promptId: 'prompt',
  sequence: 3,
  type: 'agent.started',
  event: { type: 'agent.started' },
  createdAt: '2026-01-01T00:00:01.000Z',
};

const live = (threadName = 'Main'): ThreadUpdateInput => ({
  projectId: 'project',
  threadId: 'thread',
  threadName,
  update: { kind: 'event', event },
});

describe('the window observer', () => {
  test('reports each live event with what the window showed at that instant', () => {
    const reported: PromptObservation[] = [];
    let shown: string | undefined = 'thread';
    let focused = true;
    const observe = createObserver({
      shownThreadId: () => shown,
      windowFocused: () => focused,
      report: async (observation) => {
        reported.push(observation);
      },
    });

    observe(live());
    shown = undefined;
    focused = false;
    observe(live('Renamed'));

    assert.deepEqual(reported, [
      {
        threadId: 'thread',
        threadName: 'Main',
        event,
        shownThreadId: 'thread',
        windowFocused: true,
      },
      {
        threadId: 'thread',
        threadName: 'Renamed',
        event,
        windowFocused: false,
      },
    ]);
  });

  test('ignores an updated record', () => {
    const reported: PromptObservation[] = [];
    const observe = createObserver({
      shownThreadId: () => undefined,
      windowFocused: () => false,
      report: async (observation) => {
        reported.push(observation);
      },
    });
    observe({
      ...live(),
      update: { kind: 'updated', thread: { id: 'thread' } },
    });
    assert.deepEqual(reported, []);
  });

  test('never lets a failing report or a throwing source reach chat', async () => {
    const rejecting = createObserver({
      shownThreadId: () => undefined,
      windowFocused: () => false,
      report: () => Promise.reject(new Error('bridge closed')),
    });
    const throwing = createObserver({
      shownThreadId: () => {
        throw new Error('no navigation');
      },
      windowFocused: () => false,
      report: () => Promise.resolve(),
    });
    assert.doesNotThrow(() => rejecting(live()));
    assert.doesNotThrow(() => throwing(live()));
    await new Promise((resolve) => setImmediate(resolve));
  });
});
