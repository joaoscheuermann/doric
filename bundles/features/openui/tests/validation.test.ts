// B7, B8 and B24–B28 (openui.md D18, U50): the errors windows report through
// `openui.programs/v1` reach the agent in the same turn, as `validation`
// instructs through a fake `runtime.threads/v1`: a `closed` report 200 ms
// after it arrives, within a budget of three per prompt the reader started;
// an `unterminated` or held report at the next
// `runtime.hooks/v1.onPromptStartedHook` the host registers.
// The 200 ms delay runs on node:test's mocked `setTimeout`.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';

import {
  OPENUI_ERROR_CODES,
  OpenuiProgramsV1,
  type ProgramErrorsInput,
  type ReportedError,
} from '../src/contracts/index.js';
import {
  activateHost,
  type HostWorld,
  projectId,
  threadRecord,
} from './support/host.js';

const OPENING =
  'Some OpenUI fences you wrote have errors. Each line is `<tag> <identity> r<revision> <statement>: <code> <text>`. Fix a program by writing a fence with the same tag and identity: a patch of the named statements, or the whole program when you no longer see it.';

/** D18's fixed text of each code, for an error without `message`. */
const FIXED_TEXT: Readonly<
  Record<(typeof OPENUI_ERROR_CODES)[number], string>
> = {
  'missing-required': 'omits a required argument',
  'null-required': 'passes null for a required argument',
  'unknown-component': 'calls a component the library does not have',
  'inline-reserved': 'uses a call inline that must be a statement of its own',
  'excess-args':
    'passes more arguments than the component takes; the extra ones were dropped',
  'type-mismatch': 'passes an argument of the wrong type',
  'unknown-function': 'calls a function or action that does not exist here',
  'no-root': 'has no root statement',
  'runtime-error': 'failed while its values were evaluated',
  'render-error': 'failed while it was drawn',
  'parse-exception': 'could not be parsed',
  'parse-failed': 'is not valid OpenUI Lang; a program starts with root = …',
  'tool-not-found':
    'calls a tool that is not available; write the data as literals',
  'tool-error': 'calls a tool that failed',
  'mcp-error': 'calls a tool server that failed',
};

/** The line of the default report: `trip` r1 with `no-root` and no statement. */
const NO_ROOT = 'openui-lang trip r1 -: no-root has no root statement';

/** The source of a prompt this bundle's validation instruct queued. */
const VALIDATION_SOURCE = {
  kind: 'bundle',
  bundleId: 'openui',
  reason: 'validation',
} as const;

const worlds: HostWorld[] = [];

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout'] });
});

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.deactivate();
  mock.timers.reset();
});

