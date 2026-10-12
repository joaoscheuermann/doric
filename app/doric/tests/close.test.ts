// The close protocol, main side (section 17.2), with a fake window whose
// renderer answers (or not) through the push channel.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { CloseRequest } from 'desktop/protocol';

import {
  CloseAnswers,
  installCloseProtocol,
} from '../src/platform/windows/close';

interface Pushed {
  readonly id: string;
  readonly request: CloseRequest;
}

const fakeWindow = () => {
  const pushed: Pushed[] = [];
  let closeListener: ((event: { preventDefault(): void }) => void) | undefined;
  let closed = 0;
  const window = {
    isDestroyed: () => false,
    close: () => {
      // A real close emits `close` again; the protocol lets it through.
      let prevented = false;

      closeListener?.({ preventDefault: () => (prevented = true) });

      if (!prevented) {
        closed += 1;
      }
    },
    on: (
      _event: 'close',
      listener: (event: { preventDefault(): void }) => void,
    ) => {
      closeListener = listener;
    },
    webContents: {
      isDestroyed: () => false,
      send: (_channel: string, payload: unknown) => {
        const push = payload as {
          type: string;
          id: string;
          request: CloseRequest;
        };

        if (push.type === 'close-requested') {
          pushed.push({ id: push.id, request: push.request });
        }
      },
    },
  };

  return {
    window,
    pushed,
    closed: () => closed,
    /** The user closes the window. */
    userClose: () => {
      let prevented = false;

      closeListener?.({ preventDefault: () => (prevented = true) });

      if (!prevented) {
        closed += 1;
      }
    },
  };
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('window close protocol', () => {
  test('asks the renderer, flushes, then closes', async () => {
    const answers = new CloseAnswers();
    const fake = fakeWindow();

    installCloseProtocol(fake.window, { answers, quitting: () => false });
    fake.userClose();
    await tick();

    assert.equal(fake.pushed[0]?.request.phase, 'close');
    assert.equal(fake.pushed[0]?.request.forced, false);
    answers.answer(fake.pushed[0]?.id as string, { allow: true });
    await tick();

    assert.equal(fake.pushed[1]?.request.phase, 'flush');
    assert.ok((fake.pushed[1]?.request.deadline ?? 0) > 0);
    assert.equal(fake.closed(), 0);
    answers.answer(fake.pushed[1]?.id as string, { allow: true });
    await tick();
    assert.equal(fake.closed(), 1);
  });

  test('a denied close keeps the window open', async () => {
    const answers = new CloseAnswers();
    const fake = fakeWindow();
    const reasons: string[] = [];

    installCloseProtocol(fake.window, {
      answers,
      quitting: () => false,
      denied: (reason) => reasons.push(reason),
    });
    fake.userClose();
    await tick();
    answers.answer(fake.pushed[0]?.id as string, {
      allow: false,
      reason: 'unsaved',
    });
    await tick();

    assert.equal(fake.closed(), 0);
    assert.deepEqual(reasons, ['unsaved']);
  });

  test('a renderer that never answers the flush is closed at the 1.5 s deadline', async () => {
    const answers = new CloseAnswers();
    const fake = fakeWindow();

    installCloseProtocol(fake.window, {
      answers,
      quitting: () => false,
      flushDeadlineMs: 30,
    });
    fake.userClose();
    await tick();
    answers.answer(fake.pushed[0]?.id as string, { allow: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fake.closed(), 0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(fake.closed(), 1);
  });

  test('a second close while the first waits is forced; a close while quitting is forced', async () => {
    const answers = new CloseAnswers();
    const fake = fakeWindow();
    let quitting = false;

    installCloseProtocol(fake.window, { answers, quitting: () => quitting });
    fake.userClose();
    fake.userClose();
    await tick();

    assert.deepEqual(
      fake.pushed.map(({ request }) => request.forced),
      [false, true],
    );

    const other = fakeWindow();

    quitting = true;
    installCloseProtocol(other.window, { answers, quitting: () => quitting });
    other.userClose();
    await tick();
    assert.equal(other.pushed[0]?.request.forced, true);
  });
});
