// The native notice of a finished prompt (§7.5): announced for a Thread the
// window does not show, or when the window has no focus; never for the Thread
// the reader is looking at; a failing notifier changes nothing.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createAnnounce } from '../src/client/api/announce.js';
import type { PromptNotification } from '../src/client/domain/notifications.js';
import {
  routeThread,
  THREAD_ROUTE,
} from '../src/client/domain/thread-route.js';
import type { ThreadEvent } from '../src/client/domain/workspace.js';

const finished = (threadId: string): ThreadEvent => ({
  projectId: 'p',
  threadId,
  promptId: 'prompt',
  sequence: 4,
  type: 'prompt.finished',
  event: { status: 'completed', text: 'All done.' },
  createdAt: '',
});

const setup = (shown: string | undefined, focused: boolean) => {
  const shownNotices: PromptNotification[] = [];
  const announce = createAnnounce({
    shownThreadId: () => shown,
    windowFocused: () => focused,
    show: async (notice) => {
      shownNotices.push(notice);
    },
  });
  return { announce, shownNotices };
};

describe('announce', () => {
  test('a Thread the window does not show is announced with its name and outcome', () => {
    const { announce, shownNotices } = setup('other', true);
    announce('t1', 'Fix the build', finished('t1'));
    assert.deepEqual(shownNotices, [
      { title: 'Fix the build', body: 'Prompt completed · All done.' },
    ]);
  });

  test('the Thread the focused window shows is not announced', () => {
    const { announce, shownNotices } = setup('t1', true);
    announce('t1', 'Fix the build', finished('t1'));
    assert.deepEqual(shownNotices, []);
  });

  test('the shown Thread is announced when the window has no focus', () => {
    const { announce, shownNotices } = setup('t1', false);
    announce('t1', 'Fix the build', finished('t1'));
    assert.equal(shownNotices.length, 1);
  });

  test('events other than prompt.finished are silent', () => {
    const { announce, shownNotices } = setup(undefined, false);
    announce('t1', 'x', { ...finished('t1'), type: 'agent.finished' });
    assert.deepEqual(shownNotices, []);
  });

  test('a notifier that rejects or throws is swallowed', async () => {
    const rejecting = createAnnounce({
      shownThreadId: () => undefined,
      windowFocused: () => false,
      show: () => Promise.reject(new Error('denied')),
    });
    const throwing = createAnnounce({
      shownThreadId: () => {
        throw new Error('no navigation');
      },
      windowFocused: () => false,
      show: async () => undefined,
    });
    assert.doesNotThrow(() => rejecting('t1', 'x', finished('t1')));
    assert.doesNotThrow(() => throwing('t1', 'x', finished('t1')));
    await new Promise((resolve) => setImmediate(resolve));
  });

  test('the shown Thread is the one the conversation route names', () => {
    assert.deepEqual(
      routeThread({
        pattern: THREAD_ROUTE,
        params: { projectId: 'p', threadId: 't1' },
      }),
      { projectId: 'p', threadId: 't1' },
    );
    assert.equal(routeThread({ pattern: '/', params: {} }), undefined);
    assert.equal(routeThread(undefined), undefined);
  });
});