/** Lets pending promises run; `setImmediate` is not mocked. */
const flush = async (): Promise<void> => {
  for (let round = 0; round < 20; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

/** Moves the mocked clock on by `ms` and lets what the timers started settle. */
const elapse = async (ms: number): Promise<void> => {
  await flush();
  mock.timers.tick(ms);
  await flush();
};

const start = async (
  threadIds: readonly string[] = ['thread-1'],
): Promise<HostWorld> => {
  const world = await activateHost();
  worlds.push(world);
  for (const id of threadIds) world.threads.set(id, threadRecord(id));
  return world;
};

/** `reportErrors` as a window of the Thread calls it. */
const report = (
  world: HostWorld,
  threadId: string,
  input: Partial<ProgramErrorsInput> & { readonly key: string },
): Promise<void> =>
  world.test.services
    .use(OpenuiProgramsV1, { projectId, threadId })
    .reportErrors({
      tag: 'openui-lang',
      identity: 'trip',
      revision: 1,
      state: 'closed',
      errors: [{ code: 'no-root' }],
      ...input,
    });

/** The lines of an instruct after its opening text. */
const linesOf = (prompt: string): string[] =>
  prompt
    .slice(OPENING.length)
    .split('\n')
    .filter((line) => line.trim() !== '');

/** The lines of the `index`th instruct. */
const linesAt = (world: HostWorld, index: number): string[] =>
  linesOf(world.instructs[index]?.input.prompt ?? '');

/** A `closed` report of fence `identity` of `prompt`, revision 1, with no root; each identity has its own turn. */
const fence = (prompt: string, identity: string) => ({
  key: `${prompt}/${identity.charCodeAt(0)}/0`,
  identity,
});

/** The line of `fence(_, identity)`. */
const fenceLine = (identity: string): string =>
  `openui-lang ${identity} r1 -: no-root has no root statement`;

/** A promise the test settles, for an `instruct` in flight. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('B7: a closed report is one validation instruct at 200 ms that steers its own prompt, once, and not again at the next prompt start', async () => {
  const world = await start();

  await world.promptStarted('thread-1', 'p1');
  await report(world, 'thread-1', { key: 'p1/1/0' });
  // A second window sends the same report before the instruct.
  await report(world, 'thread-1', { key: 'p1/1/0' });

  await elapse(199);
  assert.equal(world.instructs.length, 0);

  await elapse(1);
  assert.equal(world.instructs.length, 1);
  const [given] = world.instructs;
  assert.equal(given?.input.id, 'thread-1');
  assert.equal(given?.input.reason, 'validation');
  assert.equal(given?.input.promptId, 'p1');
  assert.equal(given?.input.retain, undefined);
  assert.equal(given?.input.interrupt, undefined);
  assert.equal(given?.inHook, false);
  assert.ok(given?.input.prompt.startsWith(OPENING));
  assert.deepEqual(linesAt(world, 0), [NO_ROOT]);

  // And a window sends it again after the instruct.
  await report(world, 'thread-1', { key: 'p1/1/0' });
  await elapse(1000);
  assert.equal(world.instructs.length, 1);

  await world.promptStarted('thread-1', 'p2');
  assert.equal(world.instructs.length, 1);
});

test('B7: two reports within 200 ms, of the two tags with one key, give one instruct with two lines prefixed by their tags', async () => {
  const world = await start();

  await world.promptStarted('thread-1', 'p1');
  const once = {
    key: 'p1/1/0',
    errors: [{ code: 'excess-args' as const, statementId: 'b' }],
  };
  await report(world, 'thread-1', once);
  await elapse(100);
  await report(world, 'thread-1', once);
  await report(world, 'thread-1', { ...once, tag: 'papercraft' });
  // The second report does not restart the delay.
  await elapse(100);

  assert.equal(world.instructs.length, 1);
  assert.deepEqual(linesAt(world, 0), [
    'openui-lang trip r1 b: excess-args passes more arguments than the component takes; the extra ones were dropped',
    'papercraft trip r1 b: excess-args passes more arguments than the component takes; the extra ones were dropped',
  ]);
});

test('B7: 60 errors give 50 lines and say how many more were not listed', async () => {
  const world = await start();
  const errors = (from: number): ReportedError[] =>
    Array.from({ length: 30 }, (_, index) => ({
      code: 'type-mismatch',
      statementId: `s${from + index}`,
    }));

  await world.promptStarted('thread-1', 'p1');
  await report(world, 'thread-1', { key: 'p1/1/0', errors: errors(0) });
  await report(world, 'thread-1', { key: 'p1/1/1', errors: errors(30) });
  await elapse(200);

  assert.equal(world.instructs.length, 1);
  const lines = linesAt(world, 0);
  assert.equal(
    lines.filter((line) => line.startsWith('openui-lang trip r1 s')).length,
    50,
  );
  assert.equal(lines.at(-1), 'and 10 more errors were not listed');
});

test('a message the shell computed is written instead of the fixed text', async () => {
  const world = await start();

  await world.promptStarted('thread-1', 'p1');
  await report(world, 'thread-1', {
    key: 'p1/1/0',
    identity: '_3',
    revision: 2,
    errors: [
      {
        code: 'runtime-error',
        statementId: 'root',
        message: 'OpenUrl is disabled; write the link as text',
      },
    ],
  });
  await elapse(200);

  assert.deepEqual(linesAt(world, 0), [
    'openui-lang _3 r2 root: runtime-error OpenUrl is disabled; write the link as text',
  ]);
});

test("B24: after a 'queued' answer a second report waits for the queued prompt's start, which steers it with its own promptId", async () => {
  const world = await start();
  world.answers.instruct = () => ({ status: 'queued', promptId: 'v1' });

  await world.promptStarted('thread-1', 'p1');
  await report(world, 'thread-1', fence('p1', 'a'));
  await elapse(200);
  assert.equal(world.instructs.length, 1);
  assert.equal(world.instructs[0]?.input.promptId, 'p1');

  world.answers.instruct = undefined;
  await report(world, 'thread-1', fence('p1', 'b'));
  await elapse(1000);
  assert.equal(world.instructs.length, 1);

  await world.promptStarted('thread-1', 'v1', VALIDATION_SOURCE);
  assert.equal(world.instructs.length, 2);
  assert.equal(world.instructs[1]?.input.promptId, 'v1');
  assert.equal(world.instructs[1]?.input.reason, 'validation');
  assert.equal(world.instructs[1]?.inHook, true);
  assert.deepEqual(linesAt(world, 1), [fenceLine('b')]);
});

test("B24: a closed report for the previous prompt after the next one started steers the prompt that runs now", async () => {
  const world = await start();

  await world.promptStarted('thread-1', 'p1');
  await world.promptStarted('thread-1', 'p2');
  await report(world, 'thread-1', { key: 'p1/2/0' });
  await elapse(200);

  assert.equal(world.instructs.length, 1);
  assert.equal(world.instructs[0]?.input.promptId, 'p2');
  assert.deepEqual(linesAt(world, 0), [NO_ROOT]);
});

test('B25: an unterminated report gives no instruct at 200 ms or later; the next prompt start gives its lines and the cut-off line, once, also when a second window sends it again', async () => {
  const world = await start();

  await world.promptStarted('thread-1', 'p1');
  await world.promptStarted('thread-1', 'p2');
  const late = {
    key: 'p1/3/0',
    state: 'unterminated' as const,
    errors: [{ code: 'type-mismatch' as const, statementId: 'tbl' }],
  };
  await report(world, 'thread-1', late);
  await report(world, 'thread-1', late);
  await elapse(200);
  await elapse(5000);
  assert.equal(world.instructs.length, 0);

  await world.promptStarted('thread-1', 'p3');
  assert.equal(world.instructs.length, 1);
  assert.equal(world.instructs[0]?.input.promptId, 'p3');
  assert.equal(world.instructs[0]?.inHook, true);
  assert.deepEqual(linesAt(world, 0), [
    'openui-lang trip r1 tbl: type-mismatch passes an argument of the wrong type',
    'openui-lang trip r1: cut off before the fence closed',
  ]);

  await world.promptStarted('thread-1', 'p4');
  assert.equal(world.instructs.length, 1);
});

test('B25: an unterminated report and a closed report held by a zero budget are given in one instruct at the next prompt start, the unterminated lines first', async () => {
  const world = await start();

  await world.promptStarted('thread-1', 'p1');
  for (const identity of ['a', 'b', 'c']) {
    await report(world, 'thread-1', fence('p1', identity));
    await elapse(300);
  }
  assert.equal(world.instructs.length, 3);

  await report(world, 'thread-1', {
    key: 'p1/9/0',
    identity: 'u',
    state: 'unterminated',
    errors: [],
  });
  await report(world, 'thread-1', fence('p1', 'd'));
  await elapse(1000);
  assert.equal(world.instructs.length, 3);

  await world.promptStarted('thread-1', 'p2');
  assert.equal(world.instructs.length, 4);
  assert.equal(world.instructs[3]?.input.promptId, 'p2');
  assert.deepEqual(linesAt(world, 3), [
    'openui-lang u r1: cut off before the fence closed',
    fenceLine('d'),
  ]);
});

test('B25: a report for the prompt before the previous one, and one before any prompt start, are dropped', async () => {
  const world = await start(['thread-1', 'thread-2']);

  await report(world, 'thread-2', { key: 'p0/1/0' });
  await world.promptStarted('thread-2', 'q1');

  await world.promptStarted('thread-1', 'p1');
  await world.promptStarted('thread-1', 'p2');
  await world.promptStarted('thread-1', 'p3');
  await report(world, 'thread-1', { key: 'p1/1/0' });
  await elapse(1000);
  await world.promptStarted('thread-1', 'p4');
  await world.promptStarted('thread-2', 'q2');

  assert.deepEqual(world.instructs, []);
});

test('B26: three immediate instructs per prompt the reader started; a validation start keeps the budget at zero and a user start restores it', async () => {
  const world = await start();

  await world.promptStarted('thread-1', 'p1');
  for (const identity of ['a', 'b', 'c', 'd']) {
    await report(world, 'thread-1', fence('p1', identity));
    await elapse(300);
  }
  assert.equal(world.instructs.length, 3);
  assert.deepEqual(
    [0, 1, 2].map((index) => linesAt(world, index)),
    [[fenceLine('a')], [fenceLine('b')], [fenceLine('c')]],
  );

  // The fourth report's lines come at the next prompt start.
  await world.promptStarted('thread-1', 'p2');
  assert.equal(world.instructs.length, 4);
  assert.equal(world.instructs[3]?.input.promptId, 'p2');
  assert.equal(world.instructs[3]?.inHook, true);
  assert.deepEqual(linesAt(world, 3), [fenceLine('d')]);

  for (const identity of ['e', 'f', 'g']) {
    await report(world, 'thread-1', fence('p2', identity));
    await elapse(300);
  }
  assert.equal(world.instructs.length, 7);

  // A start the validation instruct caused leaves the budget at zero.
  await world.promptStarted('thread-1', 'v1', VALIDATION_SOURCE);
  await report(world, 'thread-1', fence('v1', 'h'));
  await elapse(1000);
  assert.equal(world.instructs.length, 7);

  // A user start restores it.
  await world.promptStarted('thread-1', 'p3');
  assert.equal(world.instructs.length, 8);
  assert.deepEqual(linesAt(world, 7), [fenceLine('h')]);
  for (const identity of ['i', 'j', 'k']) {
    await report(world, 'thread-1', fence('p3', identity));
    await elapse(300);
  }

  assert.deepEqual(
    world.instructs.map(({ input, inHook }) => [input.promptId, inHook]),
    [
      ['p1', false],
      ['p1', false],
      ['p1', false],
      ['p2', true],
      ['p2', false],
      ['p2', false],
      ['p2', false],
      ['p3', true],
      ['p3', false],
      ['p3', false],
      ['p3', false],
    ],
  );
});

for (const [name, answer] of [
  ["answering 'inactive'", () => ({ status: 'inactive' })],
  ['rejecting', () => Promise.reject(new Error('The runtime is gone.'))],
] as const) {
  test(`B27: with instruct ${name}, a closed report's lines are given once at the next prompt start, and the budget is unchanged`, async () => {
    const world = await start();
    world.answers.instruct = answer;

    await world.promptStarted('thread-1', 'p1');
    await report(world, 'thread-1', fence('p1', 'a'));
    await elapse(200);
    assert.equal(world.instructs.length, 1);
    // Nothing is retried before the next prompt start.
    await elapse(5000);
    assert.equal(world.instructs.length, 1);

    // The failed instruct took nothing from the budget: three more go out.
    world.answers.instruct = undefined;
    for (const identity of ['b', 'c', 'd']) {
      await report(world, 'thread-1', fence('p1', identity));
      await elapse(300);
    }
    assert.equal(world.instructs.length, 4);
    await report(world, 'thread-1', fence('p1', 'e'));
    await elapse(1000);
    assert.equal(world.instructs.length, 4);

    await world.promptStarted('thread-1', 'p2');
    assert.equal(world.instructs.length, 5);
    assert.equal(world.instructs[4]?.input.promptId, 'p2');
    assert.deepEqual(linesAt(world, 4), [fenceLine('a'), fenceLine('e')]);

    await world.promptStarted('thread-1', 'p3');
    assert.equal(world.instructs.length, 5);
  });
}

test('B27: a report that arrives while an instruct is in flight is given in a second instruct after the first settles', async () => {
  const world = await start();
  const flight = deferred<unknown>();
  world.answers.instruct = () => flight.promise;

  await world.promptStarted('thread-1', 'p1');
  await report(world, 'thread-1', fence('p1', 'a'));
  await elapse(200);
  assert.equal(world.instructs.length, 1);

  await report(world, 'thread-1', fence('p1', 'b'));
  await elapse(1000);
  assert.equal(world.instructs.length, 1);

  world.answers.instruct = undefined;
  flight.resolve({ status: 'steered', promptId: 'p1' });
  await elapse(200);

  assert.equal(world.instructs.length, 2);
  assert.equal(world.instructs[1]?.input.promptId, 'p1');
  assert.deepEqual(linesAt(world, 1), [fenceLine('b')]);
});

test('B28: deactivating the host with a timer pending gives no instruct after it', async () => {
  const world = await start(['thread-1', 'thread-2']);

  await world.promptStarted('thread-1', 'p1');
  await world.promptStarted('thread-2', 'q1');
  await report(world, 'thread-2', { key: 'q1/1/0' });
  await elapse(200);
  assert.equal(world.instructs.length, 1);

  await report(world, 'thread-1', { key: 'p1/1/0' });
  await elapse(100);
  await world.deactivate();
  await elapse(5000);

  assert.deepEqual(
    world.instructs.map(({ input }) => input.id),
    ['thread-2'],
  );
});

test('B28: after prompt starts in 1,001 Threads the Thread whose prompt started longest ago has no entry: its pending report gives no instruct, and a new report for it is dropped', async () => {
  const ids = Array.from({ length: 1001 }, (_, index) => `thread-${index}`);
  const world = await start(ids);

  for (const id of ids.slice(0, 1000)) {
    await world.promptStarted(id, `${id}-p1`);
  }
  await report(world, 'thread-0', { key: 'thread-0-p1/1/0' });
  // thread-1000's start adds the 1,001st entry and evicts thread-0, timer and all.
  await world.promptStarted('thread-1000', 'thread-1000-p1');
  await elapse(200);
  assert.equal(world.instructs.length, 0);

  await report(world, 'thread-0', { key: 'thread-0-p1/2/0' });
  await report(world, 'thread-1', { key: 'thread-1-p1/1/0' });
  await elapse(200);
  // thread-0 has none: its start adds the 1,001st entry, gives nothing and
  // evicts thread-1, now the Thread whose prompt started longest ago.
  await world.promptStarted('thread-0', 'thread-0-p2');
  await world.promptStarted('thread-2', 'thread-2-p2');

  assert.deepEqual(
    world.instructs.map(({ input }) => input.id),
    ['thread-1'],
  );
});

test('B28: a prompt start with no lines gives no instruct', async () => {
  const world = await start();

  await world.promptStarted('thread-1', 'p1');
  await world.promptStarted('thread-1', 'p2');
  assert.equal(world.instructs.length, 0);

  await report(world, 'thread-1', { key: 'p2/1/0' });
  await elapse(200);
  assert.equal(world.instructs.length, 1);
  assert.equal(world.instructs[0]?.inHook, false);

  await world.promptStarted('thread-1', 'p3');
  await world.promptStarted('thread-1', 'p4');
  assert.equal(world.instructs.length, 1);
});

test("B8: an error without message is written with its code's fixed text, for each of the 15 codes", async () => {
  const world = await start();

  await world.promptStarted('thread-1', 'p1');
  await report(world, 'thread-1', {
    key: 'p1/1/0',
    errors: OPENUI_ERROR_CODES.map((code, index) => ({
      code,
      statementId: `s${index}`,
    })),
  });
  await elapse(200);

  assert.deepEqual(
    linesAt(world, 0),
    OPENUI_ERROR_CODES.map(
      (code, index) =>
        `openui-lang trip r1 s${index}: ${code} ${FIXED_TEXT[code]}`,
    ),
  );
});

test('B8: a bad statementId, an unknown code, a message over 300 characters and 51 errors are invalid_input', async () => {
  const world = await start();
  await world.promptStarted('thread-1', 'p1');

  const invalid: unknown[] = [
    [{ code: 'no-root', statementId: '1bad' }],
    [{ code: 'not-a-code' }],
    [{ code: 'no-root', message: 'm'.repeat(301) }],
    Array.from({ length: 51 }, (_, index) => ({
      code: 'no-root',
      statementId: `s${index}`,
    })),
  ];

  for (const errors of invalid) {
    await assert.rejects(
      async () =>
        report(world, 'thread-1', {
          key: 'p1/1/0',
          errors: errors as ReportedError[],
        }),
      { code: 'invalid_input' },
    );
  }

  await elapse(1000);
  await world.promptStarted('thread-1', 'p2');
  assert.deepEqual(world.instructs, []);
});
