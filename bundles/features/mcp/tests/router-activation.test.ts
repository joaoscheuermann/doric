// A1–A3 (phase 3, S59c): `mcp`'s host part as a process activates over the
// router as `main.ts` runs it. `activate` defines `mcp.server/v1`, registers
// the MCP_TOKEN credential kind and the three `runtime.hooks/v1` handlers, in
// that order, then opens `runtime/v2.Watch`; it calls no `tools/v1`,
// `runtime.lease/v1` or `runtime.attachments/v1` method and connects nothing.
// Until it resolved, and after `deactivate`, every `mcp/v1` and
// `default.skill-sources/v1` method answers `unavailable` 'mcp is not active.'.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ContractError } from 'bundle/contracts';

import {
  failureOf,
  inputMessage,
  P1,
  type RouterWorld,
  routerWorld,
} from './support/router.js';
import { eventually } from './support/wait.js';
import { httpServer } from './support/world.js';

const REFERENCE = `${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}\nskill://refunds/SKILL.md`;

/** Every `mcp/v1` and `default.skill-sources/v1` method, called once for P1; answers each failure's code and message. */
const everyMethod = async (
  world: RouterWorld,
): Promise<readonly { code: string; message: string }[]> => {
  const mcp = world.mcp(P1);
  const skills = world.skillSources(P1);
  const id = 'server-1';
  const input = inputMessage(httpServer('docs', 'https://example.com/mcp'));
  const calls: (() => Promise<unknown>)[] = [
    () => mcp.list({}),
    () => mcp.create({ mcpServerInput: input }),
    () => mcp.update({ id, mcpServerInput: input }),
    () => mcp.remove({ id }),
    async () => {
      for await (const _item of mcp.watch({})) {
        // Drains the stream.
      }
    },
    () => mcp.signIn({ id }),
    () => mcp.finishSignIn({ id }),
    () => mcp.readSkill({ id, uri: 'skill://refunds/SKILL.md' }),
    () => skills.list({ cwd: '/workspace' }),
    () => skills.read({ reference: REFERENCE }),
  ];
  const failures: { code: string; message: string }[] = [];
  for (const call of calls) {
    const failure = await failureOf(call);
    failures.push({ code: failure.code, message: failure.message });
  }

  return failures;
};

const NOT_ACTIVE = { code: 'unavailable', message: 'mcp is not active.' };

void test('A1: activate defines mcp.server/v1, registers MCP_TOKEN and the three runtime hooks, in that order, then opens runtime/v2.Watch; no tools, lease or attachments call', async (t) => {
  const world = routerWorld();
  t.after(() => world.stop());

  await world.activate();
  await eventually(
    () => world.watches.length === 1,
    'runtime/v2.Watch opened',
    () => world.timeline,
  );

  assert.deepEqual(world.timeline, [
    'storage.defineType',
    'secrets.registerKind',
    'hooks.register',
    'hooks.register',
    'hooks.register',
    'runtime.watch',
  ]);
  assert.deepEqual(world.defineTypes, [
    {
      type: 'mcp.server/v1',
      indexes: [{ name: 'byProject', fields: ['projectId', 'createdKey'] }],
    },
  ]);
  assert.deepEqual(world.kindRegisters, [
    { id: 'MCP_TOKEN', required: ['secret'], optional: [], label: 'MCP token' },
  ]);
  assert.deepEqual(world.hookRegisters, [
    { contract: 'runtime.hooks/v1', hook: 'onPromptStartedHook' },
    { contract: 'runtime.hooks/v1', hook: 'onProjectClosingHook' },
    { contract: 'runtime.hooks/v1', hook: 'onProjectReadyHook' },
  ]);
  assert.deepEqual(
    world.calls.filter(({ method }) =>
      /^(tools|lease|attachments)\./u.test(method),
    ),
    [],
  );
  assert.deepEqual(world.sandbox.started, []);
});

void test('A2: a refused DefineType rejects activate with it, and every method then answers unavailable', async (t) => {
  const world = routerWorld();
  t.after(() => world.stop());
  world.failures.set(
    'storage.defineType',
    new ContractError(
      'registration_conflict',
      'mcp.server/v1 is defined by another bundle.',
    ),
  );

  const failure = await failureOf(() => world.activate());

  assert.equal(failure.code, 'registration_conflict', failure.message);
  assert.deepEqual(
    (await everyMethod(world)).map(({ code }) => code),
    Array.from({ length: 10 }, () => 'unavailable'),
  );
});

void test("A3: before activate every mcp/v1 and skill-sources method fails unavailable 'mcp is not active.'", async (t) => {
  const world = routerWorld();
  t.after(() => world.stop());
  await world.serveWithoutActivate();

  assert.deepEqual(
    await everyMethod(world),
    Array.from({ length: 10 }, () => NOT_ACTIVE),
  );
  assert.deepEqual(world.calls, []);
});

void test("A3: after deactivate every mcp/v1 and skill-sources method fails unavailable 'mcp is not active.'", async (t) => {
  const world = routerWorld();
  t.after(() => world.stop());
  await world.activate();

  await world.deactivate();

  assert.deepEqual(
    await everyMethod(world),
    Array.from({ length: 10 }, () => NOT_ACTIVE),
  );
});
