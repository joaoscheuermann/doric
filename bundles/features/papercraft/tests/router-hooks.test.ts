// H1–H5 (phase 3, S57; D10, D28, D2): the `runtime.hooks/v1` handlers of
// `papercraft`'s host part over the router. A prompt start reads the Thread's
// rows after the cursor, appends `papercraft.cwd/v1` when the directory
// changed, gives the retained library instruct once the skill is loaded and
// its text changed, and starts the library job without awaiting it; a move
// does the first steps only with a `promptId`; `Handle` never rejects. The
// library job a hook starts runs outside the hook's call.

import assert from 'node:assert/strict';
import test from 'node:test';

import { create, fromJson, type JsonValue, toJson } from '@bufbuild/protobuf';
import { anyPack } from '@bufbuild/protobuf/wkt';
import { ContractError } from 'bundle/contracts';
import { HookHandlerServiceHandleResponseSchema } from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { OnPromptStartedHookInputSchema } from 'runtime/contracts/gen/doric/runtime/hooks/v1/hooks_pb.js';
import { ThreadEventSchema } from 'runtime/contracts/gen/doric/runtime/v2/runtime_pb.js';

import { instructText } from '../src/host/library.js';
import {
  builtLibrary,
  type FakeCall,
  type JobInput,
  projectId,
  type RouterWorld,
  routerWorld,
  type ScriptedSandbox,
  scriptedSandbox,
  sleep,
  threadId,
  until,
} from './support/router.js';

const APP = '/workspace/app';

const activated = async (t: test.TestContext): Promise<RouterWorld> => {
  const world = routerWorld();
  t.after(() => world.stop());
  await world.activate();
  return world;
};

const promptOf = (call: FakeCall | undefined): string =>
  (call?.request as { prompt?: string } | undefined)?.prompt ?? '';

/** The text D28 gives for `APP`'s `builtLibrary` answer, with no earlier root. */
const readyText = (): string => {
  const output = builtLibrary(APP, 'h2');
  const text = instructText(
    { root: APP },
    {
      root: APP,
      components: 'components' in output ? output.components : [],
    },
    undefined,
  );
  assert.ok(text !== undefined);
  return text.text;
};

void test('H1: a prompt start on an empty log reads from 0, appends one cwd row under the prompt’s scope and answers {}; the same cwd again appends nothing', async (t) => {
  const world = await activated(t);

  const answer = await world
    .hooks({ projectId, threadId, promptId: 'p1' })
    .handle({
      contract: 'runtime.hooks/v1',
      hook: 'onPromptStartedHook',
      input: anyPack(
        OnPromptStartedHookInputSchema,
        create(OnPromptStartedHookInputSchema, {
          projectId,
          threadId,
          promptId: 'p1',
          source: { kind: { case: 'user', value: {} } },
          cwd: '/w/app',
        }),
      ),
    });
  await world.promptStarted('p2', '/w/app');

  assert.deepEqual(toJson(HookHandlerServiceHandleResponseSchema, answer), {});
  assert.deepEqual(world.callsOf('threads.threadEvents')[0]?.request, {
    id: threadId,
    afterSequence: 0,
  });
  const appends = world.callsOf('events.append');
  assert.equal(appends.length, 1);
  assert.deepEqual(appends[0]?.request, {
    type: 'papercraft.cwd/v1',
    payload: { cwd: '/w/app' },
  });
  assert.deepEqual(appends[0]?.scope, { projectId, threadId, promptId: 'p1' });
  assert.deepEqual(world.cwds(), ['/w/app']);
});

