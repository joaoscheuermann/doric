// The composer's route for one message (conversation-openui.md D20, C3): the
// one rule the composer's send and `chat.send/v1.sendAction` both follow.
//
// Contract matrix:
// - with a running prompt, the message steers it, and that is the result;
// - with none, a prompt starts; a paused, empty queue is resumed first;
// - a paused queue that is not empty (a `resumable` prompt or items) is not
//   resumed: the prompt starts behind it;
// - a refused resume ends the route with `false`, and nothing is prompted;
// - a port that rejects ends the route with `false`; the route never rejects.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  routeSend,
  type SendRoutePorts,
} from '../src/client/domain/send-route.js';

/** Fake ports that answer as told and write down what they were asked. */
const ports = (
  answers: {
    readonly steer?: () => Promise<boolean>;
    readonly queue?: () => Promise<{ paused: boolean; empty: boolean }>;
    readonly resumeQueue?: () => Promise<boolean>;
    readonly prompt?: () => Promise<boolean>;
  } = {},
) => {
  const asked: string[] = [];
  const route: SendRoutePorts = {
    steer: (promptId) => {
      asked.push(`steer ${promptId}`);
      return answers.steer?.() ?? Promise.resolve(true);
    },
    queue: () => {
      asked.push('queue');
      return (
        answers.queue?.() ?? Promise.resolve({ paused: false, empty: true })
      );
    },
    resumeQueue: () => {
      asked.push('resumeQueue');
      return answers.resumeQueue?.() ?? Promise.resolve(true);
    },
    prompt: () => {
      asked.push('prompt');
      return answers.prompt?.() ?? Promise.resolve(true);
    },
  };
  return { route, asked };
};

const refusal = () => Promise.reject(new Error('The thread refused.'));

describe('routeSend', () => {
  test('steers the running prompt, and its answer is the result', async () => {
    const taken = ports();
    assert.equal(await routeSend('prompt-1', taken.route), true);
    assert.ok(taken.asked.includes('steer prompt-1'));
    assert.equal(taken.asked.includes('prompt'), false);

    const refused = ports({ steer: () => Promise.resolve(false) });
    assert.equal(await routeSend('prompt-1', refused.route), false);
    assert.equal(refused.asked.includes('prompt'), false);
  });

  test('prompts when no prompt runs, without resuming a queue that is not paused', async () => {
    const { route, asked } = ports();
    assert.equal(await routeSend(undefined, route), true);
    assert.ok(asked.includes('prompt'));
    assert.equal(asked.includes('resumeQueue'), false);
  });

  test('resumes a paused, empty queue first, then prompts', async () => {
    const { route, asked } = ports({
      queue: () => Promise.resolve({ paused: true, empty: true }),
    });
    assert.equal(await routeSend(undefined, route), true);
    assert.deepEqual(
      asked.filter((name) => name === 'resumeQueue' || name === 'prompt'),
      ['resumeQueue', 'prompt'],
    );
  });

  test('does not resume a paused queue that holds a prompt, and prompts behind it', async () => {
    const { route, asked } = ports({
      queue: () => Promise.resolve({ paused: true, empty: false }),
    });
    assert.equal(await routeSend(undefined, route), true);
    assert.equal(asked.includes('resumeQueue'), false);
    assert.ok(asked.includes('prompt'));
  });

  test('a refused resume gives false and prompts nothing', async () => {
    const { route, asked } = ports({
      queue: () => Promise.resolve({ paused: true, empty: true }),
      resumeQueue: () => Promise.resolve(false),
    });
    assert.equal(await routeSend(undefined, route), false);
    assert.equal(asked.includes('prompt'), false);
  });

  test('a port that rejects gives false, and the route never rejects', async () => {
    const cases = {
      steer: () => routeSend('prompt-1', ports({ steer: refusal }).route),
      queue: () => routeSend(undefined, ports({ queue: refusal }).route),
      resumeQueue: () =>
        routeSend(
          undefined,
          ports({
            queue: () => Promise.resolve({ paused: true, empty: true }),
            resumeQueue: refusal,
          }).route,
        ),
      prompt: () => routeSend(undefined, ports({ prompt: refusal }).route),
    };
    for (const [name, run] of Object.entries(cases)) {
      assert.equal(await run(), false, name);
    }
  });
});
