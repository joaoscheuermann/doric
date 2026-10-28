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

  test('reads the agent, model and effort the child is spawned with', () => {
    const parsed = parseThreadSpawn(
      JSON.stringify({
        prompt: 'Audit the contrast',
        agent: 'reviewer',
        model: 'gpt-5',
        effort: 'high',
      }),
    );

    assert.equal(parsed.agent, 'reviewer');
    assert.equal(parsed.model, 'gpt-5');
    assert.equal(parsed.effort, 'high');
  });

  test('trims the agent, model and effort the call names', () => {
    const parsed = parseThreadSpawn(
      JSON.stringify({
        prompt: 'Audit the contrast',
        agent: '  reviewer  ',
        model: ' gpt-5 ',
        effort: ' high ',
      }),
    );

    assert.equal(parsed.agent, 'reviewer');
    assert.equal(parsed.model, 'gpt-5');
    assert.equal(parsed.effort, 'high');
  });

  test('names no agent, model or effort the call does not carry as text', () => {
    // A value that is not a string, or a string with nothing in it, names
    // nothing the header could show.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ...[42, true, null, {}, [], '', '   '].map(
        (value) =>
          [
            JSON.stringify(value),
            JSON.stringify({
              prompt: 'Audit the contrast',
              agent: value,
              model: value,
              effort: value,
            }),
          ] as const,
      ),
      ['absent', JSON.stringify({ prompt: 'Audit the contrast' })],
    ];
    for (const [name, args] of cases) {
      const parsed = parseThreadSpawn(args);
      assert.equal(parsed.prompt, 'Audit the contrast', name);
      assert.equal(parsed.agent, undefined, name);
      assert.equal(parsed.model, undefined, name);
      assert.equal(parsed.effort, undefined, name);
    }

    // Args that cannot be read name none of them either.
    const unreadable = parseThreadSpawn('not json');
    assert.equal(unreadable.agent, undefined, 'not json');
    assert.equal(unreadable.model, undefined, 'not json');
    assert.equal(unreadable.effort, undefined, 'not json');
  });
});
