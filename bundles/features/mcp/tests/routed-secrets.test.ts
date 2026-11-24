// C2 (phase 3, S59 D2): `routedSecrets`, the `McpSecrets` over
// `secrets/v1`. Each method answers today's `Secrets` shape; a provider's
// failure keeps its code and details (the vault reads `credential_missing`
// from `Resolve` as no token); `describe` with a call runs under that call
// (the credential check of `Create`/`Update` carries the caller's deadline),
// without one outside it; every other method runs outside the caller's call.

import assert from 'node:assert/strict';
import test from 'node:test';

import { type Call, ContractError, deadlineOf } from 'bundle/contracts';

import { routedSecrets } from '../src/host/routed.js';
import {
  type AdapterWorld,
  adapterWorld,
  P1,
  THREAD,
} from './support/adapters.js';

const setup = async (t: test.TestContext) => {
  const world = adapterWorld();
  t.after(() => world.stop());
  const context = await world.context();

  return { world, secrets: routedSecrets(context.services) };
};

const seed = (world: AdapterWorld) => {
  world.credentials.set('token-1', {
    id: 'token-1',
    kind: 'MCP_TOKEN',
    name: 'mcp:server-1:access',
    secret: 'secret-1',
  });
  world.credentials.set('login-1', {
    id: 'login-1',
    kind: 'LOGIN',
    name: 'Docs login',
    username: 'ana',
    email: 'ana@example.com',
    secret: 'pw',
  });
};

void test('C2: resolve answers the Secret, absent username, email and secret left out', async (t) => {
  const { world, secrets } = await setup(t);
  seed(world);

  assert.deepEqual(await secrets.resolve({ id: 'token-1' }), {
    id: 'token-1',
    kind: 'MCP_TOKEN',
    name: 'mcp:server-1:access',
    secret: 'secret-1',
  });
  assert.deepEqual(await secrets.resolve({ id: 'login-1' }), {
    id: 'login-1',
    kind: 'LOGIN',
    name: 'Docs login',
    username: 'ana',
    email: 'ana@example.com',
    secret: 'pw',
  });
  assert.deepEqual(
    world.callsOf('secrets.resolve').map(({ request }) => request),
    [{ id: 'token-1' }, { id: 'login-1' }],
  );
});

void test('C2: credential_missing from Resolve keeps its code and details', async (t) => {
  const { secrets } = await setup(t);

  await assert.rejects(secrets.resolve({ id: 'gone' }), (error: unknown) => {
    assert.ok(error instanceof ContractError, String(error));
    assert.equal(error.code, 'credential_missing');
    assert.deepEqual(error.details, { credentialId: 'gone' });
    return true;
  });
});

void test('C2: describe answers the description, or undefined for an unknown id', async (t) => {
  const { world, secrets } = await setup(t);
  seed(world);

  assert.deepEqual(await secrets.describe({ id: 'token-1' }), {
    id: 'token-1',
    kind: 'MCP_TOKEN',
    name: 'mcp:server-1:access',
    hasSecret: true,
  });
  assert.equal(await secrets.describe({ id: 'unknown' }), undefined);
});

void test('C2: create answers the written description and sends only the fields given', async (t) => {
  const { world, secrets } = await setup(t);

  const written = await secrets.create({
    kind: 'MCP_TOKEN',
    name: 'mcp:server-1:access',
    secret: 'secret-2',
  });

  assert.equal(written.kind, 'MCP_TOKEN');
  assert.equal(written.name, 'mcp:server-1:access');
  assert.equal(written.hasSecret, true);
  assert.ok(!('username' in written) && !('email' in written));
  assert.ok(world.credentials.has(written.id));
  assert.deepEqual(world.callsOf('secrets.create')[0]?.request, {
    kind: 'MCP_TOKEN',
    name: 'mcp:server-1:access',
    secret: 'secret-2',
  });
});

void test('C2: update sends only the fields given, null clearing as an empty string, and answers the description', async (t) => {
  const { world, secrets } = await setup(t);
  seed(world);

  const written = await secrets.update(
    { id: 'login-1' },
    { name: 'Docs', email: null },
  );

  assert.deepEqual(world.callsOf('secrets.update')[0]?.request, {
    id: 'login-1',
    update: { name: 'Docs', email: '' },
  });
  assert.deepEqual(written, {
    id: 'login-1',
    kind: 'LOGIN',
    name: 'Docs',
    username: 'ana',
    hasSecret: true,
  });
});

void test('C2: delete answers deleted, missing or referenced', async (t) => {
  const { world, secrets } = await setup(t);
  seed(world);

  assert.equal(await secrets.delete({ id: 'token-1' }), 'deleted');
  assert.equal(await secrets.delete({ id: 'token-1' }), 'missing');
  assert.equal(await secrets.delete({ id: 'referenced' }), 'referenced');
});

void test('C2: list answers the descriptions in order', async (t) => {
  const { world, secrets } = await setup(t);
  seed(world);

  assert.deepEqual(
    (await secrets.list()).map(({ id }) => id),
    ['token-1', 'login-1'],
  );
});

void test("C2 (D2): describe with a call carries the caller's scope and deadline; without one, neither", async (t) => {
  const { world, secrets } = await setup(t);
  seed(world);
  const scope = { projectId: P1, threadId: THREAD };

  const callerDeadline = await world.within(
    async (call: Call) => {
      await secrets.describe({ id: 'token-1' }, call);
      await secrets.describe({ id: 'login-1' });

      return deadlineOf(call);
    },
    { scope, timeoutMs: 30_000 },
  );

  const [withCall, withoutCall] = world.callsOf('secrets.describe');
  assert.ok(callerDeadline > 0);
  assert.equal(withCall?.deadline, callerDeadline);
  assert.deepEqual(withCall?.scope, scope);
  assert.equal(withoutCall?.deadline, 0);
  assert.equal(withoutCall?.scope, undefined);
});

void test("C2 (D2): every other method runs outside the caller's call, even given one", async (t) => {
  const { world, secrets } = await setup(t);
  seed(world);

  await world.within(
    async (call: Call) => {
      await secrets.resolve({ id: 'token-1' }, call);
      await secrets.list(call);
      const written = await secrets.create(
        { kind: 'MCP_TOKEN', name: 'n', secret: 's' },
        call,
      );
      await secrets.update({ id: written.id }, { secret: 't' }, call);
      await secrets.delete({ id: written.id }, call);
    },
    { scope: { projectId: P1 }, timeoutMs: 30_000 },
  );

  const methods = [
    'secrets.resolve',
    'secrets.list',
    'secrets.create',
    'secrets.update',
    'secrets.delete',
  ];
  for (const method of methods) {
    const [call] = world.callsOf(method);
    assert.ok(call !== undefined, method);
    assert.equal(call.deadline, 0, method);
    assert.equal(call.scope, undefined, method);
  }
});
