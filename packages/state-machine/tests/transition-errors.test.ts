import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createStateMachine,
  type StateMachineTransition,
} from '../src/index.js';

test('executes the captured fields of a transition with changing getters', async () => {
  const supplied = { count: 2 };
  const action: StateMachineTransition<'done', typeof supplied> = {
    get type() {
      Object.defineProperty(this, 'type', { value: 'finish' });
      return 'transition' as const;
    },
    get handler() {
      Object.defineProperty(this, 'handler', { value: 'missing' });
      return 'done' as const;
    },
    get state() {
      Object.defineProperty(this, 'state', { value: [] });
      return supplied;
    },
  };
  const definition = createStateMachine<void, typeof supplied, number>()({
    start: () => action,
    done: (state, _context, { finish }) => finish(state.count),
  });

  const result = await definition.run({
    initial: 'start',
    state: { count: 0 },
    context: undefined,
  });

  assert.equal(result.status, 'finished');
  assert.equal(result.handler, 'done');
  assert.notEqual(result.state, supplied);
  assert.equal(result.state.count, 2);
  if (result.status === 'finished') {
    assert.equal(result.value, 2);
  }
});

test('preserves the source state and cause when copying a transition throws', async () => {
  const cause = { reason: 'unreadable property' };
  const initial = { count: 0 };
  const context = { runId: 'copy-error' };
  const definition = createStateMachine<typeof context, typeof initial>()({
    start: (state, _context, { transition }) => {
      state.count = 1;
      return transition('done', {
        get count(): number {
          throw cause;
        },
      });
    },
    done: (_state, _context, { finish }) => finish(),
  });

  const result = await definition.run({
    initial: 'start',
    state: initial,
    context,
  });

  assert.equal(result.status, 'error');
  if (result.status !== 'error') return;

  assert.equal(result.error.data.code, 'handler_failed');
  assert.equal(result.error.data.handler, 'start');
  assert.equal(result.error.cause, cause);
  assert.equal(result.state, initial);
  assert.equal(result.state.count, 1);
  assert.equal(result.context, context);
});
