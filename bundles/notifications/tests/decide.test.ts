// What `notifications.observations/v1` shows, through the built desktopMain
// part (the renderer's `domain/notifications.ts` rules and `announce`'s
// suppression and swallowing, current-desktop.md B.4.10).

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  NotificationObservationsV1,
  type PromptObservation,
} from '../src/contracts/index.js';
import { bootDesktop, type Desktop } from './support/desktop.js';

const LIMIT = 160;

let desktop: Desktop | undefined;

afterEach(async () => {
  await desktop?.stop();
  desktop = undefined;
});

/** Boots the bundle and returns what main was asked to show. */
const boot = async (
  show: (request: unknown) => Promise<void> = () => Promise.resolve(),
) => {
  const shown: unknown[] = [];
  desktop = await bootDesktop({
    show: (request) => {
      shown.push(request);
      return show(request);
    },
  });
  const report = (observation: PromptObservation) =>
    (desktop as Desktop).services
      .use(NotificationObservationsV1)
      .report(observation);
  return { shown, report };
};

const finished = (
  payload: Readonly<Record<string, unknown>>,
  overrides: Partial<PromptObservation> = {},
  type = 'prompt.finished',
): PromptObservation => ({
  threadId: 'thread',
  threadName: 'Main',
  event: {
    projectId: 'project',
    threadId: 'thread',
    promptId: 'prompt',
    sequence: 1,
    type,
    event: { type, ...payload },
    createdAt: '2026-01-01T00:00:01.000Z',
  },
  windowFocused: false,
  ...overrides,
});

describe('what a finished prompt notifies', () => {
  test('activates and names the Thread and the outcome beside the answer', async () => {
    const { shown, report } = await boot();
    assert.equal(desktop?.states.notifications, 'active');

    await report(
      finished({
        status: 'completed',
        text: 'Fixed the failing test\nand shipped it.',
      }),
    );

    assert.deepEqual(shown, [
      {
        title: 'Main',
        body: 'Prompt completed · Fixed the failing test and shipped it.',
      },
    ]);
  });

  test('names the outcome alone when the prompt states no answer', async () => {
    const { shown, report } = await boot();
    await report(finished({ status: 'completed', text: '  \n ' }));
    await report(finished({ status: 'completed' }));
    assert.deepEqual(shown, [
      { title: 'Main', body: 'Prompt completed' },
      { title: 'Main', body: 'Prompt completed' },
    ]);
  });

  test('reads failure, cancellation and any other status as their outcomes', async () => {
    const { shown, report } = await boot();
    await report(finished({ status: 'failed', text: 'The prompt failed.' }));
    await report(finished({ status: 'cancelled', text: '' }));
    await report(finished({ status: 'something-else', text: '' }));
    assert.deepEqual(
      shown.map((request) => (request as { body: string }).body),
      [
        'Prompt failed · The prompt failed.',
        'Prompt cancelled',
        'Prompt completed',
      ],
    );
  });

  test('bounds the answer to 160 code points', async () => {
    const { shown, report } = await boot();
    await report(finished({ status: 'completed', text: 'x'.repeat(LIMIT) }));
    await report(
      finished({ status: 'completed', text: '😀'.repeat(LIMIT + 1) }),
    );
    assert.deepEqual(
      shown.map((request) => (request as { body: string }).body),
      [
        `Prompt completed · ${'x'.repeat(LIMIT)}`,
        `Prompt completed · ${'😀'.repeat(LIMIT)}`,
      ],
    );
  });

  test('accepts the bundle-architecture event name as a completion', async () => {
    const { shown, report } = await boot();
    await report(
      finished(
        { status: 'completed', text: 'done' },
        {},
        'runtime.prompt-finished/v1',
      ),
    );
    assert.deepEqual(shown, [
      { title: 'Main', body: 'Prompt completed · done' },
    ]);
  });

  test('stays silent for every event that is not a completion', async () => {
    const { shown, report } = await boot();
    for (const type of ['agent.started', 'agent.finished', 'prompt.started']) {
      await report(finished({ status: 'completed', text: 'done' }, {}, type));
    }
    assert.deepEqual(shown, []);
  });
});

describe('when a completion stays quiet', () => {
  test('is quiet for the Thread the focused window shows', async () => {
    const { shown, report } = await boot();
    await report(
      finished(
        { status: 'completed', text: '' },
        { shownThreadId: 'thread', windowFocused: true },
      ),
    );
    assert.deepEqual(shown, []);
  });

  test('still notifies another Thread, an unfocused window, or no shown Thread', async () => {
    const { shown, report } = await boot();
    const done = { status: 'completed', text: '' };
    await report(
      finished(done, { shownThreadId: 'other', windowFocused: true }),
    );
    await report(
      finished(done, { shownThreadId: 'thread', windowFocused: false }),
    );
    await report(finished(done, { windowFocused: true }));
    assert.equal(shown.length, 3);
  });

  test('swallows a notice main fails to show', async () => {
    const { shown, report } = await boot(() =>
      Promise.reject(new Error('refused')),
    );
    await report(finished({ status: 'completed', text: '' }));
    assert.equal(shown.length, 1);
  });
});
