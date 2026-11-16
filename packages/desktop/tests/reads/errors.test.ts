/**
 * `errorInfo`, `errorFrom`, `sameErrorInfo` and `ClientError` turn anything a
 * surface catches or reads back from a stored event into one plain-JSON
 * `ErrorInfo` (spec `docs/designs/error-messages.md` §1).
 *
 * Contract matrix:
 * - T-1 shapes: a live `Error` chain, a `ClientError` with and without
 *   `retryable`, a `ContractError`, the stored JSON of provider, agent and tool
 *   errors with their fields under `data`, a string, `undefined`, `null`, a
 *   number, an object whose getters throw; trimming; plain JSON.
 * - T-2 walk: the outermost `handler_failed` wrapper is skipped, a level with a
 *   new code is kept, repeated messages are left out, the walk stops at 8
 *   levels and ends a cyclic chain, `stack`/`details`/`diagnostic`/`name` never
 *   enter the value, and `options.at` is a string kept, `null` absent or
 *   omitted for the current time.
 * - `errorFrom` builds a new outer level over a cause's chain; `sameErrorInfo`
 *   compares everything but `at`.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ContractError } from 'bundle/contracts';

import {
  ClientError,
  type ErrorInfo,
  errorFrom,
  errorInfo,
  sameErrorInfo,
} from '../../src/reads/errors.js';

/** `errorInfo` with no time, so the whole value can be compared. */
const read = (value: unknown): ErrorInfo => errorInfo(value, { at: null });

/** An `Error` with a code and an optional cause, as the packages throw them. */
const coded = (code: string, message: string, cause?: unknown): Error =>
  Object.assign(
    new Error(message, cause === undefined ? undefined : { cause }),
    { code },
  );

