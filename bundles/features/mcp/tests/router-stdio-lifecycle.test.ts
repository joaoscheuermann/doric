// stdio MCP servers over the router (S68c, X3): what `stdio.test.ts` tested on
// the kernel entry and the router suites S1–S5 and M8 do not already cover.
// What each process receives, what a lease status means for it, and when it
// is stopped.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ContractError } from 'bundle/contracts';

import { textTool, toolServer } from './support/mcp-server.js';
import { activated, inState, P1 } from './support/router.js';
import { eventually } from './support/wait.js';
import { stdioServer } from './support/world.js';

const leaseFailure = (leaseStatus: string): ContractError =>
  new ContractError('unavailable', `The lease is ${leaseStatus}.`, {
    leaseStatus,
  });

void test('S2 two stdio servers each get only their own environment', async (t) => {
  const world = await activated(t);
  const secretA = world.addCredential('a-token', 'secret-a');
  const a = await world.create(
    P1,
    stdioServer(
      'first',
      'first-mcp',
      [],
      [
        { name: 'ONLY_A', value: 'a' },
        { name: 'SECRET_A', credentialId: secretA },
      ],
    ),
  );
  const b = await world.create(
    P1,
    stdioServer('second', 'second-mcp', [], [{ name: 'ONLY_B', value: 'b' }]),
  );
  await world.watchUntil(
    P1,
    (servers) =>
      inState(a.id, 'connected')(servers) &&
      inState(b.id, 'connected')(servers),
    'both connected',
  );
  const envOf = (command: string) =>
    [
      ...(world.starts.find((start) => start.head.request.cmd[0] === command)
        ?.head.request.env ?? []),
    ].sort();

  assert.deepEqual(envOf('first-mcp'), ['ONLY_A=a', 'SECRET_A=secret-a']);
  assert.deepEqual(envOf('second-mcp'), ['ONLY_B=b']);
});

void test('S3 an unavailable lease leaves the server waiting for the sandbox without starting anything', async (t) => {
  const world = await activated(t);
  world.describe = leaseFailure('unavailable');
  const created = await world.create(P1, stdioServer('files', 'files-mcp'));

  await world.watchUntil(
    P1,
    inState(created.id, 'waiting-for-sandbox'),
    'waiting-for-sandbox',
  );

  assert.deepEqual(world.starts, []);
  assert.deepEqual(world.liveNames(P1), []);
});

void test('S3 a lease lost while the server starts leaves it waiting for the sandbox, with no process running', async (t) => {
  const world = await activated(t);
  world.startError = leaseFailure('pending');
  const created = await world.create(P1, stdioServer('files', 'files-mcp'));

  await world.watchUntil(
    P1,
    inState(created.id, 'waiting-for-sandbox'),
    'waiting-for-sandbox',
  );

  assert.ok(world.callsOf('lease.start').length > 0, 'Start was opened');
  assert.ok(world.sandbox.started.every((process) => process.terminated));
  assert.deepEqual(world.liveNames(P1), []);
});

void test('S6 update terminates the old process and starts the new one', async (t) => {
  const world = await activated(t);
  const created = await world.create(P1, stdioServer('files', 'files-mcp'));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');
  const [old] = world.starts;
  assert.ok(old !== undefined);

  await world.update(
    P1,
    created.id,
    stdioServer('files', 'files-mcp', ['--verbose']),
  );

  await eventually(
    () => old.signal.aborted && old.process.terminated,
    'the old process terminated',
  );
  await world.watchUntil(P1, inState(created.id, 'connected'), 'reconnected');
  assert.deepEqual(world.starts.at(-1)?.head.request.cmd, [
    'files-mcp',
    '--verbose',
  ]);
});

void test('S6 disabling terminates the server process', async (t) => {
  const world = await activated(t);
  const created = await world.create(P1, stdioServer('files', 'files-mcp'));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');
  const [start] = world.starts;
  assert.ok(start !== undefined);

  const updated = await world.update(P1, created.id, {
    ...stdioServer('files', 'files-mcp'),
    enabled: false,
  });

  assert.equal(updated.status.state, 'disabled');
  await eventually(() => start.process.terminated, 'the process terminated');
  await eventually(
    () => world.liveNames(P1).length === 0,
    'the tool unregistered',
    () => world.registrations,
  );
});

void test('S9 a stdio server is told the client info its transport names', async (t) => {
  const tools = toolServer([textTool('echo')]);
  const world = await activated(t, { sandbox: { serverFor: () => tools } });
  const input = stdioServer('files', 'files-mcp');
  const created = await world.create(P1, {
    ...input,
    transport: {
      ...input.transport,
      clientInfo: { name: 'claude-code', version: '2.1.0' },
    },
  });
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');

  assert.deepEqual(tools.clientInfo(), {
    name: 'claude-code',
    version: '2.1.0',
  });
});