void test('H2: once the skill is loaded the library answer is one retained instruct; the same text is not given again; an inactive answer gives it again at the next hook', async (t) => {
  const world = await activated(t);
  world.lease.status = 'ready';
  world.lease.sandbox = scriptedSandbox(() => builtLibrary(APP, 'h2'));
  world.loadSkill('p0');

  await world.promptStarted('p1', APP);
  const library = await world
    .programs()
    .library({ turnSequence: world.log.length + 1 });
  assert.equal(library.status.case, 'ready');
  assert.equal(world.callsOf('threads.instruct').length, 0);

  world.threadsAnswers.instruct = () => ({
    steerResult: { status: 'inactive' },
  });
  await world.promptStarted('p2', APP);
  delete world.threadsAnswers.instruct;
  await world.promptStarted('p3', APP);
  await world.promptStarted('p4', APP);

  const instructs = world.callsOf('threads.instruct');
  assert.equal(instructs.length, 2);
  assert.deepEqual(instructs[0]?.request, {
    id: threadId,
    prompt: readyText(),
    reason: 'library',
    promptId: 'p2',
    retain: true,
  });
  assert.equal(promptOf(instructs[1]), readyText());
  assert.equal(
    (instructs[1]?.request as { promptId?: string } | undefined)?.promptId,
    'p3',
  );
});

void test('H3: a move without a promptId answers {} and calls nothing; with one it appends the new cwd and calls no lease', async (t) => {
  const world = await activated(t);

  await world.cwdChanged('/w/other', '/w/app');
  assert.deepEqual(
    world.calls.map(({ method }) => method),
    [],
  );

  await world.cwdChanged('/w/other', '/w/app', 'p1');

  assert.deepEqual(world.cwds(), ['/w/other']);
  assert.deepEqual(world.callsOf('events.append')[0]?.scope, {
    projectId,
    threadId,
    promptId: 'p1',
  });
  assert.equal(
    world.calls.filter(({ method }) => method.startsWith('lease.')).length,
    0,
  );
});

void test('H4: a failing ThreadEvents ends the hook: Handle answers and nothing is appended', async (t) => {
  const world = await activated(t);
  world.failures.threadEvents = new ContractError(
    'unavailable',
    'The log is closed.',
  );

  await world.promptStarted('p1', '/w/app');

  assert.equal(world.callsOf('threads.threadEvents').length, 1);
  assert.deepEqual(world.callsOf('events.append'), []);
});

void test('H5: the library job a hook starts calls Describe, Exec and Content after Handle answered, with no deadline and an unaborted signal', async (t) => {
  const world = await activated(t);
  world.files = {
    'src/base.css': '.base { color: blue; }\n',
  };
  world.lease.status = 'ready';
  world.lease.sandbox = scriptedSandbox(() =>
    builtLibrary(APP, 'h5', {
      globalCss: ['src/index.css'],
      styles: {
        'src/index.css': '@import "./base.css";\n.app { color: red; }\n',
      },
    }),
  );
  world.loadSkill('p0');

  await world.hooks({ projectId, threadId, promptId: 'p1' }).handle(
    {
      contract: 'runtime.hooks/v1',
      hook: 'onPromptStartedHook',
      input: anyPack(
        OnPromptStartedHookInputSchema,
        create(OnPromptStartedHookInputSchema, {
          projectId,
          threadId,
          promptId: 'p1',
          source: { kind: { case: 'user', value: {} } },
          cwd: APP,
        }),
      ),
    },
    { timeoutMs: 5000 },
  );
  const answeredAt = world.calls.length;
  await until(
    () => world.callsOf('files.content').length > 0,
    'the library job’s Content read',
  );

  const job = world.calls.filter(
    ({ method }) => method.startsWith('lease.') || method === 'files.content',
  );
  assert.ok(world.callsOf('lease.describe').length > 0);
  assert.ok(world.callsOf('lease.exec').length > 0);
  for (const call of job) {
    assert.ok(
      world.calls.indexOf(call) >= answeredAt,
      `${call.method} came before Handle answered`,
    );
    assert.equal(call.deadline, 0, call.method);
    assert.equal(call.aborted, false, call.method);
    assert.deepEqual(call.scope, { projectId }, call.method);
  }
});