describe('errorInfo reads every error shape (T-1)', () => {
  test('reads a live Error chain, outermost first', () => {
    const error = new Error('Could not load the tree.', {
      cause: new Error('socket hang up'),
    });

    assert.deepEqual(read(error), {
      code: '',
      message: 'Could not load the tree.',
      causes: [{ message: 'socket hang up' }],
    });
  });

  test('reads a ClientError by its fields, keeping its code and cause', () => {
    const error = new ClientError('send_failed', 'The prompt was not sent.', {
      cause: coded('unavailable', 'Host gone.'),
    });

    assert.deepEqual(read(error), {
      code: 'send_failed',
      message: 'The prompt was not sent.',
      causes: [{ code: 'unavailable', message: 'Host gone.' }],
    });
  });

  test('keeps the retryable flag a ClientError states', () => {
    const error = new ClientError('queue_action_failed', 'Not updated.', {
      retryable: false,
    });

    assert.deepEqual(read(error), {
      code: 'queue_action_failed',
      message: 'Not updated.',
      retryable: false,
      causes: [],
    });
  });

  test('reads a ContractError by its code and message, without its details', () => {
    const error = new ContractError('not_found', 'No such thread.', {
      thread: 'secret-details',
    });

    const info = read(error);

    assert.deepEqual(info, {
      code: 'not_found',
      message: 'No such thread.',
      causes: [],
    });
  });

  test('reads stored provider, agent and tool error JSON with fields under data', () => {
    const stored = JSON.parse(
      JSON.stringify({
        name: 'ToolErrorObject',
        message: 'Tool failed.',
        data: { code: 'invalid_payload', message: 'Tool failed.' },
        cause: {
          name: 'AgentErrorObject',
          message: 'The run stopped.',
          data: { code: 'turn_limit_exceeded', message: 'The run stopped.' },
          cause: {
            name: 'ProviderError',
            message: 'Too many requests.',
            data: {
              code: 'rate_limit_error',
              provider: 'anthropic',
              status: 429,
              retryable: true,
              message: 'Too many requests.',
            },
          },
        },
      }),
    ) as unknown;

    assert.deepEqual(read(stored), {
      code: 'invalid_payload',
      message: 'Tool failed.',
      causes: [
        { code: 'turn_limit_exceeded', message: 'The run stopped.' },
        {
          code: 'rate_limit_error',
          provider: 'anthropic',
          status: 429,
          retryable: true,
          message: 'Too many requests.',
        },
      ],
    });
  });

  test('takes the message from data when the level has none of its own', () => {
    assert.deepEqual(
      read({
        data: { code: 'http_error', status: 400, message: 'Bad request' },
      }),
      { code: 'http_error', status: 400, message: 'Bad request', causes: [] },
    );
  });

  test('prefers the top-level field over data and ignores a field of the wrong type', () => {
    assert.deepEqual(
      read({
        code: 42,
        status: '500',
        retryable: 'yes',
        message: 'Top.',
        data: { code: 'overloaded_error', status: 529, provider: 'anthropic' },
      }),
      {
        code: 'overloaded_error',
        provider: 'anthropic',
        status: 529,
        message: 'Top.',
        causes: [],
      },
    );
    assert.equal(
      read({ code: 'top_code', data: { code: 'data_code' } }).code,
      'top_code',
    );
  });

  test('reads a string as a level with that message and no code', () => {
    assert.deepEqual(read('  Disk full.  '), {
      code: '',
      message: 'Disk full.',
      causes: [],
    });
  });

  for (const [label, value] of [
    ['undefined', undefined],
    ['null', null],
    ['a number', 404],
  ] as const) {
    test(`reads ${label} as a level with no code and an empty message`, () => {
      assert.deepEqual(read(value), { code: '', message: '', causes: [] });
    });
  }

  test('trims the message of every level', () => {
    assert.deepEqual(
      read(coded('internal', '\n  Outer text \n', new Error('  inner text\t'))),
      {
        code: 'internal',
        message: 'Outer text',
        causes: [{ message: 'inner text' }],
      },
    );
  });

  test('reads a field whose getter throws as absent and does not throw', () => {
    const hostile = {
      get code(): string {
        throw new Error('getter');
      },
      get provider(): string {
        throw new Error('getter');
      },
      message: 'Still readable.',
      get cause(): unknown {
        throw new Error('getter');
      },
    };

    assert.deepEqual(read(hostile), {
      code: '',
      message: 'Still readable.',
      causes: [],
    });
  });

  test('gives a value that survives a JSON round trip unchanged', () => {
    const info = errorInfo(
      new ClientError('send_failed', 'Not sent.', {
        retryable: true,
        cause: {
          message: 'Overloaded',
          data: {
            code: 'overloaded_error',
            provider: 'anthropic',
            status: 529,
          },
          cause: new Error('socket closed'),
        },
      }),
      { at: '2026-11-16T12:00:00.000Z' },
    );

    assert.deepEqual(JSON.parse(JSON.stringify(info)), info);
  });
});

