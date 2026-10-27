// stdio MCP servers run only in the Project's sandbox, through
// runtime.lease/v1.withLease and Sandbox.start: what the process receives,
// what the lease state means for it, and when it is stopped.

import assert from 'node:assert/strict';
import test from 'node:test';

import { opened } from './support/setup.js';
import { codeOf, eventually } from './support/wait.js';
import {
  createEnvironment,
  inState,
  P1,
  serverOf,
  stdioServer,
} from './support/world.js';

void test('S1 the process starts in the sandbox with the command, cwd and only the server entries, and its tools register', async (t) => {
  const world = await opened(t);
  const tokenId = world.env.addCredential('files-token', 'secret-s1');
  const created = await world.mcp(P1).create(
    stdioServer(
      'files',
      'node',
      ['server.js', '--stdio'],
      [
        { name: 'MODE', value: 'test' },
        { name: 'TOKEN', credentialId: tokenId },
      ],
      '/workspace/tools',
    ),
  );
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');
  const [process] = world.env.sandbox.started;

  assert.equal(world.env.sandbox.started.length, 1);

  assert.equal(process?.input.tty, false);

  assert.deepEqual(process?.input.cmd, ['node', 'server.js', '--stdio']);

  assert.equal(process?.input.cwd, '/workspace/tools');

  assert.deepEqual([...(process?.input.env ?? [])].sort(), [
    'MODE=test',
    'TOKEN=secret-s1',
  ]);

  assert.deepEqual([...new Set(world.env.leased)], [P1]);

  assert.deepEqual(world.liveNames(P1), ['mcp__files__echo']);

  assert.equal(
    await world
      .tool(P1, 'mcp__files__echo')
      .execute({ text: 'hi' }, world.promptCall(P1)),
    'echo: {"text":"hi"}',
  );
});

