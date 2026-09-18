import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createStateMachine,
  type StateMachineHandler,
  type StateMachineTransition,
} from '../src/index.js';

type State = Record<string, unknown>;
type Context = { runId: string };

class Instance {
  count = 1;
}

const invalidStates: [string, unknown][] = [
  ['array', []],
  ['date', new Date(0)],
  ['map', new Map()],
  ['class instance', new Instance()],
  ['custom prototype', Object.create({ inherited: true })],
  ['null', null],
  ['undefined', undefined],
  ['string', 'state'],
  ['number', 1],
  ['boolean', false],
  ['bigint', 1n],
  ['symbol', Symbol('state')],
  ['function', () => undefined],
];

for (const [label, invalid] of invalidStates) {
  test(`rejects ${label} initial state without invoking its handler`, async () => {
    let invoked = false;
    const definition = createStateMachine<Context, State>()({
      start: (_state, _context, { finish }) => {
        invoked = true;
        return finish();
      },
    });
    const context = { runId: label };
    const result = await definition.run({
      initial: 'start',
      state: invalid as State,
      context,
    });

    assert.equal(invoked, false);
    assert.equal(result.status, 'error');
    assert.equal(result.state, invalid);
    assert.equal(result.context, context);
    assert.equal(result.handler, 'start');
    if (result.status === 'error') {
      assert.equal(result.error.data.code, 'handler_failed');
      assert.equal(result.error.data.handler, 'start');
      assert.ok(result.error.cause instanceof TypeError);
    }
  });

  for (const style of ['literal', 'helper'] as const) {
    test(`rejects ${label} ${style} transition state at the source handler`, async () => {
      let reachedTarget = false;
      const definition = createStateMachine<Context, State>()({
        start: (_state, _context, { transition }) =>
          style === 'helper'
            ? transition('done', invalid as State)
            : { type: 'transition', handler: 'done', state: invalid as State },
        done: (_state, _context, { finish }) => {
          reachedTarget = true;
          return finish();
        },
      });
      const state = { count: 1 };
      const context = { runId: label };
      const result = await definition.run({ initial: 'start', state, context });

      assert.equal(reachedTarget, false);
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
}

for (const style of ['literal', 'helper'] as const) {
  for (const asynchronous of [false, true]) {
    test(`copies ${style} transition state after the ${asynchronous ? 'async' : 'sync'} handler completes`, async () => {
      const nested = { count: 1 };
      const supplied = { count: 1, nested };
      const start: StateMachineHandler<
        Context,
        typeof supplied,
        'start' | 'done',
        number
      > = (_state, _context, { transition }) => {
        const action: StateMachineTransition<
          'start' | 'done',
          typeof supplied
        > =
          style === 'helper'
            ? transition('done', supplied)
            : { type: 'transition', handler: 'done', state: supplied };
        if (asynchronous) {
          return Promise.resolve().then(() => {
            supplied.count = 2;
            return action;
          });
        }
        supplied.count = 2;
        return action;
      };
      const definition = createStateMachine<Context, typeof supplied, number>()(
        {
          start,
          done: (state, _context, { finish }) => {
            assert.notEqual(state, supplied);
            assert.equal(state.nested, nested);
            assert.equal(state.count, 2);
            state.nested.count = 3;
            state.count = 4;
            return finish(state.count);
          },
        },
      );
      const result = await definition.run({
        initial: 'start',
        state: { count: 0, nested },
        context: { runId: 'copy' },
      });

      assert.equal(result.status, 'finished');
      assert.equal(supplied.count, 2);
      assert.equal(nested.count, 3);
      assert.equal(result.state.count, 4);
    });
  }

  test(`accepts null-prototype initial and ${style} transition states and normalizes only the transition`, async () => {
    const initial = Object.assign(Object.create(null), { count: 0 }) as State;
    const supplied = Object.assign(Object.create(null), { count: 1 }) as State;
    const definition = createStateMachine<Context, State>()({
      start: (state, _context, { transition }) => {
        assert.equal(state, initial);
        assert.equal(Object.getPrototypeOf(state), null);
        return style === 'helper'
          ? transition('done', supplied)
          : { type: 'transition', handler: 'done', state: supplied };
      },
      done: (_state, _context, { finish }) => finish(),
    });
    const result = await definition.run({
      initial: 'start',
      state: initial,
      context: { runId: 'null-prototype' },
    });

    assert.equal(result.status, 'finished');
    assert.notEqual(result.state, supplied);
    assert.equal(Object.getPrototypeOf(result.state), Object.prototype);
    assert.equal(result.state.count, 1);
    assert.equal(Object.getPrototypeOf(supplied), null);
  });
}

test('accepts arbitrary nested values without cloning them', async () => {
  const state = {
    array: [1],
    date: new Date(0),
    map: new Map([['key', 1]]),
    instance: new Instance(),
    promise: Promise.resolve(1),
    unknown: Symbol('nested') as unknown,
    callback: () => 1,
  };
  const definition = createStateMachine<Context, typeof state>()({
    start: (current, _context, { transition }) => transition('done', current),
    done: (_state, _context, { finish }) => finish(),
  });
  const result = await definition.run({
    initial: 'start',
    state,
    context: { runId: 'nested' },
  });

  assert.equal(result.status, 'finished');
  assert.notEqual(result.state, state);
  for (const key of Object.keys(state) as (keyof typeof state)[]) {
    assert.equal(result.state[key], state[key]);
  }
});
