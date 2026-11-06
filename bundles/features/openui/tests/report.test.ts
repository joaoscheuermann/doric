// B15 (openui.md D18): the shell's error reporter, one per fence key and
// revision. It sends once, at the first `onError` call of a `closed` or
// `unterminated` fence, what that call and the owner's check give, clamped so
// the host's schema never refuses the report.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createErrorReporter,
  type ErrorReporterInput,
  type OpenUIErrorLike,
  type ProgramErrorsInput,
  programErrorsInputSchema,
  type ReportedError,
  shownErrors,
} from '../src/contracts/index.js';

const HINT =
  'Repository components and Export exist only in papercraft fences.';

/** D29's map: OpenUI's message, with D7's hint for `unknown-component`, cut to 300. */
const conversationMap = (error: OpenUIErrorLike): ReportedError => {
  const message =
    error.code === 'unknown-component'
      ? `${error.message} ${HINT}`
      : error.message;
  return {
    code: error.code as ReportedError['code'],
    ...(error.statementId === undefined
      ? {}
      : { statementId: error.statementId }),
    message: message.slice(0, 300),
  };
};

/** A reporter over a recording `send`, with the input's other fields overridable. */
const reporterWith = (overrides: Partial<ErrorReporterInput> = {}) => {
  const sent: ProgramErrorsInput[] = [];
  const reporter = createErrorReporter({
    tag: 'openui-lang',
    key: 'prompt-1/2/0',
    identity: 'trip-plan',
    revision: 2,
    mergeFailed: false,
    check: () => [],
    map: (error) => ({
      code: error.code as ReportedError['code'],
      ...(error.statementId === undefined
        ? {}
        : { statementId: error.statementId }),
      message: error.message,
    }),
    send: async (input) => {
      sent.push(input);
    },
    ...overrides,
  });
  return { reporter, sent };
};

const error = (
  code: string,
  message: string,
  extra: Partial<OpenUIErrorLike> = {},
): OpenUIErrorLike => ({ code, message, ...extra });

test('onError calls while streaming send nothing', () => {
  const { reporter, sent } = reporterWith();

  reporter.onError([error('unknown-component', 'Foo is unknown')], 'streaming');
  reporter.onError([error('no-root', 'No root')], 'streaming');

  assert.deepEqual(sent, []);
});

test('the first closed call sends once, check results before mapped errors, and a later call sends nothing', () => {
  const { reporter, sent } = reporterWith({
    check: () => [
      {
        code: 'tool-not-found',
        statementId: 'data',
        message:
          'Query and Mutation are not available; write the data as literals.',
      },
    ],
  });

  reporter.onError(
    [error('excess-args', 'Too many', { statementId: 'tbl' })],
    'streaming',
  );
  reporter.onError(
    [error('excess-args', 'Too many', { statementId: 'tbl' })],
    'closed',
  );
  reporter.onError(
    [error('type-mismatch', 'Wrong type', { statementId: 'x' })],
    'closed',
  );

  assert.deepEqual(sent, [
    {
      tag: 'openui-lang',
      key: 'prompt-1/2/0',
      identity: 'trip-plan',
      revision: 2,
      state: 'closed',
      errors: [
        {
          code: 'tool-not-found',
          statementId: 'data',
          message:
            'Query and Mutation are not available; write the data as literals.',
        },
        { code: 'excess-args', statementId: 'tbl', message: 'Too many' },
      ],
    },
  ]);
});

test('warnings and unknown codes are left out', () => {
  const { reporter, sent } = reporterWith();

  reporter.onError(
    [
      error('missing-required', 'A warning', {
        severity: 'warning',
        statementId: 'a',
      }),
      error('made-up-code', 'Not an OpenUI code', { statementId: 'b' }),
      error('no-root', 'No root'),
    ],
    'closed',
  );

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]?.errors, [{ code: 'no-root', message: 'No root' }]);
});

test('a closed fence with no error sends nothing', () => {
  const { reporter, sent } = reporterWith();

  reporter.onError([], 'closed');

  assert.deepEqual(sent, []);
});

test('an unterminated fence with no error sends errors: []', () => {
  const { reporter, sent } = reporterWith();

  reporter.onError([], 'unterminated');

  assert.deepEqual(sent, [
    {
      tag: 'openui-lang',
      key: 'prompt-1/2/0',
      identity: 'trip-plan',
      revision: 2,
      state: 'unterminated',
      errors: [],
    },
  ]);
});

