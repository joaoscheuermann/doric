// R1–R5 (phase 3, S56): `openui.programs/v1` and the `onPromptStartedHook`
// handler over the router keep the kernel's validation behaviour (D18, U50):
// a closed report is one `validation` instruct 200 ms later, made outside
// every call (D5); held lines go out at the next prompt start, in the hook's
// call; three immediate instructs per prompt the reader started.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ContractError } from 'bundle/contracts';

import type { ReportErrorsRequest } from '../src/contracts/gen/doric/openui/programs/v1/programs_pb.js';
import { OPENUI_ERROR_CODES } from '../src/contracts/index.js';
import {
  type FakeCall,
  failureOf,
  projectId,
  type RouterWorld,
  routerWorld,
  sleep,
  threadId,
  until,
  VALIDATION,
  windowScope,
} from './support/router.js';

const OPENING =
  'Some OpenUI fences you wrote have errors. Each line is `<tag> <identity> r<revision> <statement>: <code> <text>`. Fix a program by writing a fence with the same tag and identity: a patch of the named statements, or the whole program when you no longer see it.';

/** The line of a `trip` r1 report with `no-root` and no statement. */
const NO_ROOT = 'openui-lang trip r1 -: no-root has no root statement';

/** The line of `fence(_, identity)`. */
const fenceLine = (identity: string): string =>
  `openui-lang ${identity} r1 -: no-root has no root statement`;

type ReportInit = Partial<Omit<ReportErrorsRequest, '$typeName'>> & {
  readonly key: string;
};

/** A report as a window of `thread-1` sends it: `trip` r1, closed, no root. */
const reportOf = (input: ReportInit) => ({
  tag: 'openui-lang',
  identity: 'trip',
  revision: 1,
  state: 'closed',
  errors: [{ code: 'no-root' }],
  ...input,
});

/** A closed report of fence `identity` of `prompt`; each identity has its own turn. */
const fence = (prompt: string, identity: string): ReportInit => ({
  key: `${prompt}/${identity.charCodeAt(0)}/0`,
  identity,
});

const activated = async (t: test.TestContext): Promise<RouterWorld> => {
  const world = routerWorld();
  t.after(() => world.stop());
  await world.activate();
  return world;
};

const instructs = (world: RouterWorld): FakeCall[] =>
  world.callsOf('threads.instruct');

const promptOfInstruct = (call: FakeCall | undefined): string =>
  (call?.request as { prompt?: string } | undefined)?.prompt ?? '';

/** The lines of an instruct after its opening text. */
const linesOf = (call: FakeCall | undefined): string[] =>
  promptOfInstruct(call)
    .slice(OPENING.length)
    .split('\n')
    .filter((line) => line.trim() !== '');

void test('R1: a closed report after a prompt start is one validation instruct about 200 ms later, with the kernel’s text, made outside every call', async (t) => {
  const world = await activated(t);
  await world.promptStarted(threadId, 'p1');

  const sentAt = Date.now();
  await world
    .programs()
    .reportErrors(reportOf({ key: 'p1/1/0' }), { timeoutMs: 5000 });
  await until(() => instructs(world).length === 1, 'the validation instruct');
  const waited = Date.now() - sentAt;
  await sleep(300);

  assert.ok(waited >= 150, `the instruct came after ${waited} ms`);
  const [given] = instructs(world);
  assert.equal(instructs(world).length, 1);
  assert.deepEqual(given?.request, {
    id: threadId,
    prompt: `${OPENING}\n\n${NO_ROOT}`,
    reason: 'validation',
    promptId: 'p1',
  });
  assert.equal(given?.scope, undefined);
  assert.equal(given?.deadline, 0);
  assert.equal(given?.aborted, false);
});

