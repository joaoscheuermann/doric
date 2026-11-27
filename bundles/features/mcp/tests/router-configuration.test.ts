// mcp/v1 configuration per Project over the router: what `configuration.test.ts`
// tested on the kernel entry and the router suites M1–M10 do not already
// cover (S68c, X3). Listing per Project, a slug per Project, an update that
// moves a server, what storage keeps of an entry, and races of create, update,
// remove and a Project's deletion.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { textTool } from './support/mcp-server.js';
import {
  activated,
  contractErrorFrom,
  failureOf,
  inState,
  P1,
  P2,
  type RouterWorld,
} from './support/router.js';
import { served } from './support/setup.js';
import { eventually } from './support/wait.js';
import { httpServer } from './support/world.js';

/** A configuration nothing connects to. */
const idle = (name: string) =>
  httpServer(name, 'http://127.0.0.1:9/mcp', [], false);

/** The ids `List` answers for the Project, in order. */
const listedIds = async (world: RouterWorld, projectId: string) =>
  (await world.list(projectId)).map((server) => server.id);

void test('M1 a server created for one Project is listed there, in creation order, and not in another', async (t) => {
  const world = await activated(t);

  const first = await world.create(P1, idle('docs'));
  const second = await world.create(P1, idle('search'));

  assert.equal(first.projectId, P1);
  assert.deepEqual(await listedIds(world, P1), [first.id, second.id]);
  assert.deepEqual(await world.list(P2), []);
});

void test('M3 two names with the same slug clash within a Project but not across Projects', async (t) => {
  const world = await activated(t);
  await world.create(P1, idle('GitHub Copilot'));

  const clash = await failureOf(() =>
    world.create(P1, idle('github  copilot!')),
  );
  const other = await world.create(P2, idle('GitHub Copilot'));

  assert.equal(clash.code, 'mcp_server_name_taken');
  assert.equal(other.projectId, P2);
  assert.equal((await world.list(P1)).length, 1);
});

void test('M4 an update to a new URL drops the old server tools and registers the new server tools', async (t) => {
  const world = await activated(t);
  const before = await served(t, { tools: [textTool('alpha')] });
  const after = await served(t, { tools: [textTool('beta')] });
  const created = await world.create(P1, httpServer('docs', before.url));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');
  await eventually(
    () => world.liveNames(P1).join() === 'mcp__docs__alpha',
    'the old server tools',
    () => world.liveNames(P1),
  );

  await world.update(P1, created.id, httpServer('docs', after.url));

  await eventually(
    () => world.liveNames(P1).join() === 'mcp__docs__beta',
    'the new server tools',
    () => world.liveNames(P1),
  );
  assert.ok(
    world.registrations
      .filter((entry) => entry.name === 'mcp__docs__alpha')
      .every((entry) => entry.unregistered),
  );
});

void test('M6 storage keeps a credential entry as its id only and a plain entry as given', async (t) => {
  const world = await activated(t);
  const credentialId = world.addCredential(
    'docs-token',
    'Bearer header-secret-m6',
  );
  const headers = [
    { name: 'X-Plain', value: 'plain-value-m6' },
    { name: 'Authorization', credentialId },
  ];

  await world.create(
    P1,
    httpServer('docs', 'http://127.0.0.1:9/mcp', headers, false),
  );

  const [document] = world.documents();
  assert.deepEqual(document?.transport, {
    kind: 'http',
    url: 'http://127.0.0.1:9/mcp',
    headers,
  });
  const stored = JSON.stringify(world.documents());
  assert.ok(stored.includes(credentialId));
  assert.ok(stored.includes('plain-value-m6'));
  assert.ok(!stored.includes('header-secret-m6'));
});

void test('M9 two creates of the same name at once leave one server, and the other is refused as taken', async (t) => {
  const world = await activated(t);

  const settled = await Promise.allSettled([
    world.create(P1, idle('docs')),
    world.create(P1, idle('Docs')),
  ]);

  assert.deepEqual(settled.map((result) => result.status).sort(), [
    'fulfilled',
    'rejected',
  ]);
  const refused = settled.find((result) => result.status === 'rejected');
  assert.equal(
    refused?.status === 'rejected'
      ? contractErrorFrom(refused.reason).code
      : undefined,
    'mcp_server_name_taken',
  );
  assert.equal((await world.list(P1)).length, 1);
});

void test('M10 an update racing a remove never brings the removed server back', async (t) => {
  const world = await activated(t);
  const created = await Promise.all(
    ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => world.create(P1, idle(name))),
  );

  await Promise.allSettled(
    created.flatMap((server, index) => {
      const update = () =>
        world.update(P1, server.id, idle(`${server.name}-renamed`));
      const remove = () => world.mcp(P1).remove({ id: server.id });

      return index % 2 === 0 ? [update(), remove()] : [remove(), update()];
    }),
  );

  assert.deepEqual(await world.list(P1), []);
  assert.deepEqual(world.documents(), []);
});

void test('M10 updates racing the deletion of their Project never bring a server back', async (t) => {
  const world = await activated(t);
  const created = await Promise.all(
    ['a', 'b', 'c', 'd'].map((name) => world.create(P1, idle(name))),
  );
  await eventually(() => world.watches.length === 1, 'runtime/v2.Watch open');
  const [watch] = world.watches;
  assert.ok(watch !== undefined);

  const updates = Promise.allSettled(
    created.map((server) =>
      world.update(P1, server.id, idle(`${server.name}-renamed`)),
    ),
  );
  watch.push({ notice: { case: 'projectDeleted', value: { projectId: P1 } } });
  await updates;

  await eventually(
    () => world.documents().length === 0,
    'no servers left',
    () => world.documents(),
  );
  assert.deepEqual(await world.list(P1), []);
});

void test('M11 an entry naming an MCP sign-in token is refused on create and on update', async (t) => {
  const world = await activated(t);
  const tokenId = world.addCredential(
    `mcp:${randomUUID()}:access`,
    'another-server-token',
    'MCP_TOKEN',
  );
  const own = world.addCredential('docs-token', 'own-secret');
  const created = await world.create(
    P1,
    httpServer(
      'docs',
      'http://127.0.0.1:9/mcp',
      [{ name: 'Authorization', credentialId: own }],
      false,
    ),
  );
  const documents = world.documents();

  const onCreate = await failureOf(() =>
    world.create(
      P1,
      httpServer(
        'search',
        'http://127.0.0.1:9/mcp',
        [{ name: 'Authorization', credentialId: tokenId }],
        false,
      ),
    ),
  );
  const onUpdate = await failureOf(() =>
    world.update(P1, created.id, {
      name: 'docs',
      enabled: false,
      transport: {
        kind: 'stdio',
        command: 'docs-mcp',
        args: [],
        env: [{ name: 'TOKEN', credentialId: tokenId }],
      },
    }),
  );

  assert.equal(onCreate.code, 'invalid_input');
  assert.equal(onUpdate.code, 'invalid_input');
  assert.deepEqual(world.documents(), documents);
});
