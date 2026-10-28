// mcp/v1 configuration, per Project: create, list, update, remove and watch,
// what storage keeps of a server, and what a deleted Project leaves behind.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { type McpServerView, mcpScopeMessage } from '../src/contracts/index.js';
import { textTool } from './support/mcp-server.js';
import { opened, served } from './support/setup.js';
import { codeOf, eventually } from './support/wait.js';
import { httpServer, inState, P1, P2, serverOf } from './support/world.js';

/** Asserts the promise rejects with a contract error of that code. */
const rejectsWith = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: unknown) => {
    assert.equal(codeOf(error), code);
    return true;
  });

/** A configuration nothing connects to. */
const idle = (name: string) =>
  httpServer(name, 'http://127.0.0.1:9/mcp', [], false);

void test('M1 a server created for one Project is listed there, in creation order, and not in another', async (t) => {
  const world = await opened(t);

  const first = await world.mcp(P1).create(idle('docs'));
  const second = await world.mcp(P1).create(idle('search'));

  assert.equal(first.projectId, P1);

  assert.deepEqual(
    (await world.mcp(P1).list()).map((server) => server.id),
    [first.id, second.id],
  );

  assert.deepEqual(await world.mcp(P2).list(), []);
});

void test('M2 a call without a Project scope is refused as invalid input', async (t) => {
  const world = await opened(t);

  await assert.rejects(world.unscoped.list(), (error: unknown) => {
    assert.equal(codeOf(error), 'invalid_input');
    assert.equal((error as Error).message, mcpScopeMessage);
    return true;
  });

  await rejectsWith(world.unscoped.create(idle('docs')), 'invalid_input');
});

void test('M3 two names with the same slug clash within a Project but not across Projects', async (t) => {
  const world = await opened(t);
  await world.mcp(P1).create(idle('GitHub Copilot'));

  await rejectsWith(
    world.mcp(P1).create(idle('github  copilot!')),
    'mcp_server_name_taken',
  );

  const other = await world.mcp(P2).create(idle('GitHub Copilot'));

  assert.equal(other.projectId, P2);

  assert.equal((await world.mcp(P1).list()).length, 1);
});

void test('M4 an update to a new URL drops the old server tools and registers the new server tools', async (t) => {
  const world = await opened(t);
  const before = await served(t, { tools: [textTool('alpha')] });
  const after = await served(t, { tools: [textTool('beta')] });
  const created = await world.mcp(P1).create(httpServer('docs', before.url));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');
  assert.deepEqual(world.liveNames(P1), ['mcp__docs__alpha']);

  await world
    .mcp(P1)
    .update({ id: created.id, ...httpServer('docs', after.url) });
  await eventually(
    () => world.liveNames(P1).join() === 'mcp__docs__beta',
    'the new server tools',
    () => world.liveNames(P1),
  );

  assert.ok(
    world.registrations
      .filter((entry) => entry.tool.name === 'mcp__docs__alpha')
      .every((entry) => entry.disposed),
  );
});

