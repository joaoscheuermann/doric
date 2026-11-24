// D1–D2 (phase 3, S59c, D7, Q4): `mcp` follows `runtime/v2.Watch`. A
// `projectDeleted` notice forgets the Project's servers — documents, MCP_TOKEN
// credentials, tools, processes — and leaves other Projects alone; other
// notices are ignored. A stream failing is logged and opened again after 5 s;
// `deactivate` cancels it.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ContractError } from 'bundle/contracts';

import { textTool } from './support/mcp-server.js';
import { activated, inState, P1, P2, signInThrough } from './support/router.js';
import { authorizing, guarded, served } from './support/setup.js';
import { eventually, sleep } from './support/wait.js';
import { httpServer, stdioServer } from './support/world.js';

/** How long after a failed stream `mcp` opens it again (`resumableDelays.maxMs`). */
const REOPEN_MS = 5_000;

void test("D1: projectDeleted{P1} forgets P1's servers, deletes their credentials, unregisters their tools and stops their processes; threadDeleted is ignored; P2 is untouched", async (t) => {
  const world = await activated(t);
  const as = await authorizing(t);
  const guardedServer = await guarded(t, as, { tools: [textTool('alpha')] });
  const open = await served(t, { tools: [textTool('beta')] });
  const signed = await world.create(P1, httpServer('docs', guardedServer.url));
  await signInThrough(world, P1, signed.id, as);
  const files = await world.create(P1, stdioServer('files', 'node'));
  await world.watchUntil(P1, inState(files.id, 'connected'), 'connected');
  const other = await world.create(P2, httpServer('other', open.url));
  await world.watchUntil(P2, inState(other.id, 'connected'), 'connected');
  await eventually(
    () => world.liveNames(P1).length === 2 && world.liveNames(P2).length === 1,
    'the tools registered',
    () => world.registrations,
  );
  await eventually(() => world.watches.length === 1, 'runtime/v2.Watch open');
  const [watch] = world.watches;
  const [start] = world.starts;
  assert.ok(watch !== undefined && start !== undefined);

  watch.push({
    notice: {
      case: 'threadDeleted',
      value: { projectId: P1, threadId: 'thread-1' },
    },
  });
  watch.push({ notice: { case: 'projectDeleted', value: { projectId: P1 } } });

  await eventually(
    () =>
      world.documents().every((document) => document.projectId !== P1) &&
      world.liveNames(P1).length === 0 &&
      start.process.terminated,
    "P1's servers forgotten",
    () => ({ documents: world.documents(), live: world.liveNames(P1) }),
  );
  assert.deepEqual(
    [...world.credentials.values()].filter(
      ({ kind, name }) =>
        kind === 'MCP_TOKEN' && name.startsWith(`mcp:${signed.id}:`),
    ),
    [],
  );
  assert.deepEqual(
    world.documents().map(({ id }) => id),
    [other.id],
  );
  assert.deepEqual(world.liveNames(P2), ['mcp__other__beta']);
});

void test('D2 (Q4): a runtime/v2.Watch failing internal is logged at warn and opened again after 5 s; deactivate cancels it', async (t) => {
  const world = await activated(t);
  await eventually(() => world.watches.length === 1, 'runtime/v2.Watch open');
  const [first] = world.watches;
  assert.ok(first !== undefined);

  first.fail(new ContractError('internal', 'The runtime went away.'));

  await eventually(
    () => world.logs.some(({ level }) => level === 'warn'),
    'the failure logged',
    () => world.logs,
  );
  await sleep(REOPEN_MS - 1_000);
  assert.equal(world.watches.length, 1, 'opened again too early');
  await eventually(
    () => world.watches.length === 2,
    'runtime/v2.Watch opened again',
    () => world.watches.length,
    REOPEN_MS,
  );

  await world.deactivate();

  await eventually(
    () => world.watches[1]?.signal.aborted === true,
    'the stream cancelled',
  );
  await sleep(REOPEN_MS + 500);
  assert.equal(world.watches.length, 2, 'nothing opened after deactivate');
});
