// B7 and B8 (openui.md D18): the errors windows report through
// `openui.programs/v1` reach the agent at the start of the Thread's next
// prompt, as one `validation` instruct, through a fake `runtime.threads/v1`
// and the `runtime.hooks/v1.onPromptStartedHook` the host registers.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

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

const worlds: HostWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.deactivate();
});

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

test("a report for the entry's prompt is one validation instruct at the next prompt start, and not again", async () => {
  const world = await start();

  await world.promptStarted('thread-1', 'p1');
  await report(world, 'thread-1', { key: 'p1/1/0' });
  assert.equal(world.instructs.length, 0);

  await world.promptStarted('thread-1', 'p2');

  assert.equal(world.instructs.length, 1);
  const [given] = world.instructs;
  assert.equal(given?.input.id, 'thread-1');
  assert.equal(given?.input.reason, 'validation');
  assert.equal(given?.input.promptId, 'p2');
  assert.notEqual(given?.input.retain, true);
  assert.ok(given?.input.prompt.startsWith(OPENING));
  assert.deepEqual(linesOf(given?.input.prompt ?? ''), [
    'openui-lang trip r1 -: no-root has no root statement',
  ]);

  await world.promptStarted('thread-1', 'p3');
  assert.equal(world.instructs.length, 1);
});

test('a report for the previous prompt that arrives after the next started is delivered once at the prompt after that', async () => {
  const world = await start();

  await world.promptStarted('thread-1', 'p1');
  await world.promptStarted('thread-1', 'p2');
  const late = {
    key: 'p1/3/0',
    state: 'unterminated' as const,
    errors: [{ code: 'type-mismatch' as const, statementId: 'tbl' }],
  };
  await report(world, 'thread-1', late);
  // A second window sends the same report again.
  await report(world, 'thread-1', late);

  await world.promptStarted('thread-1', 'p3');
  assert.equal(world.instructs.length, 1);
  assert.equal(world.instructs[0]?.input.promptId, 'p3');
  assert.deepEqual(linesOf(world.instructs[0]?.input.prompt ?? ''), [
    'openui-lang trip r1 tbl: type-mismatch passes an argument of the wrong type',
    'openui-lang trip r1: cut off before the fence closed',
  ]);

  await world.promptStarted('thread-1', 'p4');
  assert.equal(world.instructs.length, 1);
});

test('a report for the prompt before the previous one, and one before any prompt start, are dropped', async () => {
  const world = await start(['thread-1', 'thread-2']);

  await report(world, 'thread-2', { key: 'p0/1/0' });
  await world.promptStarted('thread-2', 'q1');

  await world.promptStarted('thread-1', 'p1');
  await world.promptStarted('thread-1', 'p2');
  await world.promptStarted('thread-1', 'p3');
  await report(world, 'thread-1', { key: 'p1/1/0' });
  await world.promptStarted('thread-1', 'p4');

  assert.deepEqual(world.instructs, []);
});

test('two reports of one error give one line; the two tags with one key give two lines', async () => {
  const world = await start();

  await world.promptStarted('thread-1', 'p1');
  const once = {
    key: 'p1/1/0',
    errors: [{ code: 'excess-args' as const, statementId: 'b' }],
  };
  await report(world, 'thread-1', once);
  await report(world, 'thread-1', once);
  await report(world, 'thread-1', { ...once, tag: 'papercraft' });
  await world.promptStarted('thread-1', 'p2');

  assert.deepEqual(linesOf(world.instructs[0]?.input.prompt ?? ''), [
    'openui-lang trip r1 b: excess-args passes more arguments than the component takes; the extra ones were dropped',
    'papercraft trip r1 b: excess-args passes more arguments than the component takes; the extra ones were dropped',
  ]);
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
  await world.promptStarted('thread-1', 'p2');

  assert.deepEqual(linesOf(world.instructs[0]?.input.prompt ?? ''), [
    'openui-lang _3 r2 root: runtime-error OpenUrl is disabled; write the link as text',
  ]);
});

test('60 errors give 50 lines and say how many more were not listed', async () => {
  const world = await start();
  const errors = (from: number): ReportedError[] =>
    Array.from({ length: 30 }, (_, index) => ({
      code: 'type-mismatch',
      statementId: `s${from + index}`,
    }));

  await world.promptStarted('thread-1', 'p1');
  await report(world, 'thread-1', { key: 'p1/1/0', errors: errors(0) });
  await report(world, 'thread-1', { key: 'p1/1/1', errors: errors(30) });
  await world.promptStarted('thread-1', 'p2');

  const prompt = world.instructs[0]?.input.prompt ?? '';
  const lines = linesOf(prompt);
  assert.equal(
    lines.filter((line) => line.startsWith('openui-lang trip r1 s')).length,
    50,
  );
  assert.equal(lines.at(-1), 'and 10 more errors were not listed');
});

test('a prompt start with no lines gives no instruct, and no instruct is given outside the hook', async () => {
  const world = await start();

  await world.promptStarted('thread-1', 'p1');
  await world.promptStarted('thread-1', 'p2');
  assert.equal(world.instructs.length, 0);

  await report(world, 'thread-1', { key: 'p2/1/0' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(world.instructs.length, 0);

  await world.promptStarted('thread-1', 'p3');
  assert.equal(world.instructs.length, 1);
  assert.ok(world.instructs.every((given) => given.inHook));
});

test('after prompt starts in 1,001 Threads the first one has no entry and its report is dropped; a new entry evicts the Thread whose prompt started longest ago, with its pending lines', async () => {
  const ids = Array.from({ length: 1001 }, (_, index) => `thread-${index}`);
  const world = await start(ids);

  // thread-1000's start adds the 1,001st entry and evicts thread-0.
  for (const id of ids) await world.promptStarted(id, `${id}-p1`);
  await report(world, 'thread-0', { key: 'thread-0-p1/1/0' });
  await report(world, 'thread-1', { key: 'thread-1-p1/1/0' });
  await report(world, 'thread-2', { key: 'thread-2-p1/1/0' });
  // thread-1 has an entry: its start adds none and delivers its lines.
  await world.promptStarted('thread-1', 'thread-1-p2');
  // thread-0 has none: its start adds the 1,001st entry and evicts
  // thread-2, now the Thread whose prompt started longest ago.
  await world.promptStarted('thread-0', 'thread-0-p2');
  await world.promptStarted('thread-2', 'thread-2-p2');

  assert.deepEqual(
    world.instructs.map(({ input }) => input.id),
    ['thread-1'],
  );
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
  await world.promptStarted('thread-1', 'p2');

  assert.deepEqual(
    linesOf(world.instructs[0]?.input.prompt ?? ''),
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

  await world.promptStarted('thread-1', 'p2');
  assert.deepEqual(world.instructs, []);
});