void test('S62b 15: a log ThreadEvents cuts into pages of two is applied whole before the cursor moves to lastSequence', async (t) => {
  const world = await activated(t);
  for (let index = 0; index < 4; index += 1)
    world.row('p0', 'text.delta', { delta: `part ${index}` });
  world.row('p0', 'papercraft.cwd/v1', { cwd: '/w/app' });
  world.threadsAnswers.threadEvents = (request) => {
    const rows = world.log.filter((row) => row.threadId === request.id);
    return {
      threadEventLog: {
        events: rows
          .filter((row) => row.sequence > request.afterSequence)
          .slice(0, 2)
          .map((row) =>
            fromJson(ThreadEventSchema, row as unknown as JsonValue),
          ),
        lastSequence: rows.at(-1)?.sequence ?? 0,
      },
    };
  };

  await world.promptStarted('p1', '/w/app');

  assert.deepEqual(
    world.callsOf('threads.threadEvents').map(({ request }) => request),
    [
      { id: threadId, afterSequence: 0 },
      { id: threadId, afterSequence: 2 },
      { id: threadId, afterSequence: 4 },
    ],
  );
  // The cwd row at sequence 5 was applied: the same cwd appends nothing.
  assert.deepEqual(world.callsOf('events.append'), []);
  assert.deepEqual(world.cwds(), ['/w/app']);
});

// The kernel suite `library.test.ts` (PC13: the cwd event and the library
// instruct), moved to the router world in S68c (X3): the cases H1–H5 do not
// already cover. The runner's library answers are scripted by the job's `cwd`
// (the sandbox is the boundary).

const WEB = '/workspace/web';

/** A runner's `built` answer for a library at `root` with the one component `name`. */
const libraryOf = (root: string, name: string): unknown =>
  builtLibrary(root, name, {
    components: [
      {
        name,
        description: `The ${name}.`,
        signature: `${name}(label: string)`,
        file: `.doric/papercraft/schemas/${name}.tsx`,
      },
    ],
    manifest: { [`${root}/.doric/papercraft/schemas/`]: name },
  });

/** A ready lease whose runner answers library jobs by `cwd` (`none` when absent). */
const leased = (
  world: RouterWorld,
  answers: Readonly<Record<string, unknown>>,
): ScriptedSandbox => {
  const sandbox = scriptedSandbox(
    (input: JobInput) => answers[String(input.cwd)] ?? { status: 'none' },
  );
  world.lease.status = 'ready';
  world.lease.sandbox = sandbox;
  return sandbox;
};

const libraryJobs = (sandbox: ScriptedSandbox): string[] =>
  sandbox.jobs
    .filter((input) => input.kind === 'library')
    .map((input) => String(input.cwd));

const libraryInstructs = (world: RouterWorld): FakeCall[] =>
  world
    .callsOf('threads.instruct')
    .filter(
      (call) => (call.request as { reason?: string }).reason === 'library',
    );

const promptIdOf = (call: FakeCall): string | undefined =>
  (call.request as { promptId?: string }).promptId;

/** The cwd rows, as `[promptId, cwd]`. */
const cwdRows = (world: RouterWorld): [string, string][] =>
  world.log
    .filter(({ type }) => type === 'papercraft.cwd/v1')
    .map(({ promptId, event }) => [promptId, String(event.cwd)]);

/** `Library` for the fence after the last row: the bound directory's answer, once its job ran. */
const libraryNow = (world: RouterWorld) =>
  world
    .programs()
    .library({ turnSequence: (world.log.at(-1)?.sequence ?? 0) + 1 });

void test('PC13: a prompt start appends the cwd row, scoped with the hook ids, only when the directory changed', async (t) => {
  const world = await activated(t);

  await world.promptStarted('p1', APP);
  await world.promptStarted('p2', APP);
  await world.promptStarted('p3', WEB);

  assert.deepEqual(cwdRows(world), [
    ['p1', APP],
    ['p3', WEB],
  ]);
  assert.deepEqual(world.callsOf('events.append')[0]?.scope, {
    projectId,
    threadId,
    promptId: 'p1',
  });
});

