// R1–R5 (phase 3, S56): `openui.programs/v1` and the `onPromptStartedHook`
// handler over the router keep the kernel's validation behaviour (D18, U50):
// a closed report is one `validation` instruct 200 ms later, made outside
// every call (D5); held lines go out at the next prompt start, in the hook's
// call; three immediate instructs per prompt the reader started.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReportErrorsRequest } from '../src/contracts/gen/doric/openui/programs/v1/programs_pb.js';
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
