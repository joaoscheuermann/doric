import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createStateMachine,
  type StateMachineErrorData,
  type StateMachineResult,
} from '../src/index.js';

test('constrains plain data states, actions, results, and error handler names', () => {
  const assertTypes = () => {
    // @ts-expect-error arrays are not top-level state records.
    createStateMachine<void, number[]>();
    // @ts-expect-error dates are not top-level state records.
    createStateMachine<void, Date>();
    // @ts-expect-error maps are not top-level state records.
    createStateMachine<void, Map<string, unknown>>();

    createStateMachine<
      void,
      { count: number },
      string,
      { code: 'cancelled' }
    >()({
      start: (state, _context, { transition, finish, fail }) => {
        // @ts-expect-error handler names come from the definition.
        transition('missing', state);
        // @ts-expect-error transition state must retain its declared shape.
        transition('start', { count: 'wrong' });
        // @ts-expect-error finish values must match the configured result type.
        finish(1);
        // @ts-expect-error failures must match the configured domain type.
        fail({ code: 'other' });
        return finish('done');
      },
    });

    const data: StateMachineErrorData<'start'> = {
      code: 'handler_failed',
      message: 'failed',
      handler: 'start',
    };
    const handler: 'start' = data.handler;
    void handler;
    // @ts-expect-error the former handler-name field is no longer public.
    void data.state;
    // @ts-expect-error error attribution preserves the handler name union.
    const wrongHandler: 'missing' = data.handler;
    void wrongHandler;

    const inspect = (
      result: StateMachineResult<
        'start',
        { count: number },
        void,
        string,
        { code: 'cancelled' }
      >,
    ) => {
      if (result.status === 'finished') {
        const value: string | undefined = result.value;
        void value;
        // @ts-expect-error finished results do not have an error.
        void result.error;
      } else if (result.status === 'failed') {
        const code: 'cancelled' = result.error.code;
        void code;
        // @ts-expect-error failed results do not have a finished value.
        void result.value;
      } else {
        const name: 'start' = result.error.data.handler;
        void name;
        // @ts-expect-error engine errors do not have domain failure codes.
        const code: 'cancelled' = result.error.data.code;
        void code;
      }
    };
    void inspect;
  };

  assert.equal(typeof assertTypes, 'function');
});
