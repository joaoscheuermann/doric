import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createStateMachine,
  StateMachineError,
  type StateMachineErrorCode,
  type StateMachineHandler,
} from '../src/index.js';

type Context = {
  readonly runId: string;
};

type State = {
  count: number;
};

type DomainFailure = {
  readonly code: 'cancelled';
};

test('infers available handlers from the initialized object', () => {
  const definition = createStateMachine<
    Context,
    State,
    string,
    DomainFailure
  >()({
    start: (state, context, { transition }) => {
      const count: number = state.count;
      const runId: string = context.runId;

      void count;

      void runId;

      // @ts-expect-error transitions require the configured state object type.
      void transition('done', { value: 'wrong' });

      // @ts-expect-error transitions accept only initialized handler names.
      return transition('missing', state);
    },
    done: (_state, _context, { finish, fail }) => {
      // @ts-expect-error fail requires the configured domain failure.
      void fail();

      return finish('complete');
    },
  });

  const assertTypes = () => {
    void definition.run({
      initial: 'start',
      state: { count: 0 },
      context: { runId: 'typed' },
    });

    void definition.run({
      // @ts-expect-error initial accepts only initialized handler names.
      initial: 'missing',
      state: { count: 0 },
      context: { runId: 'typed' },
    });

    const supported: StateMachineErrorCode = 'handler_failed';

    void supported;

    // @ts-expect-error lifecycle errors are not reusable-definition errors.
    const removed: StateMachineErrorCode = 'concurrent_dispatch';

    void removed;
  };

  assert.equal(typeof assertTypes, 'function');
});

test('copies the explicitly supplied state before calling the next handler', async () => {
  const received: State[] = [];
  const supplied: State[] = [];

  const definition = createStateMachine<
    Context,
    State,
    string,
    DomainFailure
  >()({
    start: async (state, _context, { transition }) => {
      received.push(state);

      await Promise.resolve();

      const next = { count: state.count + 1 };

      supplied.push(next);

      return transition('middle', next);
    },
    middle: (state, _context, { transition }) => {
      received.push(state);

      const next = { count: state.count + 1 };

      supplied.push(next);

      return transition('done', next);
    },
    done: (state, context, { finish }) => {
      received.push(state);

      return finish(`${context.runId}:${state.count}`);
    },
  });
  const initial = { count: 0 };
  const context = { runId: 'chain' };

  const result = await definition.run({
    initial: 'start',
    state: initial,
    context,
  });

  assert.equal(received.length, 3);

  assert.strictEqual(received[0], initial);

  assert.notStrictEqual(received[1], supplied[0]);

  assert.notStrictEqual(received[2], supplied[1]);

  assert.deepEqual(result, {
    status: 'finished',
    value: 'chain:2',
    handler: 'done',
    state: { count: 2 },
    context,
  });
});

test('returns the exact domain failure and current state', async () => {
  const failure: DomainFailure = { code: 'cancelled' };

  const definition = createStateMachine<
    Context,
    State,
    string,
    DomainFailure
  >()({
    start: (state, _context, { fail }) => {
      state.count += 1;

      return fail(failure);
    },
  });
  const context = { runId: 'failed' };

  const result = await definition.run({
    initial: 'start',
    state: { count: 0 },
    context,
  });

  assert.equal(result.status, 'failed');

  if (result.status === 'failed') {
    assert.equal(result.error, failure);

    assert.equal(result.handler, 'start');

    assert.deepEqual(result.state, { count: 1 });

    assert.equal(result.context, context);
  }
});

test('preserves a thrown handler value as the engine error cause', async () => {
  const thrown = { reason: 'boom' };

  const definition = createStateMachine<Context, State>()({
    start: () => {
      throw thrown;
    },
  });

  const result = await definition.run({
    initial: 'start',
    state: { count: 0 },
    context: { runId: 'thrown' },
  });

  assert.equal(result.status, 'error');

  if (result.status === 'error') {
    assert.ok(result.error instanceof StateMachineError);

    assert.equal(result.error.data.code, 'handler_failed');

    assert.equal(result.error.cause, thrown);

    assert.equal(result.handler, 'start');
  }
});

test('reuses one definition for independent concurrent runs', async () => {
  type ConcurrentState = {
    value: string;
    gate: Promise<void>;
  };

  const definition = createStateMachine<Context, ConcurrentState, string>()({
    start: async (state, context, { finish }) => {
      await state.gate;

      return finish(`${context.runId}:${state.value}`);
    },
  });
  let releaseFirst: () => void = () => undefined;

  let releaseSecond: () => void = () => undefined;

  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });

  const first = definition.run({
    initial: 'start',
    state: { value: 'one', gate: firstGate },
    context: { runId: 'first' },
  });

  const second = definition.run({
    initial: 'start',
    state: { value: 'two', gate: secondGate },
    context: { runId: 'second' },
  });

  releaseSecond();

  const secondResult = await second;

  releaseFirst();

  const firstResult = await first;

  assert.equal(
    firstResult.status === 'finished' ? firstResult.value : undefined,
    'first:one',
  );

  assert.equal(
    secondResult.status === 'finished' ? secondResult.value : undefined,
    'second:two',
  );
});

test('returns an engine error when a handler returns an invalid action', async () => {
  const definition = createStateMachine<Context, State>()({
    start: (() => undefined) as unknown as StateMachineHandler<
      Context,
      State,
      'start'
    >,
  });

  const result = await definition.run({
    initial: 'start',
    state: { count: 0 },
    context: { runId: 'invalid' },
  });

  assert.equal(result.status, 'error');

  if (result.status === 'error') {
    assert.equal(result.error.data.code, 'invalid_handler_return');

    assert.equal(result.handler, 'start');
  }
});

test('defensively returns an engine error when a handler is missing', async () => {
  const handlers = {} as Record<
    'start',
    StateMachineHandler<Context, State, 'start'>
  >;
  const definition = createStateMachine<Context, State>()(handlers);

  const result = await definition.run({
    initial: 'start',
    state: { count: 0 },
    context: { runId: 'missing' },
  });

  assert.equal(result.status, 'error');

  if (result.status === 'error') {
    assert.equal(result.error.data.code, 'missing_handler');

    assert.equal(result.handler, 'start');
  }
});
