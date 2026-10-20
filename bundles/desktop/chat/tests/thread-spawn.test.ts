import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseThreadSpawn } from '../src/client/domain/thread-spawn.js';

describe('thread-spawn tool domain parsing', () => {
  test('reads the prompt and title a spawn call carries while it runs', () => {
    const parsed = parseThreadSpawn(
      JSON.stringify({
        prompt: 'Audit the contrast',
        title: 'contrast audit',
      }),
    );

    assert.equal(parsed.prompt, 'Audit the contrast');
    assert.equal(parsed.title, 'contrast audit');
    // Nothing has answered yet, so the call names no Thread it spawned.
    assert.equal(parsed.child, undefined);
  });

  test('reads the child Thread a finished spawn names', () => {
    const parsed = parseThreadSpawn(
      JSON.stringify({
        prompt: 'Audit the contrast',
        title: 'contrast audit',
      }),
      JSON.stringify({ threadId: 'thread-1', promptId: 'prompt-1' }),
    );

    assert.deepEqual(parsed.child, {
      threadId: 'thread-1',
      promptId: 'prompt-1',
    });
  });

  test('falls back to the raw args and names no child it cannot read', () => {
    // The args the call was written with stand in for a prompt that cannot be
    // read from them, so the block still shows what the agent was asked for.
    for (const args of ['not json', '{}', '']) {
      assert.equal(parseThreadSpawn(args).prompt, args, args);
    }

    // A result that is absent, unreadable, or names half a child spawns
    // nothing the transcript could link to.
    for (const result of [undefined, '{', '{"threadId":"t"}']) {
      const parsed = parseThreadSpawn(
        JSON.stringify({ prompt: 'Audit the contrast' }),
        result,
      );
      assert.equal(parsed.child, undefined, result);
    }
  });
});