describe('errorInfo walks the cause chain (T-2)', () => {
  test('skips an outermost handler_failed wrapper that has a cause', () => {
    const error = coded(
      'handler_failed',
      'Tool "read_file" failed.',
      coded('not_found', 'No such file: a.txt'),
    );

    assert.deepEqual(read(error), {
      code: 'not_found',
      message: 'No such file: a.txt',
      causes: [],
    });
  });

  test('skips a stored handler_failed wrapper whose code is under data', () => {
    const stored = {
      message: 'Tool "read_file" failed.',
      data: { code: 'handler_failed', message: 'Tool "read_file" failed.' },
      cause: { message: 'EACCES: permission denied' },
    };

    assert.deepEqual(read(stored), {
      code: '',
      message: 'EACCES: permission denied',
      causes: [],
    });
  });

  test('keeps a handler_failed level that has no cause', () => {
    assert.equal(
      read(coded('handler_failed', 'Tool failed.')).code,
      'handler_failed',
    );
  });

  test('keeps a handler_failed level below the outermost one', () => {
    const error = coded(
      'tool_failed',
      'The tool failed.',
      coded('handler_failed', 'Tool "x" failed.'),
    );

    assert.deepEqual(read(error).causes, [
      { code: 'handler_failed', message: 'Tool "x" failed.' },
    ]);
  });

  test('keeps a cause with a new code even when its message repeats', () => {
    const error = coded(
      'send_failed',
      'Not sent: Host gone.',
      coded('unavailable', 'Host gone.'),
    );

    assert.deepEqual(read(error).causes, [
      { code: 'unavailable', message: 'Host gone.' },
    ]);
  });

  test('leaves out a cause whose message repeats an outer one and that adds no code', () => {
    const error = coded(
      'send_failed',
      'Not sent: Host gone.',
      new Error('Host gone.', { cause: coded('send_failed', 'Host gone.') }),
    );

    assert.deepEqual(read(error).causes, []);
  });

  test('leaves out a cause with an empty message and no code', () => {
    const error = coded('send_failed', 'Not sent.', new Error('   '));

    assert.deepEqual(read(error).causes, []);
  });

  test('keeps a cause with a repeated code when its message is new', () => {
    const error = coded(
      'internal',
      'Outer.',
      coded('internal', 'Different inner text.'),
    );

    assert.deepEqual(read(error).causes, [
      { code: 'internal', message: 'Different inner text.' },
    ]);
  });

  test('reads at most 8 levels', () => {
    let chain: Error | undefined;
    for (let level = 9; level >= 0; level -= 1) {
      chain = coded(`code_${level}`, `Message ${level}.`, chain);
    }

    const info = read(chain);

    assert.equal(info.code, 'code_0');
    assert.deepEqual(
      info.causes.map((cause) => cause.code),
      ['code_1', 'code_2', 'code_3', 'code_4', 'code_5', 'code_6', 'code_7'],
    );
  });

  test('reads all 8 levels of a chain exactly that long', () => {
    let chain: Error | undefined;
    for (let level = 7; level >= 0; level -= 1) {
      chain = coded(`code_${level}`, `Message ${level}.`, chain);
    }

    assert.equal(read(chain).causes.length, 7);
  });

  test('ends a cyclic chain', () => {
    const first = coded('first_code', 'First.');
    const second = coded('second_code', 'Second.', first);
    (first as Error & { cause?: unknown }).cause = second;

    assert.deepEqual(read(first), {
      code: 'first_code',
      message: 'First.',
      causes: [{ code: 'second_code', message: 'Second.' }],
    });
  });

  test('never carries the stack, details, diagnostic or name', () => {
    const value = {
      name: 'SecretName',
      stack: 'SecretStack at line 1',
      details: { token: 'SecretDetails' },
      message: 'Request failed.',
      data: {
        code: 'http_error',
        provider: 'openai',
        status: 400,
        diagnostic: 'SecretPayload {"prompt":"hi"}',
      },
      cause: new ContractError('invalid_input', 'Bad input.', {
        field: 'SecretCauseDetails',
      }),
    };

    const text = JSON.stringify(read(value));

    for (const secret of [
      'SecretName',
      'SecretStack',
      'SecretDetails',
      'SecretPayload',
      'SecretCauseDetails',
      'ContractError',
    ]) {
      assert.ok(!text.includes(secret), `${secret} leaked into ${text}`);
    }
  });

  test('keeps options.at when it is a string', () => {
    assert.equal(
      errorInfo(new Error('x'), { at: '2026-01-02T03:04:05.000Z' }).at,
      '2026-01-02T03:04:05.000Z',
    );
  });

  test('leaves at absent when options.at is null', () => {
    assert.ok(!('at' in errorInfo(new Error('x'), { at: null })));
  });

  test('uses the current time when options.at is omitted', (context) => {
    context.mock.timers.enable({
      apis: ['Date'],
      now: Date.parse('2026-11-16T15:30:00.000Z'),
    });

    assert.equal(errorInfo(new Error('x')).at, '2026-11-16T15:30:00.000Z');
  });
});