void test('S2 two stdio servers each get only their own environment', async (t) => {
  const world = await opened(t);
  const secretA = world.env.addCredential('a-token', 'secret-a');
  const a = await world.mcp(P1).create(
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
  const b = await world
    .mcp(P1)
    .create(
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
      ...(world.env.sandbox.started.find(
        (process) => process.input.cmd[0] === command,
      )?.input.env ?? []),
    ].sort();

  assert.deepEqual(envOf('first-mcp'), ['ONLY_A=a', 'SECRET_A=secret-a']);

  assert.deepEqual(envOf('second-mcp'), ['ONLY_B=b']);
});

for (const lease of ['pending', 'unavailable'] as const) {
  void test(`S3 a ${lease} lease leaves the server waiting for the sandbox without starting anything`, async (t) => {
    const env = createEnvironment();
    env.lease = lease;
    const world = await opened(t, env);
    const created = await world
      .mcp(P1)
      .create(stdioServer('files', 'files-mcp'));

    await world.watchUntil(
      P1,
      inState(created.id, 'waiting-for-sandbox'),
      'waiting-for-sandbox',
    );

    assert.equal(env.sandbox.started.length, 0);

    assert.deepEqual(world.liveNames(P1), []);
  });
}

for (const lease of ['missing', 'expired'] as const) {
  void test(`S3 a ${lease} Project leaves the server in error without starting anything`, async (t) => {
    const env = createEnvironment();
    env.lease = lease;
    const world = await opened(t, env);
    const created = await world
      .mcp(P1)
      .create(stdioServer('files', 'files-mcp'));

    const servers = await world.watchUntil(
      P1,
      inState(created.id, 'error'),
      'error',
    );

    assert.ok((serverOf(servers, created.id)?.status.message ?? '').length > 0);

    assert.equal(env.sandbox.started.length, 0);

    assert.deepEqual(world.liveNames(P1), []);
  });
}

void test('S3 a lease lost while the server started ends its process and leaves it waiting for the sandbox', async (t) => {
  const env = createEnvironment();
  env.lease = 'lost';
  const world = await opened(t, env);
  const created = await world.mcp(P1).create(stdioServer('files', 'files-mcp'));

  await world.watchUntil(
    P1,
    inState(created.id, 'waiting-for-sandbox'),
    'waiting-for-sandbox',
  );

  assert.ok(env.sandbox.started.length > 0);

  assert.ok(env.sandbox.started.every((process) => process.terminated));

  assert.deepEqual(world.liveNames(P1), []);
});

void test('S3 a server waiting for the sandbox connects when its Project is ready', async (t) => {
  const env = createEnvironment();
  env.lease = 'pending';
  const world = await opened(t, env);
  const created = await world.mcp(P1).create(stdioServer('files', 'files-mcp'));
  await world.watchUntil(
    P1,
    inState(created.id, 'waiting-for-sandbox'),
    'waiting-for-sandbox',
  );

  env.lease = 'ready';
  await world.projectReady(P1);

  // `list` never connects: only the Project's readiness did.
  await world.listUntil(P1, inState(created.id, 'connected'), 'connected');

  assert.deepEqual(world.liveNames(P1), ['mcp__files__echo']);
});

void test('S4 a sandbox that cannot start processes leaves the server in error', async (t) => {
  const world = await opened(
    t,
    createEnvironment({ sandbox: { start: false } }),
  );
  const created = await world.mcp(P1).create(stdioServer('files', 'files-mcp'));

  const servers = await world.watchUntil(
    P1,
    inState(created.id, 'error'),
    'error',
  );

  assert.ok((serverOf(servers, created.id)?.status.message ?? '').length > 0);

  assert.deepEqual(world.liveNames(P1), []);
});

void test('S5 a process that exits disposes its tools and reports an error that names no secret', async (t) => {
  const world = await opened(t);
  const tokenId = world.env.addCredential('files-token', 'secret-s5-value');
  const created = await world
    .mcp(P1)
    .create(
      stdioServer(
        'files',
        'files-mcp',
        [],
        [{ name: 'TOKEN', credentialId: tokenId }],
      ),
    );
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');

  await world.env.sandbox.started[0]?.exit(
    1,
    'fatal: token secret-s5-value was refused\n',
  );

  await eventually(
    () => world.liveNames(P1).length === 0,
    'the tools disposed',
    () => world.liveNames(P1),
  );
  const servers = await world.listUntil(
    P1,
    inState(created.id, 'error'),
    'error',
  );

  assert.ok(
    !(serverOf(servers, created.id)?.status.message ?? '').includes(
      'secret-s5-value',
    ),
  );
});

void test('S6 remove terminates the server process', async (t) => {
  const world = await opened(t);
  const created = await world.mcp(P1).create(stdioServer('files', 'files-mcp'));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');

  await world.mcp(P1).remove({ id: created.id });

  await eventually(
    () => world.env.sandbox.started[0]?.terminated === true,
    'the process terminated',
  );

  assert.deepEqual(world.liveNames(P1), []);
});

void test('S6 update terminates the old process and starts the new one', async (t) => {
  const world = await opened(t);
  const created = await world.mcp(P1).create(stdioServer('files', 'files-mcp'));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');

  await world.mcp(P1).update({
    id: created.id,
    ...stdioServer('files', 'files-mcp', ['--verbose']),
  });

  await eventually(
    () => world.env.sandbox.started[0]?.terminated === true,
    'the old process terminated',
  );
  await world.watchUntil(P1, inState(created.id, 'connected'), 'reconnected');

  assert.deepEqual(world.env.sandbox.started.at(-1)?.input.cmd, [
    'files-mcp',
    '--verbose',
  ]);
});

void test('S6 disabling terminates the server process', async (t) => {
  const world = await opened(t);
  const created = await world.mcp(P1).create(stdioServer('files', 'files-mcp'));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');

  const updated = await world.mcp(P1).update({
    id: created.id,
    ...stdioServer('files', 'files-mcp'),
    enabled: false,
  });

  assert.equal(updated.status.state, 'disabled');

  await eventually(
    () => world.env.sandbox.started[0]?.terminated === true,
    'the process terminated',
  );

  assert.deepEqual(world.liveNames(P1), []);
});

void test('S7 signIn on a stdio server is refused as unsupported', async (t) => {
  const world = await opened(t);
  const created = await world.mcp(P1).create(stdioServer('files', 'files-mcp'));

  await assert.rejects(
    world.mcp(P1).signIn({ id: created.id }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'mcp_signin_unsupported');
      return true;
    },
  );

  assert.equal(created.signedIn, false);
});