test("a map that appends D7's hint gives a message that starts with OpenUI's and is at most 300 characters", () => {
  const { reporter, sent } = reporterWith({ map: conversationMap });
  const openuiMessage = `Component Chart3D is not in the library. ${'x'.repeat(280)}`;

  reporter.onError(
    [
      error('unknown-component', 'Component Foo is not in the library.', {
        statementId: 'a',
      }),
      error('unknown-component', openuiMessage, { statementId: 'b' }),
    ],
    'closed',
  );

  const [short, long] = sent[0]?.errors ?? [];
  assert.equal(short?.message, `Component Foo is not in the library. ${HINT}`);
  assert.ok(
    long?.message?.startsWith('Component Chart3D is not in the library.'),
  );
  assert.ok((long?.message?.length ?? 0) <= 300);
});

test('an error with a statementId of 65 characters is sent without it', () => {
  const { reporter, sent } = reporterWith();

  reporter.onError(
    [
      error('type-mismatch', 'Wrong type', {
        statementId: `s${'a'.repeat(64)}`,
      }),
    ],
    'closed',
  );

  assert.deepEqual(sent[0]?.errors, [
    { code: 'type-mismatch', message: 'Wrong type' },
  ]);
  assert.equal(programErrorsInputSchema.safeParse(sent[0]).success, true);
});

test('a message of 400 characters is sent as 300 ending in …', () => {
  const { reporter, sent } = reporterWith();
  const message = 'm'.repeat(400);

  reporter.onError([error('runtime-error', message)], 'closed');

  const sentMessage = sent[0]?.errors[0]?.message ?? '';
  assert.equal(sentMessage.length, 300);
  assert.equal(sentMessage, `${'m'.repeat(299)}…`);
});

test('60 errors send 50', () => {
  const { reporter, sent } = reporterWith();
  const errors = Array.from({ length: 60 }, (_, index) =>
    error('type-mismatch', `Wrong type ${index}`, { statementId: `s${index}` }),
  );

  reporter.onError(errors, 'closed');

  assert.equal(sent[0]?.errors.length, 50);
  assert.equal(sent[0]?.errors[0]?.statementId, 's0');
  assert.equal(sent[0]?.errors[49]?.statementId, 's49');
  assert.equal(programErrorsInputSchema.safeParse(sent[0]).success, true);
});

test("with mergeFailed the first error is D18's parse-exception", () => {
  const { reporter, sent } = reporterWith({
    mergeFailed: true,
    check: () => [
      { code: 'runtime-error', statementId: 'root', message: 'checked' },
    ],
  });

  reporter.onError([error('no-root', 'No root')], 'closed');

  assert.deepEqual(sent[0]?.errors, [
    {
      code: 'parse-exception',
      message:
        'This patch could not be merged into the previous revision; write the whole program again.',
    },
    { code: 'runtime-error', statementId: 'root', message: 'checked' },
    { code: 'no-root', message: 'No root' },
  ]);
});

