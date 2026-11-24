// S1–S5 (phase 3, S59c): stdio servers over `runtime.lease/v1` (D4, Q7). A
// stdio server describes the Project's current lease (`Describe{target {}}`)
// and runs its command through `Start` with the head `{target
// {expectSandboxId}, request {cmd, cwd?, env, tty false}}`, both scoped to
// the Project only; lease statuses read as today; `Remove` and
// `onProjectClosingHook` cancel the `Start` stream; a process ending on its own
// leaves the server in error with its last stderr line, masked.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ContractError } from 'bundle/contracts';

import {
  activated,
  inState,
  P1,
  SANDBOX_ID,
  serverOf,
} from './support/router.js';
import { eventually } from './support/wait.js';
import { stdioServer } from './support/world.js';

const UNSUPPORTED =
  'The Project sandbox cannot keep a process running, so it cannot run a stdio MCP server.';
const MISSING =
  'The Project no longer exists, so its stdio MCP server cannot start.';
const EXPIRED =
  'The Project has ended, so its sandbox cannot run a stdio MCP server.';

const leaseFailure = (leaseStatus: string): ContractError =>
  new ContractError('unavailable', `The lease is ${leaseStatus}.`, {
    leaseStatus,
  });

void test("S1 (Q7): an enabled stdio server describes the Project's lease, then Starts its command with the head {target {expectSandboxId}, request {cmd, cwd, env, tty false}}, both scoped to {projectId}; it connects and its tool works", async (t) => {
  const world = await activated(t);
  const token = world.addCredential('files-token', 'secret-s1');
  const created = await world.create(
    P1,
    stdioServer(
      'files',
      'node',
      ['server.js', '--stdio'],
      [
        { name: 'MODE', value: 'test' },
        { name: 'TOKEN', credentialId: token },
      ],
      '/workspace/tools',
    ),
  );

  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');

  const [describe] = world.callsOf('lease.describe');
  assert.deepEqual(describe?.request, { target: {} });
  assert.deepEqual(describe?.scope, { projectId: P1 });
  const [start] = world.starts;
  assert.ok(start !== undefined, 'Start was opened');
  assert.deepEqual(
    {
      ...start.head,
      request: {
        ...start.head.request,
        env: [...start.head.request.env].sort(),
      },
    },
    {
      target: { expectSandboxId: SANDBOX_ID },
      request: {
        cmd: ['node', 'server.js', '--stdio'],
        cwd: '/workspace/tools',
        env: ['MODE=test', 'TOKEN=secret-s1'],
        tty: false,
      },
    },
  );
  assert.deepEqual(start.scope, { projectId: P1 });
  assert.equal(start.deadline, 0);
  assert.equal(world.starts.length, 1);
  await eventually(
    () => world.liveNames(P1).join() === 'mcp__files__echo',
    'the tool registered',
    () => world.registrations,
  );
  assert.equal(
    await world.execute('mcp__files__echo', P1, { text: 'hi' }),
    'echo: {"text":"hi"}',
  );
});

void test('S2: Describe failing unavailable {leaseStatus pending} leaves the server waiting-for-sandbox without a Start; onProjectReadyHook then retries it and it connects', async (t) => {
  const world = await activated(t);
  world.describe = leaseFailure('pending');
  const created = await world.create(P1, stdioServer('files', 'node'));

  await world.watchUntil(
    P1,
    inState(created.id, 'waiting-for-sandbox'),
    'waiting-for-sandbox',
  );
  assert.deepEqual(world.starts, []);

  world.describe = { id: SANDBOX_ID, root: '/workspace' };
  await world.projectReady(P1);

  await eventually(
    async () => inState(created.id, 'connected')(await world.list(P1)),
    'connected once the Project is ready',
  );
  assert.equal(world.starts.length, 1);
});

for (const [label, arrange, message] of [
  [
    'Start failing unsupported_operation',
    (world: Awaited<ReturnType<typeof activated>>) => {
      world.startError = new ContractError(
        'unsupported_operation',
        'The sandbox cannot keep a process running.',
      );
    },
    UNSUPPORTED,
  ],
  [
    'a missing Project',
    (world: Awaited<ReturnType<typeof activated>>) => {
      world.describe = leaseFailure('missing');
    },
    MISSING,
  ],
  [
    'an expired Project',
    (world: Awaited<ReturnType<typeof activated>>) => {
      world.describe = leaseFailure('expired');
    },
    EXPIRED,
  ],
] as const) {
  void test(`S3: ${label} leaves the server in error with today's text`, async (t) => {
    const world = await activated(t);
    arrange(world);
    const created = await world.create(P1, stdioServer('files', 'node'));

    const servers = await world.watchUntil(
      P1,
      inState(created.id, 'error'),
      'error',
    );

    assert.equal(serverOf(servers, created.id)?.status.message, message);
    assert.deepEqual(world.liveNames(P1), []);
  });
}

void test('S4: Remove cancels the Start stream, which terminates the process, and unregisters its tools', async (t) => {
  const world = await activated(t);
  const created = await world.create(P1, stdioServer('files', 'node'));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');
  await eventually(
    () => world.liveNames(P1).length === 1,
    'the tool registered',
  );
  const [start] = world.starts;
  assert.ok(start !== undefined);

  await world.mcp(P1).remove({ id: created.id });

  await eventually(
    () => start.signal.aborted && start.process.terminated,
    'the Start stream cancelled and the process terminated',
  );
  await eventually(
    () => world.liveNames(P1).length === 0,
    'the tool unregistered',
    () => world.registrations,
  );
});

void test('S4: onProjectClosingHook cancels the Start stream, which terminates the process, and unregisters its tools', async (t) => {
  const world = await activated(t);
  const created = await world.create(P1, stdioServer('files', 'node'));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');
  await eventually(
    () => world.liveNames(P1).length === 1,
    'the tool registered',
  );
  const [start] = world.starts;
  assert.ok(start !== undefined);

  await world.projectClosing(P1);

  assert.ok(start.signal.aborted, 'the Start stream is cancelled');
  await eventually(() => start.process.terminated, 'the process terminated');
  await eventually(
    () => world.liveNames(P1).length === 0,
    'the tool unregistered',
    () => world.registrations,
  );
});

void test('S5: a process that exits on its own leaves the server in error "The MCP server closed the connection: <last stderr line>", its secret masked', async (t) => {
  const world = await activated(t);
  const token = world.addCredential('files-token', 'secret-s5-value');
  const created = await world.create(
    P1,
    stdioServer(
      'files',
      'files-mcp',
      [],
      [{ name: 'TOKEN', credentialId: token }],
    ),
  );
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');
  const [start] = world.starts;
  assert.ok(start !== undefined);

  await start.process.exit(1, 'fatal: token secret-s5-value was refused\n');

  // List never connects, so the server is not started again meanwhile.
  let servers = await world.list(P1);
  await eventually(
    async () => {
      servers = await world.list(P1);
      return inState(created.id, 'error')(servers);
    },
    'error',
    () => servers,
  );
  assert.equal(
    serverOf(servers, created.id)?.status.message,
    'The MCP server closed the connection: fatal: token [REDACTED] was refused',
  );
  await eventually(
    () => world.liveNames(P1).length === 0,
    'the tool unregistered',
    () => world.registrations,
  );
});