void test('PC13: a move during a prompt appends before the hook returns; one without a promptId appends nothing, and the next prompt start appends', async (t) => {
  const world = await activated(t);

  await world.promptStarted('p1', APP);
  await world.cwdChanged(WEB, APP, 'p1');
  assert.deepEqual(world.cwds(), [APP, WEB]);

  await world.cwdChanged(APP, WEB);
  assert.equal(world.cwds().length, 2);

  await world.promptStarted('p2', APP);
  assert.deepEqual(cwdRows(world), [
    ['p1', APP],
    ['p1', WEB],
    ['p2', APP],
  ]);
});

void test('PC13: a rejected append leaves the last cwd: the next hook appends again', async (t) => {
  const world = await activated(t);
  world.failures.append = new ContractError(
    'unavailable',
    'the sink is closed',
  );

  await world.promptStarted('p1', APP);
  assert.deepEqual(cwdRows(world), []);

  delete world.failures.append;
  await world.promptStarted('p2', APP);
  assert.deepEqual(cwdRows(world), [['p2', APP]]);
});

void test('PC13: no library instruct before the skill load; then one retained instruct with the prompt id, and none for the same library at the next hook', async (t) => {
  const world = await activated(t);
  leased(world, { [APP]: libraryOf(APP, 'AppButton') });

  await world.promptStarted('p1', APP);
  const answer = await libraryNow(world);
  assert.equal(answer.status.case, 'ready');
  await world.promptStarted('p2', APP);
  assert.deepEqual(libraryInstructs(world), []);

  world.loadSkill('p2');
  await world.promptStarted('p3', APP);

  const given = libraryInstructs(world);
  assert.equal(given.length, 1);
  const request = given[0]?.request as {
    id?: string;
    promptId?: string;
    retain?: boolean;
    prompt?: string;
  };
  assert.equal(request.id, threadId);
  assert.equal(request.promptId, 'p3');
  assert.equal(request.retain, true);
  assert.match(
    request.prompt ?? '',
    /^Repository library at \/workspace\/app: 1 components?\./u,
  );
  assert.ok(
    (request.prompt ?? '')
      .split('\n')
      .includes('AppButton(label: string) — The AppButton.'),
    request.prompt,
  );

  // The same library at the next hook: no instruct.
  await sleep(200);
  await world.promptStarted('p4', APP);
  assert.equal(libraryInstructs(world).length, 1);
});

void test('PC13: a prompt start with the skill loaded starts a library job; the next hook gives its instruct', async (t) => {
  const world = await activated(t);
  const sandbox = leased(world, { [APP]: libraryOf(APP, 'AppButton') });

  await world.promptStarted('p1', APP);
  world.loadSkill('p1');
  await world.promptStarted('p2', APP);
  assert.deepEqual(libraryInstructs(world), []);

  await until(() => libraryJobs(sandbox).length === 1, 'the library job');
  // Its answer reaches the memo once the job's output is read back.
  await sleep(200);
  assert.deepEqual(libraryJobs(sandbox), [APP]);

  await world.promptStarted('p3', APP);
  assert.deepEqual(libraryInstructs(world).map(promptIdOf), ['p3']);
});

void test('PC13: no library job from a prompt start without the skill load, nor from a move; a move without a promptId gives no instruct', async (t) => {
  const world = await activated(t);
  const sandbox = leased(world, {
    [APP]: libraryOf(APP, 'AppButton'),
    [WEB]: libraryOf(WEB, 'WebCard'),
  });

  await world.promptStarted('p1', APP);
  await sleep(200);
  assert.deepEqual(libraryJobs(sandbox), []);

  world.loadSkill('p1');
  await world.cwdChanged(WEB, APP, 'p1');
  await sleep(200);
  assert.deepEqual(libraryJobs(sandbox), []);

  await libraryNow(world);
  await world.cwdChanged(APP, WEB);
  assert.deepEqual(libraryInstructs(world), []);
});