void test('R2: unterminated reports wait for the next prompt start, which gives every waiting line in one instruct in the hook call’s scope', async (t) => {
  const world = await activated(t);
  await world.promptStarted(threadId, 'p1');

  await world
    .programs()
    .reportErrors(reportOf({ ...fence('p1', 'a'), state: 'unterminated' }));
  await world
    .programs()
    .reportErrors(reportOf({ ...fence('p1', 'b'), state: 'unterminated' }));
  await sleep(300);
  assert.equal(instructs(world).length, 0);

  await world.promptStarted(threadId, 'p2');

  assert.equal(instructs(world).length, 1);
  const [given] = instructs(world);
  assert.deepEqual(given?.scope, { projectId, threadId, promptId: 'p2' });
  assert.deepEqual(
    {
      promptId: (given?.request as { promptId?: string } | undefined)?.promptId,
      reason: (given?.request as { reason?: string } | undefined)?.reason,
    },
    { promptId: 'p2', reason: 'validation' },
  );
  assert.deepEqual(linesOf(given), [
    fenceLine('a'),
    'openui-lang a r1: cut off before the fence closed',
    fenceLine('b'),
    'openui-lang b r1: cut off before the fence closed',
  ]);
});

void test('R3: three immediate instructs per prompt; a validation start keeps the budget spent and a user start restores it', async (t) => {
  const world = await activated(t);
  await world.promptStarted(threadId, 'p1');

  for (const identity of ['a', 'b', 'c', 'd']) {
    await world.programs().reportErrors(reportOf(fence('p1', identity)));
    await sleep(300);
  }
  assert.equal(instructs(world).length, 3);
  assert.deepEqual(instructs(world).map(linesOf), [
    [fenceLine('a')],
    [fenceLine('b')],
    [fenceLine('c')],
  ]);

  // The held fourth line goes out at the validation start, which resets nothing.
  await world.promptStarted(threadId, 'v1', VALIDATION);
  assert.equal(instructs(world).length, 4);
  assert.deepEqual(linesOf(instructs(world)[3]), [fenceLine('d')]);
  await world.programs().reportErrors(reportOf(fence('v1', 'e')));
  await sleep(300);
  assert.equal(instructs(world).length, 4);

  // A user start gives the held line and restores the budget.
  await world.promptStarted(threadId, 'p2');
  await world.programs().reportErrors(reportOf(fence('p2', 'f')));
  await until(() => instructs(world).length === 6, 'the immediate instruct');

  assert.deepEqual(
    instructs(world).map(
      (call) => (call.request as { promptId?: string }).promptId,
    ),
    ['p1', 'p1', 'p1', 'v1', 'p2', 'p2'],
  );
  assert.deepEqual(linesOf(instructs(world)[4]), [fenceLine('e')]);
  assert.deepEqual(linesOf(instructs(world)[5]), [fenceLine('f')]);
});

void test('R4: ReportErrors without a Thread in scope is invalid_scope, a fractional revision is invalid_input, and a report for an unseen Thread answers and instructs nothing', async (t) => {
  const world = await activated(t);
  await world.promptStarted(threadId, 'p1');

  const unscoped = await failureOf(() =>
    world.programs({ projectId }).reportErrors(reportOf({ key: 'p1/1/0' })),
  );
  const fractional = await failureOf(() =>
    world.programs().reportErrors(reportOf({ key: 'p1/1/0', revision: 1.5 })),
  );
  assert.equal(unscoped.code, 'invalid_scope');
  assert.equal(fractional.code, 'invalid_input');
  await world
    .programs({ projectId, threadId: 'thread-9' })
    .reportErrors(reportOf({ key: 'p1/1/0' }));
  await sleep(300);

  assert.deepEqual(instructs(world), []);
});

void test('R5: deactivate after a closed report gives no instruct', async (t) => {
  const world = await activated(t);
  await world.promptStarted(threadId, 'p1');
  await world.programs(windowScope).reportErrors(reportOf({ key: 'p1/1/0' }));

  world.host.deactivate();
  await sleep(400);

  assert.deepEqual(instructs(world), []);
});

