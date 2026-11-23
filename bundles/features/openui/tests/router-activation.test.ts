// A1–A5 (phase 3, S56): `openui`'s host part as a process activates over the
// router as `main.ts` runs it. `activate` reads the skill text as an asset,
// tracks the `openui.answered/v1` event type (no sink), the
// `onPromptStartedHook` handler and the `openui` skill, in that order, and
// makes no `runtime.threads/v1` call; its services answer `unavailable` until
// it resolved.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { create } from '@bufbuild/protobuf';
import { anyPack } from '@bufbuild/protobuf/wkt';
import { ContractError } from 'bundle/contracts';
import { OnPromptStartedHookInputSchema } from 'runtime/contracts/gen/doric/runtime/hooks/v1/hooks_pb.js';

import {
  bundleRoot,
  failureOf,
  type RouterWorld,
  routerWorld,
  windowScope,
} from './support/router.js';

const SKILL_PATH = 'src/host/skills/openui.md';

const DESCRIPTION =
  'Answers with UI the app draws while you write: OpenUI Lang programs in openui-lang fences, with forms, tables, charts and question forms for the reader. Load it before writing an openui-lang or papercraft fence, or before asking the reader to decide something.';

const questions = {
  questions: [
    {
      id: 'db',
      question: 'Which database?',
      options: [{ label: 'Postgres' }, { label: 'SQLite' }],
    },
  ],
};

/** The Doric code of a failed client call. */
const codeOf = async (call: () => Promise<unknown>): Promise<string> =>
  (await failureOf(call)).code;

const stopAfter = (t: test.TestContext, world: RouterWorld): void => {
  t.after(() => world.stop());
};

void test('A1: activate registers the answered event type, then the onPromptStartedHook handler, then the openui skill, and calls no runtime.threads/v1 method', async (t) => {
  const world = routerWorld();
  stopAfter(t, world);
  const text = await readFile(join(bundleRoot, SKILL_PATH), 'utf8');

  await world.activate();

  assert.deepEqual(world.timeline, [
    'events.register',
    'hooks.register',
    'skills.register',
  ]);
  assert.deepEqual(world.eventRegisters, [
    {
      type: 'openui.answered/v1',
      messageType: 'doric.openui.answered.v1.OpenuiAnswered',
    },
  ]);
  assert.deepEqual(world.hookRegisters, [
    { contract: 'runtime.hooks/v1', hook: 'onPromptStartedHook' },
  ]);
  assert.deepEqual(world.skillRegisters, [
    {
      skill: { name: 'openui', description: DESCRIPTION, body: text.trim() },
      options: { order: 3400, alwaysAvailable: false },
    },
  ]);
  assert.deepEqual(world.assetReads, [SKILL_PATH]);
  assert.deepEqual(world.calls, []);
});

void test('A2: with a bundle directory whose manifest lists src/host/skills/*.md, activate reads the skill through context.assets', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'openui-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(
    await readFile(join(bundleRoot, 'manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({ ...manifest, host: { assets: ['src/host/skills/*.md'] } }),
  );
  await mkdir(join(directory, 'src', 'host', 'skills'), { recursive: true });
  await writeFile(
    join(directory, SKILL_PATH),
    '\n  The staged skill text.\n\n',
  );
  const world = routerWorld({ readAsset: 'context', bundleDir: directory });
  stopAfter(t, world);

  await world.activate();

  assert.equal(world.skillRegisters.length, 1);
  assert.deepEqual(
    (world.skillRegisters[0] as { skill: { body: string } }).skill.body,
    'The staged skill text.',
  );
});

void test('A3: with the bundle’s own directory and no readAsset, activate rejects naming the skill path as not listed in host.assets', async (t) => {
  const world = routerWorld({ readAsset: 'context', bundleDir: bundleRoot });
  stopAfter(t, world);

  await assert.rejects(world.activate(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /src\/host\/skills\/openui\.md/u);
    assert.match(error.message, /not listed in host\.assets/u);
    return true;
  });
  assert.deepEqual(world.skillRegisters, []);
});

void test('A4: a refused skills/v1.Register rejects activate with duplicate_skill, and Status then fails unavailable', async (t) => {
  const world = routerWorld();
  stopAfter(t, world);
  world.failures.registerSkill = new ContractError(
    'duplicate_skill',
    'A skill named openui is registered.',
  );

  await assert.rejects(world.activate(), { code: 'duplicate_skill' });

  assert.equal(
    await codeOf(() => world.questions().status({ promptId: 'q1', questions })),
    'unavailable',
  );
  assert.deepEqual(world.calls, []);
});

void test('A5: before activate every method fails unavailable', async (t) => {
  const world = routerWorld();
  stopAfter(t, world);
  await world.serveWithoutActivate();

  const codes = [
    await codeOf(() =>
      world.programs().reportErrors({
        tag: 'openui-lang',
        key: 'p1/1/0',
        identity: 'trip',
        revision: 1,
        state: 'closed',
        errors: [{ code: 'no-root' }],
      }),
    ),
    await codeOf(() => world.questions().status({ promptId: 'q1', questions })),
    await codeOf(() =>
      world.questions().answer({
        promptId: 'q1',
        questions,
        answers: [{ id: 'db', options: ['Postgres'] }],
      }),
    ),
    await codeOf(() =>
      world.hooks({ ...windowScope, promptId: 'p1' }).handle({
        contract: 'runtime.hooks/v1',
        hook: 'onPromptStartedHook',
        input: anyPack(
          OnPromptStartedHookInputSchema,
          create(OnPromptStartedHookInputSchema, {
            ...windowScope,
            promptId: 'p1',
            source: { kind: { case: 'user', value: {} } },
            cwd: '/workspace',
          }),
        ),
      }),
    ),
  ];

  // The hook handler is registered by activate: before it the SDK knows no such hook.
  assert.deepEqual(codes, [
    'unavailable',
    'unavailable',
    'unavailable',
    'not_found',
  ]);
  assert.deepEqual(world.calls, []);
});
