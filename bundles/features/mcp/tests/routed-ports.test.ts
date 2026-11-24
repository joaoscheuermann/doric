// Adapter tests of S59b (D1, D2, D7): `routedMcpPorts`, every `McpPorts`
// member over the router (storage through `storage/rpc`'s client, run
// outside the caller's call; the log is `context.log`); `detached`, which
// runs work outside every handler's call; and `watchProjectDeletions`, which
// follows `runtime/v2.Watch` for `projectDeleted` items, logs a failed
// opening at `warn` and opens it again after 5 s — as it does after a stream
// that ends cleanly (a drained runtime generation) — until `dispose()`.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ContractError } from 'bundle/contracts';
import { SecretsService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';

import {
  detached,
  routedMcpPorts,
  watchProjectDeletions,
} from '../src/host/routed.js';
import { adapterWorld, P1, P2, THREAD } from './support/adapters.js';
import { eventually, sleep } from './support/wait.js';

const setup = async (t: test.TestContext) => {
  const world = adapterWorld();
  t.after(() => world.stop());
  const context = await world.context();

  return { world, context };
};

/** How long `watchProjectDeletions` waits before it opens `Watch` again (D7). */
const REOPEN_MS = 5_000;

void test("detached: a call made inside it carries neither the handler's scope nor its deadline; one made beside it carries both", async (t) => {
  const { world, context } = await setup(t);
  const secrets = () => context.services.use(SecretsService);

  await world.within(
    async () => {
      await secrets().list({});
      await detached(() => secrets().list({}));
    },
    { scope: { projectId: P1 }, timeoutMs: 30_000 },
  );

  const [inside, outside] = world.callsOf('secrets.list');
  assert.ok((inside?.deadline ?? 0) > 0);
  assert.deepEqual(inside?.scope, { projectId: P1 });
  assert.equal(outside?.deadline, 0);
  assert.equal(outside?.scope, undefined);
});

void test("routedMcpPorts: storage reads run outside the caller's call", async (t) => {
  const { world, context } = await setup(t);
  const { ports } = routedMcpPorts(context, world.handlers);

  await world.within(
    async () => {
      await ports.storage
        .get({ type: 'mcp.server/v1', id: 'server-1' })
        .catch(() => undefined);
    },
    { scope: { projectId: P1, threadId: THREAD }, timeoutMs: 30_000 },
  );

  const [get] = world.callsOf('storage.get');
  assert.deepEqual(get?.request, { type: 'mcp.server/v1', id: 'server-1' });
  assert.equal(get?.deadline, 0);
  assert.equal(get?.scope, undefined);
});

void test("routedMcpPorts: secrets, tools and lease reach their services; log is the context's log", async (t) => {
  const { world, context } = await setup(t);
  const { ports, storage } = routedMcpPorts(context, world.handlers);
  world.credentials.set('token-1', {
    id: 'token-1',
    kind: 'MCP_TOKEN',
    name: 'access',
    secret: 's',
  });

  assert.deepEqual(
    (await ports.secrets.list()).map(({ id }) => id),
    ['token-1'],
  );
  assert.deepEqual([...(await ports.tools.listed(P1))], []);
  assert.deepEqual(await ports.lease.run(P1, async () => 'ran'), {
    status: 'ready',
    value: 'ran',
  });
  ports.log().info('ports log');

  assert.equal(world.callsOf('secrets.list').length, 1);
  assert.deepEqual(world.callsOf('tools.list')[0]?.scope, { projectId: P1 });
  assert.deepEqual(world.callsOf('lease.describe')[0]?.scope, {
    projectId: P1,
  });
  assert.ok(
    world.router.logs.some(
      ({ level, message }) => level === 'info' && message === 'ports log',
    ),
  );
  assert.equal(typeof storage.settled, 'function');
  await storage.settled();
});

void test('watchProjectDeletions (D7): opens Watch outside any call and calls onDeleted for each projectDeleted, in order, skipping other notices', async (t) => {
  const { world, context } = await setup(t);
  const deleted: string[] = [];

  const watch = watchProjectDeletions(context, (projectId) =>
    deleted.push(projectId),
  );
  t.after(() => watch.dispose());
  await eventually(() => world.watches.length === 1, 'the Watch opened');
  const [opening] = world.watches;
  assert.equal(opening?.deadline, 0);
  assert.equal(opening?.scope, undefined);

  opening?.push({
    notice: {
      case: 'threadDeleted',
      value: { projectId: P1, threadId: THREAD },
    },
  });
  opening?.push({
    notice: { case: 'projectDeleted', value: { projectId: P1 } },
  });
  opening?.push({
    notice: { case: 'projectDeleted', value: { projectId: P2 } },
  });

  await eventually(
    () => deleted.length === 2,
    'two deletions',
    () => deleted,
  );
  assert.deepEqual(deleted, [P1, P2]);
});

void test('watchProjectDeletions (D7, Q4): an opening that fails is logged at warn and opened again after 5 s, not before; dispose cancels the open stream', async (t) => {
  const { world, context } = await setup(t);
  const watch = watchProjectDeletions(context, () => undefined);
  t.after(() => watch.dispose());
  await eventually(() => world.watches.length === 1, 'the Watch opened');

  const failedAt = Date.now();
  world.watches[0]?.fail(new ContractError('internal', 'The runtime broke.'));

  await eventually(
    () => world.router.logs.some(({ level }) => level === 'warn'),
    'a warn log',
    () => world.router.logs,
  );
  await sleep(REOPEN_MS - 1_000);
  assert.equal(world.watches.length, 1, 'not opened again before 5 s');
  await eventually(
    () => world.watches.length === 2,
    'the Watch opened again',
    () => world.watches.length,
    REOPEN_MS,
  );
  assert.ok(Date.now() - failedAt >= REOPEN_MS - 50);

  const reopened = world.watches[1];
  assert.equal(reopened?.signal.aborted, false);
  watch.dispose();
  await eventually(
    () => reopened?.signal.aborted === true,
    'the stream cancelled',
  );
});

void test('watchProjectDeletions (D7): a stream that ends cleanly is opened again after 5 s, not before; after dispose nothing more opens', async (t) => {
  const { world, context } = await setup(t);
  const watch = watchProjectDeletions(context, () => undefined);
  t.after(() => watch.dispose());
  await eventually(() => world.watches.length === 1, 'the Watch opened');

  const endedAt = Date.now();
  world.watches[0]?.end();

  await sleep(REOPEN_MS - 1_000);
  assert.equal(world.watches.length, 1, 'not opened again before 5 s');
  await eventually(
    () => world.watches.length === 2,
    'the Watch opened again after a clean end',
    () => world.watches.length,
    REOPEN_MS,
  );
  assert.ok(Date.now() - endedAt >= REOPEN_MS - 50);

  const reopened = world.watches[1];
  watch.dispose();
  await eventually(
    () => reopened?.signal.aborted === true,
    'the stream cancelled',
  );
  await sleep(REOPEN_MS + 500);
  assert.equal(world.watches.length, 2, 'nothing opened after dispose');
});

void test('watchProjectDeletions (D7): dispose during the wait opens nothing more and never throws', async (t) => {
  const { world, context } = await setup(t);
  const watch = watchProjectDeletions(context, () => undefined);
  await eventually(() => world.watches.length === 1, 'the Watch opened');

  world.watches[0]?.fail(new ContractError('internal', 'The runtime broke.'));
  await eventually(
    () => world.router.logs.some(({ level }) => level === 'warn'),
    'a warn log',
  );
  assert.doesNotThrow(() => watch.dispose());
  await sleep(REOPEN_MS + 500);

  assert.equal(world.watches.length, 1);
  assert.doesNotThrow(() => watch.dispose());
});