// The kernel suite `validation.test.ts` (B7, B8, B24–B28), moved to the router
// world in S68c (X3): the cases R1–R5 do not already cover. The router runs
// on real timers, so the 200 ms delay is waited for, not ticked.

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

interface MovedReport {
  readonly key: string;
  readonly tag?: string;
  readonly identity?: string;
  readonly revision?: number;
  readonly state?: string;
  readonly errors?: readonly {
    readonly code: string;
    readonly statementId?: string;
    readonly message?: string;
  }[];
}

/** `ReportErrors` as a window of `reportThreadId` calls it: `trip` r1, closed, no root. */
const report = async (
  world: RouterWorld,
  reportThreadId: string,
  input: MovedReport,
): Promise<void> => {
  const { errors = [{ code: 'no-root' }], ...rest } = input;
  await world.programs({ projectId, threadId: reportThreadId }).reportErrors({
    tag: 'openui-lang',
    identity: 'trip',
    revision: 1,
    state: 'closed',
    ...rest,
    errors: errors.map((error) => ({ ...error })),
  });
};

/** Whether the instruct was made in the hook call (it carries the prompt's scope). */
const inHook = (call: FakeCall | undefined): boolean =>
  call?.scope !== undefined;

const promptIdOf = (call: FakeCall | undefined): string | undefined =>
  (call?.request as { promptId?: string } | undefined)?.promptId;

const threadOf = (call: FakeCall): string | undefined =>
  (call.request as { id?: string }).id;

/** Waits for the 200 ms delay and what it started. */
const delay = (): Promise<void> => sleep(300);

const withThreads = async (
  t: test.TestContext,
  ids: readonly string[],
): Promise<RouterWorld> => {
  const world = routerWorld();
  t.after(() => world.stop());
  for (const id of ids) world.threads.set(id, { projectId });
  await world.activate();
  return world;
};

