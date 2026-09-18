import assert from 'node:assert/strict';
import test from 'node:test';

import { createStateMachine, type StateMachineHandler } from '../src/index.js';

type State = { count: number };
type Context = { runId: string };

test('preserves an asynchronous rejection and the active state and context', async () => {
  const cause = { reason: 'rejected' };
  const state = { count: 1 };
  const context = { runId: 'rejection' };
  const definition = createStateMachine<Context, State>()({
    start: async () => {
      await Promise.resolve();
      throw cause;
    },
  });
  const result = await definition.run({ initial: 'start', state, context });

  assert.equal(result.status, 'error');
  assert.equal(result.state, state);
  assert.equal(result.context, context);
  if (result.status === 'error') {
    assert.equal(result.error.data.code, 'handler_failed');
    assert.equal(result.error.data.handler, 'start');
    assert.equal(result.error.cause, cause);
  }
});

const invalidActions: [string, unknown][] = [
  ['undefined', undefined],
  ['null', null],
  ['primitive', 'finish'],
  ['empty object', {}],
  ['unknown discriminant', { type: 'stop' }],
  ['finish without value', { type: 'finish' }],
  ['fail without error', { type: 'fail' }],
  ['transition without target', { type: 'transition', state: {} }],
  [
    'transition with non-string target',
    { type: 'transition', handler: 1, state: {} },
  ],
  ['transition without state', { type: 'transition', handler: 'start' }],
];

for (const [label, action] of invalidActions) {
  test(`returns invalid_handler_return for ${label}`, async () => {
    const definition = createStateMachine<Context, State>()({
      start: (() => action) as StateMachineHandler<Context, State, 'start'>,
    });
    const state = { count: 1 };
    const context = { runId: label };
    const result = await definition.run({ initial: 'start', state, context });

    assert.equal(result.status, 'error');
    assert.equal(result.state, state);
    assert.equal(result.context, context);
    assert.equal(result.handler, 'start');
    if (result.status === 'error') {
      assert.equal(result.error.data.code, 'invalid_handler_return');
      assert.equal(result.error.data.handler, 'start');
    }
  });
}

test('reports a missing transition target with the transitioned state', async () => {
  const supplied = { count: 2 };
  const definition = createStateMachine<Context, State>()({
    start: (() => ({
      type: 'transition',
      handler: 'missing',
      state: supplied,
    })) as unknown as StateMachineHandler<Context, State, 'start'>,
  });
  const context = { runId: 'missing-target' };
  const result = await definition.run({
    initial: 'start',
    state: { count: 0 },
    context,
  });

  assert.equal(result.status, 'error');
  assert.equal(result.handler, 'missing');
  assert.equal(result.state.count, 2);
  assert.notEqual(result.state, supplied);
  assert.equal(result.context, context);
  if (result.status === 'error') {
    assert.equal(result.error.data.code, 'missing_handler');
    assert.equal(result.error.data.handler, 'missing');
  }
});

test('provides frozen actions without exposing mutable helpers to later handlers', async () => {
  const definition = createStateMachine<Context, State, number>()({
    start: (state, _context, actions) => {
      assert.equal(Object.isFrozen(actions), true);
      assert.equal(
        Reflect.set(actions, 'finish', () => ({
          type: 'fail',
          error: 'changed',
        })),
        false,
      );
      return actions.transition('done', state);
    },
    done: (state, _context, actions) => {
      assert.equal(Object.isFrozen(actions), true);
      return actions.finish(state.count);
    },
  });
  const result = await definition.run({
    initial: 'start',
    state: { count: 3 },
    context: { runId: 'frozen' },
  });

  assert.equal(result.status, 'finished');
  if (result.status === 'finished') {
    assert.equal(result.value, 3);
  }
});

test('reuses one definition sequentially after both a failure and a finish', async () => {
  const definition = createStateMachine<Context, State, string, string>()({
    start: (state, _context, { fail, transition }) =>
      state.count < 0 ? fail('negative') : transition('done', state),
    done: (state, context, { finish }) =>
      finish(`${context.runId}:${state.count}`),
  });
  const failed = await definition.run({
    initial: 'start',
    state: { count: -1 },
    context: { runId: 'failed' },
  });
  assert.equal(failed.status, 'failed');

  for (const count of [1, 2]) {
    const context = { runId: `run-${count}` };
    const result = await definition.run({
      initial: 'start',
      state: { count },
      context,
    });
    assert.equal(result.status, 'finished');
    assert.equal(result.context, context);
    assert.equal(result.state.count, count);
    if (result.status === 'finished') {
      assert.equal(result.value, `run-${count}:${count}`);
    }
  }
});
