// H1–H2 (phase 3, S59c, D8): `onPromptStartedHook` over the router's
// `HookHandlerService` answers `{}` once the Project's servers settled — a
// failing server included — or after `PROMPT_WAIT_MS` (10 s) when one never
// answers its `initialize`, the attempt going on. The attempt never inherits
// the hook's call (D2): cancelling the `Handle` leaves it running.

import assert from 'node:assert/strict';
import test from 'node:test';

import { textTool, unreachableUrl } from './support/mcp-server.js';
import {
  activated,
  failureOf,
  gatedProxy,
  inState,
  P1,
  serverOf,
} from './support/router.js';
import { served } from './support/setup.js';
import { eventually } from './support/wait.js';
import { httpServer } from './support/world.js';

/** `onPromptStartedHook`'s wait for the Project's servers. */
const PROMPT_WAIT_MS = 10_000;

void test("H1: onPromptStartedHook answers once the Project's servers settled, a failing one included: the connected server's tools are registered by then", async (t) => {
  const world = await activated(t);
  const server = await served(t, { tools: [textTool('alpha')] });
  const docs = await world.create(P1, httpServer('docs', server.url));
  const gone = await world.create(
    P1,
    httpServer('gone', await unreachableUrl()),
  );

  await world.promptStarted(P1);

  assert.deepEqual(world.liveNames(P1), ['mcp__docs__alpha']);
  const servers = await world.list(P1);
  assert.equal(serverOf(servers, docs.id)?.status.state, 'connected');
  assert.equal(serverOf(servers, gone.id)?.status.state, 'error');
});

void test('H1: a server that never answers its initialize makes onPromptStartedHook answer after PROMPT_WAIT_MS, the attempt going on', async (t) => {
  const world = await activated(t);
  const server = await served(t, { tools: [textTool('alpha')] });
  const proxy = await gatedProxy(t, server.url);
  const created = await world.create(P1, httpServer('slow', proxy.url));
  const started = Date.now();

  await world.promptStarted(P1);

  const elapsed = Date.now() - started;
  assert.ok(
    elapsed >= PROMPT_WAIT_MS - 500 && elapsed < PROMPT_WAIT_MS + 5_000,
    `answered after ${String(elapsed)} ms`,
  );
  assert.ok(proxy.received() >= 1, 'the initialize was sent');
  assert.equal(
    serverOf(await world.list(P1), created.id)?.status.state,
    'connecting',
  );

  proxy.open();
  await eventually(
    async () => inState(created.id, 'connected')(await world.list(P1)),
    'the attempt connected once the server answered',
  );
});

void test('H2 (D2): cancelling the onPromptStartedHook Handle does not abort the attempt, which connects and registers its tools without a deadline', async (t) => {
  const world = await activated(t);
  const server = await served(t, { tools: [textTool('alpha')] });
  const proxy = await gatedProxy(t, server.url);
  const created = await world.create(P1, httpServer('slow', proxy.url));
  const controller = new AbortController();

  const handling = failureOf(() =>
    world.promptStarted(P1, { signal: controller.signal }),
  );
  await eventually(() => proxy.received() >= 1, 'the initialize was sent');
  controller.abort();
  await handling;
  proxy.open();

  await eventually(
    async () => inState(created.id, 'connected')(await world.list(P1)),
    'the attempt connected after the Handle was cancelled',
  );
  await eventually(
    () => world.liveNames(P1).join() === 'mcp__slow__alpha',
    'the tool registered',
    () => world.registrations,
  );
  for (const call of world.callsOf('tools.register')) {
    assert.equal(call.deadline, 0);
    assert.equal(call.aborted, false);
  }
});