test('a send that rejects raises nothing and is not called again', async () => {
  let calls = 0;
  const { reporter } = reporterWith({
    send: async () => {
      calls += 1;
      throw new Error('unavailable');
    },
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);

  try {
    assert.doesNotThrow(() =>
      reporter.onError([error('no-root', 'No root')], 'closed'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    reporter.onError([error('no-root', 'No root')], 'closed');
    reporter.onError([error('no-root', 'No root')], 'unterminated');
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  assert.equal(calls, 1);
  assert.deepEqual(unhandled, []);
});

// B15 (changed, U49): `sent()` tells the card's footer whether the report went.

test('sent() is false before any call, after streaming calls and after a closed call with no error', () => {
  const { reporter } = reporterWith();

  assert.equal(reporter.sent(), false);
  reporter.onError([error('no-root', 'No root')], 'streaming');
  assert.equal(reporter.sent(), false);
  reporter.onError([], 'closed');
  assert.equal(reporter.sent(), false);
});

test('sent() is true after the first call that sends', () => {
  const { reporter, sent } = reporterWith();

  reporter.onError([error('no-root', 'No root')], 'streaming');
  reporter.onError([error('no-root', 'No root')], 'closed');

  assert.equal(sent.length, 1);
  assert.equal(reporter.sent(), true);
});

test('sent() is true after an unterminated call with no error', () => {
  const { reporter } = reporterWith();

  reporter.onError([], 'unterminated');

  assert.equal(reporter.sent(), true);
});

test('sent() is true once send was called, also when send rejects', async () => {
  const { reporter } = reporterWith({
    send: async () => {
      throw new Error('unavailable');
    },
  });

  reporter.onError([error('no-root', 'No root')], 'closed');
  assert.equal(reporter.sent(), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reporter.sent(), true);
});

// B29 (openui.md D18, "The reader's card"): the card's lines.

const MERGE_MESSAGE =
  'This patch could not be merged into the previous revision; write the whole program again.';

test("with mergeFailed the first line is D18's merge error", () => {
  const lines = shownErrors({
    mergeFailed: true,
    owned: [{ code: 'tool-not-found', statementId: 'data', message: 'owned' }],
    rendered: [error('no-root', 'No root')],
  });

  assert.deepEqual(lines, [
    { code: 'parse-exception', message: MERGE_MESSAGE },
    { code: 'tool-not-found', statementId: 'data', message: 'owned' },
    { code: 'no-root', message: 'No root' },
  ]);
});

test('owned lines come before rendered lines', () => {
  const lines = shownErrors({
    mergeFailed: false,
    owned: [
      { code: 'unknown-function', statementId: 'btn', message: 'checked' },
    ],
    rendered: [
      error('unknown-component', 'Foo is unknown', { statementId: 'card' }),
    ],
  });

  assert.deepEqual(lines, [
    { code: 'unknown-function', statementId: 'btn', message: 'checked' },
    { code: 'unknown-component', statementId: 'card', message: 'Foo is unknown' },
  ]);
});

test('a rendered warning is left out and a code outside OPENUI_ERROR_CODES is kept', () => {
  const lines = shownErrors({
    mergeFailed: false,
    owned: [],
    rendered: [
      error('missing-required', 'A warning', {
        severity: 'warning',
        statementId: 'a',
      }),
      error('made-up-code', 'Said by the renderer', { statementId: 'b' }),
    ],
  });

  assert.deepEqual(lines, [
    { code: 'made-up-code', statementId: 'b', message: 'Said by the renderer' },
  ]);
});

test('of an owned and a rendered error with the same code and statement only the owned one is listed', () => {
  const lines = shownErrors({
    mergeFailed: false,
    owned: [
      {
        code: 'unknown-component',
        statementId: 'card',
        message: 'Foo is unknown. With a hint.',
      },
    ],
    rendered: [
      error('unknown-component', 'Foo is unknown', { statementId: 'card' }),
      error('unknown-component', 'Bar is unknown', { statementId: 'other' }),
    ],
  });

  assert.deepEqual(lines, [
    {
      code: 'unknown-component',
      statementId: 'card',
      message: 'Foo is unknown. With a hint.',
    },
    { code: 'unknown-component', statementId: 'other', message: 'Bar is unknown' },
  ]);
});

test('an owned error without message shows its code', () => {
  const lines = shownErrors({
    mergeFailed: false,
    owned: [{ code: 'no-root', statementId: 'root' }],
    rendered: [],
  });

  assert.deepEqual(lines, [
    { code: 'no-root', statementId: 'root', message: 'no-root' },
  ]);
});

test('60 errors give 50 lines', () => {
  const lines = shownErrors({
    mergeFailed: false,
    owned: [],
    rendered: Array.from({ length: 60 }, (_, index) =>
      error('type-mismatch', `Wrong type ${index}`, {
        statementId: `s${index}`,
      }),
    ),
  });

  assert.equal(lines.length, 50);
  assert.equal(lines[0]?.statementId, 's0');
  assert.equal(lines[49]?.statementId, 's49');
});

test('a message of 400 characters gives 300 ending in …', () => {
  const lines = shownErrors({
    mergeFailed: false,
    owned: [],
    rendered: [error('runtime-error', 'm'.repeat(400))],
  });

  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.message.length, 300);
  assert.equal(lines[0]?.message, `${'m'.repeat(299)}…`);
});

test('a statementId of 65 characters is removed and its line kept', () => {
  const lines = shownErrors({
    mergeFailed: false,
    owned: [],
    rendered: [
      error('type-mismatch', 'Wrong type', {
        statementId: `s${'a'.repeat(64)}`,
      }),
    ],
  });

  assert.deepEqual(lines, [{ code: 'type-mismatch', message: 'Wrong type' }]);
});

test('nothing to show gives no line', () => {
  assert.deepEqual(
    shownErrors({ mergeFailed: false, owned: [], rendered: [] }),
    [],
  );
});