/** A promise the test settles, for an `instruct` in flight. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

void test('B7: a closed report is one validation instruct that steers its own prompt, once, and not again at the next prompt start', async (t) => {
  const world = await activated(t);

  await world.promptStarted(threadId, 'p1');
  await report(world, threadId, { key: 'p1/1/0' });
  // A second window sends the same report before the instruct.
  await report(world, threadId, { key: 'p1/1/0' });
  await until(() => instructs(world).length === 1, 'the instruct');
  await delay();

  assert.equal(instructs(world).length, 1);
  const [given] = instructs(world);
  assert.deepEqual(given?.request, {
    id: threadId,
    prompt: `${OPENING}\n\n${NO_ROOT}`,
    reason: 'validation',
    promptId: 'p1',
  });
  assert.equal(inHook(given), false);

  // And a window sends it again after the instruct.
  await report(world, threadId, { key: 'p1/1/0' });
  await sleep(1000);
  assert.equal(instructs(world).length, 1);

  await world.promptStarted(threadId, 'p2');
  assert.equal(instructs(world).length, 1);
});

void test('B7: two reports within 200 ms, of the two tags with one key, give one instruct with two lines prefixed by their tags', async (t) => {
  const world = await activated(t);

  await world.promptStarted(threadId, 'p1');
  const once = {
    key: 'p1/1/0',
    errors: [{ code: 'excess-args', statementId: 'b' }],
  };
  await report(world, threadId, once);
  await sleep(100);
  await report(world, threadId, once);
  await report(world, threadId, { ...once, tag: 'papercraft' });
  await until(() => instructs(world).length === 1, 'the instruct');
  await delay();

  assert.equal(instructs(world).length, 1);
  assert.deepEqual(linesOf(instructs(world)[0]), [
    'openui-lang trip r1 b: excess-args passes more arguments than the component takes; the extra ones were dropped',
    'papercraft trip r1 b: excess-args passes more arguments than the component takes; the extra ones were dropped',
  ]);
});

void test('B7: 60 errors give 50 lines and say how many more were not listed', async (t) => {
  const world = await activated(t);
  const errors = (from: number) =>
    Array.from({ length: 30 }, (_, index) => ({
      code: 'type-mismatch',
      statementId: `s${from + index}`,
    }));

  await world.promptStarted(threadId, 'p1');
  await report(world, threadId, { key: 'p1/1/0', errors: errors(0) });
  await report(world, threadId, { key: 'p1/1/1', errors: errors(30) });
  await until(() => instructs(world).length === 1, 'the instruct');

  const lines = linesOf(instructs(world)[0]);
  assert.equal(
    lines.filter((line) => line.startsWith('openui-lang trip r1 s')).length,
    50,
  );
  assert.equal(lines.at(-1), 'and 10 more errors were not listed');
});

void test('a message the shell computed is written instead of the fixed text', async (t) => {
  const world = await activated(t);

  await world.promptStarted(threadId, 'p1');
  await report(world, threadId, {
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
  await until(() => instructs(world).length === 1, 'the instruct');

  assert.deepEqual(linesOf(instructs(world)[0]), [
    'openui-lang _3 r2 root: runtime-error OpenUrl is disabled; write the link as text',
  ]);
});

void test("B24: after a 'queued' answer a second report waits for the queued prompt's start, which steers it with its own promptId", async (t) => {
  const world = await activated(t);
  world.threadsAnswers.instruct = () => ({
    steerResult: { status: 'queued', promptId: 'v1' },
  });

  await world.promptStarted(threadId, 'p1');
  await report(world, threadId, fence('p1', 'a'));
  await until(() => instructs(world).length === 1, 'the first instruct');
  assert.equal(promptIdOf(instructs(world)[0]), 'p1');

  delete world.threadsAnswers.instruct;
  await report(world, threadId, fence('p1', 'b'));
  await sleep(1000);
  assert.equal(instructs(world).length, 1);

  await world.promptStarted(threadId, 'v1', VALIDATION);
  assert.equal(instructs(world).length, 2);
  const second = instructs(world)[1];
  assert.equal(promptIdOf(second), 'v1');
  assert.equal(
    (second?.request as { reason?: string } | undefined)?.reason,
    'validation',
  );
  assert.equal(inHook(second), true);
  assert.deepEqual(linesOf(second), [fenceLine('b')]);
});

void test('B24: a closed report for the previous prompt after the next one started steers the prompt that runs now', async (t) => {
  const world = await activated(t);

  await world.promptStarted(threadId, 'p1');
  await world.promptStarted(threadId, 'p2');
  await report(world, threadId, { key: 'p1/2/0' });
  await until(() => instructs(world).length === 1, 'the instruct');
  await delay();

  assert.equal(instructs(world).length, 1);
  assert.equal(promptIdOf(instructs(world)[0]), 'p2');
  assert.deepEqual(linesOf(instructs(world)[0]), [NO_ROOT]);
});

void test('B25: an unterminated report gives no instruct after the delay; the next prompt start gives its lines and the cut-off line, once, also when a second window sends it again', async (t) => {
  const world = await activated(t);

  await world.promptStarted(threadId, 'p1');
  await world.promptStarted(threadId, 'p2');
  const late = {
    key: 'p1/3/0',
    state: 'unterminated',
    errors: [{ code: 'type-mismatch', statementId: 'tbl' }],
  };
  await report(world, threadId, late);
  await report(world, threadId, late);
  await sleep(1000);
  assert.equal(instructs(world).length, 0);

  await world.promptStarted(threadId, 'p3');
  assert.equal(instructs(world).length, 1);
  assert.equal(promptIdOf(instructs(world)[0]), 'p3');
  assert.equal(inHook(instructs(world)[0]), true);
  assert.deepEqual(linesOf(instructs(world)[0]), [
    'openui-lang trip r1 tbl: type-mismatch passes an argument of the wrong type',
    'openui-lang trip r1: cut off before the fence closed',
  ]);

  await world.promptStarted(threadId, 'p4');
  assert.equal(instructs(world).length, 1);
});

void test('B25: an unterminated report and a closed report held by a zero budget are given in one instruct at the next prompt start, the unterminated lines first', async (t) => {
  const world = await activated(t);

  await world.promptStarted(threadId, 'p1');
  for (const identity of ['a', 'b', 'c']) {
    await report(world, threadId, fence('p1', identity));
    await delay();
  }
  assert.equal(instructs(world).length, 3);

  await report(world, threadId, {
    key: 'p1/9/0',
    identity: 'u',
    state: 'unterminated',
    errors: [],
  });
  await report(world, threadId, fence('p1', 'd'));
  await sleep(1000);
  assert.equal(instructs(world).length, 3);

  await world.promptStarted(threadId, 'p2');
  assert.equal(instructs(world).length, 4);
  assert.equal(promptIdOf(instructs(world)[3]), 'p2');
  assert.deepEqual(linesOf(instructs(world)[3]), [
    'openui-lang u r1: cut off before the fence closed',
    fenceLine('d'),
  ]);
});

void test('B25: a report for the prompt before the previous one, and one before any prompt start, are dropped', async (t) => {
  const world = await withThreads(t, ['thread-1', 'thread-2']);

  await report(world, 'thread-2', { key: 'p0/1/0' });
  await world.promptStarted('thread-2', 'q1');

  await world.promptStarted('thread-1', 'p1');
  await world.promptStarted('thread-1', 'p2');
  await world.promptStarted('thread-1', 'p3');
  await report(world, 'thread-1', { key: 'p1/1/0' });
  await sleep(1000);
  await world.promptStarted('thread-1', 'p4');
  await world.promptStarted('thread-2', 'q2');

  assert.deepEqual(instructs(world), []);
});

for (const [name, answer] of [
  ["answering 'inactive'", () => ({ steerResult: { status: 'inactive' } })],
  [
    'rejecting',
    () => {
      throw new ContractError('unavailable', 'The runtime is gone.');
    },
  ],
] as const) {
  void test(`B27: with instruct ${name}, a closed report's lines are given once at the next prompt start, and the budget is unchanged`, async (t) => {
    const world = await activated(t);
    world.threadsAnswers.instruct = answer as never;

    await world.promptStarted(threadId, 'p1');
    await report(world, threadId, fence('p1', 'a'));
    await until(() => instructs(world).length === 1, 'the failed instruct');
    // Nothing is retried before the next prompt start.
    await sleep(1000);
    assert.equal(instructs(world).length, 1);

    // The failed instruct took nothing from the budget: three more go out.
    delete world.threadsAnswers.instruct;
    for (const identity of ['b', 'c', 'd']) {
      await report(world, threadId, fence('p1', identity));
      await delay();
    }
    assert.equal(instructs(world).length, 4);
    await report(world, threadId, fence('p1', 'e'));
    await sleep(1000);
    assert.equal(instructs(world).length, 4);

    await world.promptStarted(threadId, 'p2');
    assert.equal(instructs(world).length, 5);
    assert.equal(promptIdOf(instructs(world)[4]), 'p2');
    assert.deepEqual(linesOf(instructs(world)[4]), [
      fenceLine('a'),
      fenceLine('e'),
    ]);

    await world.promptStarted(threadId, 'p3');
    assert.equal(instructs(world).length, 5);
  });
}

void test('B27: a report that arrives while an instruct is in flight is given in a second instruct after the first settles', async (t) => {
  const world = await activated(t);
  const flight = deferred<unknown>();
  world.threadsAnswers.instruct = (() => flight.promise) as never;

  await world.promptStarted(threadId, 'p1');
  await report(world, threadId, fence('p1', 'a'));
  await until(() => instructs(world).length === 1, 'the first instruct');

  await report(world, threadId, fence('p1', 'b'));
  await sleep(1000);
  assert.equal(instructs(world).length, 1);

  delete world.threadsAnswers.instruct;
  flight.resolve({ steerResult: { status: 'steered', promptId: 'p1' } });
  await until(() => instructs(world).length === 2, 'the second instruct');

  assert.equal(promptIdOf(instructs(world)[1]), 'p1');
  assert.deepEqual(linesOf(instructs(world)[1]), [fenceLine('b')]);
});

void test('B28: after prompt starts in 1,001 Threads the Thread whose prompt started longest ago has no entry: its pending report gives no instruct, and a new report for it is dropped', async (t) => {
  const ids = Array.from({ length: 1001 }, (_, index) => `thread-${index}`);
  const world = await withThreads(t, ids);

  for (const id of ids.slice(0, 1000)) {
    await world.promptStarted(id, `${id}-p1`);
  }
  await report(world, 'thread-0', { key: 'thread-0-p1/1/0' });
  // thread-1000's start adds the 1,001st entry and evicts thread-0, timer and all.
  await world.promptStarted('thread-1000', 'thread-1000-p1');
  await delay();
  assert.equal(instructs(world).length, 0);

  await report(world, 'thread-0', { key: 'thread-0-p1/2/0' });
  await report(world, 'thread-1', { key: 'thread-1-p1/1/0' });
  await delay();
  // thread-0 has none: its start adds the 1,001st entry, gives nothing and
  // evicts thread-1, now the Thread whose prompt started longest ago.
  await world.promptStarted('thread-0', 'thread-0-p2');
  await world.promptStarted('thread-2', 'thread-2-p2');

  assert.deepEqual(instructs(world).map(threadOf), ['thread-1']);
});

void test('B28: a prompt start with no lines gives no instruct', async (t) => {
  const world = await activated(t);

  await world.promptStarted(threadId, 'p1');
  await world.promptStarted(threadId, 'p2');
  assert.equal(instructs(world).length, 0);

  await report(world, threadId, { key: 'p2/1/0' });
  await until(() => instructs(world).length === 1, 'the instruct');
  assert.equal(inHook(instructs(world)[0]), false);

  await world.promptStarted(threadId, 'p3');
  await world.promptStarted(threadId, 'p4');
  assert.equal(instructs(world).length, 1);
});

void test("B8: an error without message is written with its code's fixed text, for each of the 15 codes", async (t) => {
  const world = await activated(t);

  await world.promptStarted(threadId, 'p1');
  await report(world, threadId, {
    key: 'p1/1/0',
    errors: OPENUI_ERROR_CODES.map((code, index) => ({
      code,
      statementId: `s${index}`,
    })),
  });
  await until(() => instructs(world).length === 1, 'the instruct');

  assert.deepEqual(
    linesOf(instructs(world)[0]),
    OPENUI_ERROR_CODES.map(
      (code, index) =>
        `openui-lang trip r1 s${index}: ${code} ${FIXED_TEXT[code]}`,
    ),
  );
});

void test('B8: a bad statementId, an unknown code, a message over 300 characters and 51 errors are invalid_input', async (t) => {
  const world = await activated(t);
  await world.promptStarted(threadId, 'p1');

  const invalid: MovedReport['errors'][] = [
    [{ code: 'no-root', statementId: '1bad' }],
    [{ code: 'not-a-code' }],
    [{ code: 'no-root', message: 'm'.repeat(301) }],
    Array.from({ length: 51 }, (_, index) => ({
      code: 'no-root',
      statementId: `s${index}`,
    })),
  ];

  for (const errors of invalid) {
    const error = await failureOf(() =>
      report(world, threadId, {
        key: 'p1/1/0',
        ...(errors === undefined ? {} : { errors }),
      }),
    );
    assert.equal(error.code, 'invalid_input');
  }

  await sleep(1000);
  await world.promptStarted(threadId, 'p2');
  assert.deepEqual(instructs(world), []);
});
