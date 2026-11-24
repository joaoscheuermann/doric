// H1–H5 (phase 3, S57; D10, D28, D2): the `runtime.hooks/v1` handlers of
// `papercraft`'s host part over the router. A prompt start reads the Thread's
// rows after the cursor, appends `papercraft.cwd/v1` when the directory
// changed, gives the retained library instruct once the skill is loaded and
// its text changed, and starts the library job without awaiting it; a move
// does the first steps only with a `promptId`; `Handle` never rejects. The
// library job a hook starts runs outside the hook's call.

import assert from 'node:assert/strict';
import test from 'node:test';

import { create, toJson } from '@bufbuild/protobuf';
import { anyPack } from '@bufbuild/protobuf/wkt';
import { ContractError } from 'bundle/contracts';
import { HookHandlerServiceHandleResponseSchema } from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import { OnPromptStartedHookInputSchema } from 'runtime/contracts/gen/doric/runtime/hooks/v1/hooks_pb.js';

import { instructText } from '../src/host/library.js';
import {
  builtLibrary,
  type FakeCall,
  projectId,
  type RouterWorld,
  routerWorld,
  scriptedSandbox,
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