void test('PC13: a move during a prompt gives the new directory’s instruct; leaving a library gives the none text once', async (t) => {
  const world = await activated(t);
  leased(world, { [APP]: libraryOf(APP, 'AppButton') });
  world.loadSkill('p0');

  // The Thread was in WEB before: its answer (none) is known.
  await world.promptStarted('p1', WEB);
  assert.equal((await libraryNow(world)).status.case, 'none');
  await world.promptStarted('p2', APP);
  assert.equal((await libraryNow(world)).status.case, 'ready');
  await world.promptStarted('p3', APP);
  assert.equal(libraryInstructs(world).length, 1);

  await world.cwdChanged(WEB, APP, 'p3');
  await world.promptStarted('p4', WEB);

  const given = libraryInstructs(world);
  assert.deepEqual(
    given.slice(1).map((call) => (call.request as { prompt?: string }).prompt),
    ['No repository library here; use built-in components only.'],
  );
  assert.equal(given[1] === undefined ? undefined : promptIdOf(given[1]), 'p3');
});

void test('PC13: a rejected library instruct records nothing: the next hook gives it again', async (t) => {
  const world = await activated(t);
  leased(world, { [APP]: libraryOf(APP, 'AppButton') });

  await world.promptStarted('p1', APP);
  world.loadSkill('p1');
  await libraryNow(world);
  world.threadsAnswers.instruct = () => {
    throw new ContractError('unavailable', 'the Thread is closing');
  };
  await world.promptStarted('p2', APP);
  delete world.threadsAnswers.instruct;
  await world.promptStarted('p3', APP);

  const given = libraryInstructs(world);
  assert.deepEqual(given.map(promptIdOf), ['p2', 'p3']);
  assert.equal(
    (given[1]?.request as { prompt?: string } | undefined)?.prompt,
    (given[0]?.request as { prompt?: string } | undefined)?.prompt,
  );
});

void test('PC13: a rewind marker gives the instruct again; a rewind that removes the load stops it until a later load', async (t) => {
  const world = await activated(t);
  leased(world, { [APP]: libraryOf(APP, 'AppButton') });

  await world.promptStarted('p1', APP);
  world.loadSkill('p1');
  await libraryNow(world);
  await world.promptStarted('p2', APP);
  world.row('p2', 'text.delta', { text: 'hello' });
  assert.equal(libraryInstructs(world).length, 1);

  // A rewind of p2 keeps the load (in p1).
  world.rewind('p2');
  await world.promptStarted('p3', APP);
  assert.equal(libraryInstructs(world).length, 2);

  // A rewind of p1 removes the load.
  world.rewind('p1');
  await world.promptStarted('p4', APP);
  assert.equal(libraryInstructs(world).length, 2);

  world.loadSkill('p4');
  await world.promptStarted('p5', APP);
  assert.deepEqual(libraryInstructs(world).map(promptIdOf), ['p2', 'p3', 'p5']);
});

void test('PC13: a failed build and a missing cwd give their texts', async (t) => {
  const world = await activated(t);
  leased(world, {
    [APP]: {
      status: 'failed',
      root: APP,
      error: 'AppButton.tsx: Unexpected token',
      manifest: {},
    },
    [WEB]: {
      status: 'failed',
      error: `The working directory ${WEB} no longer exists`,
      manifest: {},
    },
  });
  world.loadSkill('p0');

  await world.promptStarted('p1', WEB);
  await libraryNow(world);
  await world.promptStarted('p2', APP);
  await libraryNow(world);
  await world.promptStarted('p3', APP);
  await world.cwdChanged(WEB, APP, 'p3');

  assert.deepEqual(
    libraryInstructs(world).map(
      (call) => (call.request as { prompt?: string }).prompt,
    ),
    [
      `The repository library at ${APP} did not compile: AppButton.tsx: Unexpected token`,
      `The repository library could not be checked: The working directory ${WEB} no longer exists`,
    ],
  );
});