describe('ClientError', () => {
  test('is an Error carrying the code and message as given', () => {
    const error = new ClientError('config_save_failed', 'Settings not saved.');

    assert.ok(error instanceof Error);
    assert.equal(error.name, 'ClientError');
    assert.equal(error.code, 'config_save_failed');
    assert.equal(error.message, 'Settings not saved.');
  });

  test('sets cause and retryable only when they are given', () => {
    const bare = new ClientError('send_failed', 'Not sent.');
    assert.ok(!('cause' in bare));
    assert.equal(bare.retryable, undefined);
    assert.ok(!('retryable' in errorInfo(bare, { at: null })));

    const original = new Error('Host gone.');
    const full = new ClientError('send_failed', 'Not sent.', {
      cause: original,
      retryable: false,
    });
    assert.equal(full.cause, original);
    assert.equal(full.retryable, false);
  });
});

describe('errorFrom', () => {
  test("puts a new outer level over the cause's whole chain", () => {
    const cause = coded(
      'rate_limit_error',
      'Too many requests.',
      new Error('429 from upstream'),
    );
    Object.assign(cause, {
      provider: 'anthropic',
      status: 429,
      retryable: true,
    });

    assert.deepEqual(
      errorFrom('summarizer_failed', 'Compaction failed.', cause, { at: null }),
      {
        code: 'summarizer_failed',
        message: 'Compaction failed.',
        causes: [
          {
            code: 'rate_limit_error',
            provider: 'anthropic',
            status: 429,
            retryable: true,
            message: 'Too many requests.',
          },
          { message: '429 from upstream' },
        ],
      },
    );
  });

  test('has no causes without a cause', () => {
    assert.deepEqual(
      errorFrom('unsafe_boundary', 'No safe point.', undefined, { at: null }),
      { code: 'unsafe_boundary', message: 'No safe point.', causes: [] },
    );
  });

  test('leaves out a cause that repeats the new outer message and adds no code', () => {
    assert.deepEqual(
      errorFrom('queue_paused', 'Paused: Host gone.', new Error('Host gone.'), {
        at: null,
      }).causes,
      [],
    );
  });

  test('takes at like errorInfo', () => {
    assert.equal(
      errorFrom('x', 'y', undefined, { at: '2026-11-16T00:00:00.000Z' }).at,
      '2026-11-16T00:00:00.000Z',
    );
  });
});

describe('sameErrorInfo', () => {
  const base: ErrorInfo = {
    code: 'http_error',
    provider: 'openai',
    status: 500,
    message: 'Server error.',
    retryable: true,
    causes: [{ code: 'network_error', status: 502, message: 'Bad gateway.' }],
    at: '2026-11-16T10:00:00.000Z',
  };

  test('ignores at', () => {
    assert.equal(
      sameErrorInfo(base, { ...base, at: '2026-11-16T11:00:00.000Z' }),
      true,
    );
    const { at: _at, ...withoutAt } = base;
    assert.equal(sameErrorInfo(base, withoutAt), true);
  });

  test('tells apart values that differ in any other field', () => {
    for (const other of [
      { ...base, code: 'api_error' },
      { ...base, provider: 'anthropic' },
      { ...base, status: 503 },
      { ...base, message: 'Other.' },
      { ...base, retryable: false },
      { ...base, causes: [] },
      {
        ...base,
        causes: [
          { code: 'network_error', status: 503, message: 'Bad gateway.' },
        ],
      },
    ]) {
      assert.equal(sameErrorInfo(base, other), false, JSON.stringify(other));
    }
  });

  test('treats two undefined values as the same and undefined and a value as different', () => {
    assert.equal(sameErrorInfo(undefined, undefined), true);
    assert.equal(sameErrorInfo(undefined, base), false);
    assert.equal(sameErrorInfo(base, undefined), false);
  });
});
