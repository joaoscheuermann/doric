// M6–M7 (phase 3, S59c): `mcp/v1.Watch` over the router answers the present
// list first, then the whole list after every change, and connects the
// Project's enabled servers in the background; `List` never connects. The
// connection it starts outlives the `Watch` call (D2): cancelling the stream
// leaves the attempt running, and the calls the attempt makes carry no
// deadline and an unaborted signal.

import assert from 'node:assert/strict';
import test from 'node:test';

import { textTool } from './support/mcp-server.js';
import {
  activated,
  inState,
  P1,
  serverOf,
  type View,
  viewOf,
} from './support/router.js';
import { served } from './support/setup.js';
import { eventually } from './support/wait.js';
import { httpServer } from './support/world.js';

void test('M6: Watch answers the present list first, then the server connecting and connected with its tools; List never connects', async (t) => {
  const world = await activated(t);
  const server = await served(t, { tools: [textTool('alpha')] });
  const created = await world.create(P1, httpServer('docs', server.url));

  const listed = await world.list(P1);
  assert.equal(serverOf(listed, created.id)?.status.state, 'idle');
  assert.deepEqual(server.requests, []);

  const items: (readonly View[])[] = [];
  const controller = new AbortController();
  t.after(() => controller.abort());
  const watching = (async () => {
    for await (const item of world
      .mcp(P1)
      .watch({}, { signal: controller.signal })) {
      items.push(item.servers.map((entry) => viewOf(entry)));
      if (inState(created.id, 'connected')(items.at(-1) ?? [])) return;
    }
  })();
  await watching;

  assert.deepEqual(
    items[0]?.map(({ id, status }) => ({ id, state: status.state })),
    [{ id: created.id, state: 'idle' }],
  );
  const states = items.map(
    (servers) => serverOf(servers, created.id)?.status.state,
  );
  assert.ok(
    states.indexOf('connecting') > 0 &&
      states.indexOf('connecting') < states.indexOf('connected'),
    JSON.stringify(states),
  );
  assert.deepEqual(
    serverOf(items.at(-1) ?? [], created.id)?.tools.map(({ name }) => name),
    ['alpha'],
  );
});

void test('M7 (D2): cancelling the Watch while the server connects leaves the attempt running: it connects and registers its tools, and its calls carry no deadline and an unaborted signal', async (t) => {
  const world = await activated(t);
  const server = await served(t, { tools: [textTool('alpha')] });
  const token = world.addCredential('docs-token', 'secret-m7');
  const created = await world.create(
    P1,
    httpServer('docs', server.url, [{ name: 'X-Token', credentialId: token }]),
  );
  const controller = new AbortController();
  const stream = world
    .mcp(P1)
    .watch({}, { signal: controller.signal, timeoutMs: 30_000 });

  for await (const _item of stream) {
    break;
  }
  controller.abort();
  const cancelledAt = world.calls.length;

  await eventually(
    async () => inState(created.id, 'connected')(await world.list(P1)),
    'connected without a watcher',
  );
  await eventually(
    () => world.liveNames(P1).includes('mcp__docs__alpha'),
    'the tool registered',
    () => world.registrations,
  );

  assert.deepEqual(world.callsOf('tools.unregister'), []);
  const attempt = world.calls.filter(({ method }) =>
    ['tools.register', 'secrets.resolve', 'storage.query'].includes(method),
  );
  assert.ok(
    attempt.some(({ method }) => method === 'tools.register') &&
      attempt.some(({ method }) => method === 'secrets.resolve'),
    JSON.stringify(attempt.map(({ method }) => method)),
  );
  for (const call of [
    ...world.callsOf('tools.register'),
    ...world.callsOf('secrets.resolve'),
    ...world.calls.slice(cancelledAt),
  ]) {
    assert.equal(call.deadline, 0, `${call.method} carried a deadline`);
    assert.equal(call.aborted, false, `${call.method} arrived aborted`);
  }
});
