// A1–A5 (phase 3, S57): `papercraft`'s host part as a process activates over
// the router as `main.ts` runs it. `activate` reads the skill text as an asset,
// tracks the `papercraft.cwd/v1` event type (no sink), the
// `onPromptStartedHook` and `onThreadCwdChangedHook` handlers and the
// `papercraft` skill, in that order, and makes no `files/v1`,
// `runtime.lease/v1` or `runtime.threads/v1` call and reads no runner; a
// refused skill leaves it out (PC33); its service answers `unavailable` until
// it resolved. The runner is an asset too, read at the first job.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { create } from '@bufbuild/protobuf';
import { anyPack } from '@bufbuild/protobuf/wkt';
import { ContractError } from 'bundle/contracts';
import { OnPromptStartedHookInputSchema } from 'runtime/contracts/gen/doric/runtime/hooks/v1/hooks_pb.js';

import { moduleNative } from '../src/host/native.js';
import {
  bundleRoot,
  failureOf,
  projectId,
  type RouterWorld,
  RUNNER_PATH,
  routerWorld,
  SKILL_PATH,
  scriptedSandbox,
  threadId,
  windowScope,
} from './support/router.js';

const DESCRIPTION =
  'Previews repository components and exports live in the conversation: OpenUI Lang programs in papercraft fences, with the repository library, Export and pinned comments. Load it before writing a papercraft fence.';

/** The Doric code of a failed client call. */
const codeOf = async (call: () => Promise<unknown>): Promise<string> =>
  (await failureOf(call)).code;

const stopAfter = (t: test.TestContext, world: RouterWorld): void => {
  t.after(() => world.stop());
};

void test('A1: activate registers the cwd event type, the two hook handlers and the papercraft skill, in that order, and calls no Files, Lease or Threads method nor reads the runner', async (t) => {
  const world = routerWorld();
  stopAfter(t, world);
  const text = await readFile(join(bundleRoot, SKILL_PATH), 'utf8');

  await world.activate();

  assert.deepEqual(world.timeline, [
    'events.register',
    'hooks.register',
    'hooks.register',
    'skills.register',
  ]);
  assert.deepEqual(world.eventRegisters, [
    {
      type: 'papercraft.cwd/v1',
      messageType: 'doric.papercraft.cwd.v1.PapercraftCwd',
    },
  ]);
  assert.deepEqual(world.hookRegisters, [
    { contract: 'runtime.hooks/v1', hook: 'onPromptStartedHook' },
    { contract: 'runtime.hooks/v1', hook: 'onThreadCwdChangedHook' },
  ]);
  assert.deepEqual(world.skillRegisters, [
    {
      skill: {
        name: 'papercraft',
        description: DESCRIPTION,
        allowedTools: ['comment_reply'],
        body: text.trim(),
      },
      options: { order: 3410, alwaysAvailable: false },
    },
  ]);
  assert.deepEqual(world.assetReads, [SKILL_PATH]);
  assert.deepEqual(world.calls, []);
});

void test('A2: a skills/v1.Register failing unavailable_tool leaves the skill out, activate resolves and Library answers', async (t) => {
  const world = routerWorld();
  stopAfter(t, world);
  world.failures.registerSkill = new ContractError(
    'unavailable_tool',
    'comment_reply is not a registered tool.',
  );

  await world.activate();
  const answer = await world.programs().library({ turnSequence: 1 });

  assert.equal(world.skillRegisters.length, 1);
  assert.equal(answer.status.case, 'none');
});

void test('A3: with the bundle’s own directory and no readAsset, activate rejects naming the skill path as not listed in host.assets', async (t) => {
  const world = routerWorld({ readAsset: 'context', bundleDir: bundleRoot });
  stopAfter(t, world);

  await assert.rejects(world.activate(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /src\/host\/skills\/papercraft\.md/u);
    assert.match(error.message, /not listed in host\.assets/u);
    return true;
  });
  assert.deepEqual(world.skillRegisters, []);
  assert.equal(
    await codeOf(() => world.programs().library({ turnSequence: 1 })),
    'unavailable',
  );
});

void test('A4: with a bundle directory whose manifest lists the skill and the runner, activate reads the skill through context.assets and the first job puts that runner', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'papercraft-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(
    await readFile(join(bundleRoot, 'manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
  const runner = Buffer.from('// the staged runner\n', 'utf8');
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({
      ...manifest,
      host: { assets: ['src/host/skills/*.md', RUNNER_PATH] },
    }),
  );
  await mkdir(join(directory, 'src', 'host', 'skills'), { recursive: true });
  await mkdir(join(directory, 'dist', 'sandbox'), { recursive: true });
  await writeFile(join(directory, SKILL_PATH), '\n  The staged skill.\n\n');
  await writeFile(join(directory, RUNNER_PATH), runner);
  const world = routerWorld({
    readAsset: 'context',
    bundleDir: directory,
    native: moduleNative,
  });
  stopAfter(t, world);
  world.lease.status = 'ready';
  world.lease.sandbox = scriptedSandbox(() => ({ status: 'none' }));

  await world.activate();
  await world.promptStarted('p1', '/workspace/app');
  await world.programs().library({ turnSequence: world.log.length + 1 });

  assert.equal(
    (world.skillRegisters[0] as { skill: { body: string } }).skill.body,
    'The staged skill.',
  );
  const runnerPut = world.puts.find(({ path }) =>
    /\/runner-[^/]+\.mjs$/u.test(path),
  );
  assert.ok(runnerPut !== undefined, JSON.stringify(world.puts));
  assert.deepEqual(Buffer.concat(runnerPut.chunks), runner);
});

void test('A5: before activate every method fails unavailable and the hooks are unknown', async (t) => {
  const world = routerWorld();
  stopAfter(t, world);
  await world.serveWithoutActivate();

  const codes = [
    await codeOf(() => world.programs().library({ turnSequence: 1 })),
    await codeOf(() => world.programs().export({ path: 'src/Card.tsx' })),
    await codeOf(async () => {
      for await (const _item of world.programs().read({ dir: 'abc' })) {
        // Drains the stream.
      }
    }),
    await codeOf(() =>
      world.hooks({ ...windowScope, promptId: 'p1' }).handle({
        contract: 'runtime.hooks/v1',
        hook: 'onPromptStartedHook',
        input: anyPack(
          OnPromptStartedHookInputSchema,
          create(OnPromptStartedHookInputSchema, {
            projectId,
            threadId,
            promptId: 'p1',
            source: { kind: { case: 'user', value: {} } },
            cwd: '/workspace',
          }),
        ),
      }),
    ),
  ];

  // The hook handlers are registered by activate: before it the SDK knows no such hook.
  assert.deepEqual(codes, [
    'unavailable',
    'unavailable',
    'unavailable',
    'not_found',
  ]);
  assert.deepEqual(world.calls, []);
});