void test('M5 remove drops the server and its tools; removing a missing server is refused', async (t) => {
  const world = await opened(t);
  const server = await served(t, { tools: [textTool('alpha')] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');

  await world.mcp(P1).remove({ id: created.id });

  assert.deepEqual(await world.mcp(P1).list(), []);

  assert.deepEqual(world.liveNames(P1), []);

  await rejectsWith(
    world.mcp(P1).remove({ id: created.id }),
    'mcp_server_missing',
  );

  await rejectsWith(
    world.mcp(P1).remove({ id: randomUUID() }),
    'mcp_server_missing',
  );
});

void test('M6 storage keeps a credential entry as its id only and a plain entry as given', async (t) => {
  const world = await opened(t);
  const credentialId = world.env.addCredential(
    'docs-token',
    'Bearer header-secret-m6',
  );
  const headers = [
    { name: 'X-Plain', value: 'plain-value-m6' },
    { name: 'Authorization', credentialId },
  ];

  const created = await world
    .mcp(P1)
    .create(httpServer('docs', 'http://127.0.0.1:9/mcp', headers, false));

  assert.deepEqual(created.transport, {
    kind: 'http',
    url: 'http://127.0.0.1:9/mcp',
    headers,
  });

  const stored = JSON.stringify(world.env.serverDocuments());

  assert.ok(stored.includes(credentialId));

  assert.ok(stored.includes('plain-value-m6'));

  assert.ok(!stored.includes('header-secret-m6'));
});

void test('M7 a deleted Project loses its servers and their tools, other Projects keep theirs', async (t) => {
  const world = await opened(t);
  const server = await served(t, { tools: [textTool('alpha')] });
  const doomed = await world.mcp(P1).create(httpServer('docs', server.url));
  const kept = await world.mcp(P2).create(idle('docs'));
  await world.watchUntil(P1, inState(doomed.id, 'connected'), 'connected');

  world.notice({ kind: 'projectDeleted', projectId: P1 });

  await world.listUntil(
    P1,
    (servers) => servers.length === 0,
    'no servers left',
  );
  await eventually(
    () => world.liveNames(P1).length === 0,
    'the tools disposed',
    () => world.liveNames(P1),
  );

  assert.ok(!JSON.stringify(world.env.serverDocuments()).includes(doomed.id));

  assert.deepEqual(
    (await world.mcp(P2).list()).map((entry) => entry.id),
    [kept.id],
  );
});

void test('M8 watch answers a snapshot first, then the server connected with its tools', async (t) => {
  const world = await opened(t);
  const server = await served(t, { tools: [textTool('alpha')] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  const snapshots: (readonly McpServerView[])[] = [];

  const subscription = world.mcp(P1).watch((servers) => {
    snapshots.push(servers);
  });

  await eventually(
    () => snapshots.some(inState(created.id, 'connected')),
    'a connected snapshot',
    () => snapshots.at(-1),
  );
  subscription.dispose();

  assert.deepEqual(
    snapshots[0]?.map((entry) => entry.id),
    [created.id],
  );

  const connected = snapshots.find(inState(created.id, 'connected'));

  assert.deepEqual(
    serverOf(connected ?? [], created.id)?.tools.map((tool) => tool.name),
    ['alpha'],
  );
});

void test('M9 two creates of the same name at once leave one server, and the other is refused as taken', async (t) => {
  const world = await opened(t);

  const settled = await Promise.allSettled([
    world.mcp(P1).create(idle('docs')),
    world.mcp(P1).create(idle('Docs')),
  ]);

  assert.deepEqual(settled.map((result) => result.status).sort(), [
    'fulfilled',
    'rejected',
  ]);

  const refused = settled.find((result) => result.status === 'rejected');

  assert.equal(codeOf(refused?.reason), 'mcp_server_name_taken');

  assert.equal((await world.mcp(P1).list()).length, 1);
});

void test('M10 an update racing a remove never brings the removed server back', async (t) => {
  const world = await opened(t);
  const created = await Promise.all(
    ['a', 'b', 'c', 'd', 'e', 'f'].map((name) =>
      world.mcp(P1).create(idle(name)),
    ),
  );

  await Promise.allSettled(
    created.flatMap((server, index) => {
      const update = () =>
        world
          .mcp(P1)
          .update({ id: server.id, ...idle(`${server.name}-renamed`) });
      const remove = () => world.mcp(P1).remove({ id: server.id });

      return index % 2 === 0 ? [update(), remove()] : [remove(), update()];
    }),
  );

  assert.deepEqual(await world.mcp(P1).list(), []);

  assert.deepEqual(world.env.serverDocuments(), []);
});

void test('M10 updates racing the deletion of their Project never bring a server back', async (t) => {
  const world = await opened(t);
  const created = await Promise.all(
    ['a', 'b', 'c', 'd'].map((name) => world.mcp(P1).create(idle(name))),
  );

  const updates = Promise.allSettled(
    created.map((server) =>
      world
        .mcp(P1)
        .update({ id: server.id, ...idle(`${server.name}-renamed`) }),
    ),
  );
  world.notice({ kind: 'projectDeleted', projectId: P1 });
  await updates;

  await world.listUntil(
    P1,
    (servers) => servers.length === 0,
    'no servers left',
  );

  assert.deepEqual(world.env.serverDocuments(), []);
});

void test('M11 an entry naming an MCP sign-in token is refused on create and on update', async (t) => {
  const world = await opened(t);
  const tokenId = randomUUID();
  world.env.credentials.set(tokenId, {
    id: tokenId,
    kind: 'MCP_TOKEN',
    name: `mcp:${randomUUID()}:access`,
    secret: 'another-server-token',
  });
  const own = world.env.addCredential('docs-token', 'own-secret');
  const created = await world
    .mcp(P1)
    .create(
      httpServer(
        'docs',
        'http://127.0.0.1:9/mcp',
        [{ name: 'Authorization', credentialId: own }],
        false,
      ),
    );

  await rejectsWith(
    world
      .mcp(P1)
      .create(
        httpServer(
          'search',
          'http://127.0.0.1:9/mcp',
          [{ name: 'Authorization', credentialId: tokenId }],
          false,
        ),
      ),
    'invalid_input',
  );

  await rejectsWith(
    world.mcp(P1).update({
      id: created.id,
      name: 'docs',
      enabled: false,
      transport: {
        kind: 'stdio',
        command: 'docs-mcp',
        args: [],
        env: [{ name: 'TOKEN', credentialId: tokenId }],
      },
    }),
    'invalid_input',
  );

  assert.deepEqual(
    (await world.mcp(P1).list()).map((server) => server.transport),
    [created.transport],
  );
});
