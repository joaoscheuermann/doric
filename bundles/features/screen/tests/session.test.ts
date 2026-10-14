// The session manager through its public boundary (`ensure` over a sandbox):
// a first start, reuse, marker recovery, restart of a stale session, port
// conflicts, a missing xpra and the pure helpers around them.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { Log } from 'bundle/contracts';

import {
  createScreenSessionManager,
  SCREEN_LOG_PATH,
  SCREEN_MARKER_PATH,
  ScreenSessionError,
  screenDisplay,
  screenDisplays,
  screenHost,
  screenPortTaken,
  screenStartCommand,
  type ScreenSessionsOptions,
} from '../src/host/session.js';
import { fakeProbe, fakeSandbox, type FakeSandboxState } from './support/sandbox.js';

const quietLog = (): Log =>
  ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }) as unknown as Log;

const managerOver = (state: FakeSandboxState, extra: Partial<ScreenSessionsOptions> = {}) => {
  let clock = 0;

  return createScreenSessionManager({
    log: () => quietLog(),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    portOpen: fakeProbe(state),
    ...extra,
  });
};

const startCommands = (state: FakeSandboxState) =>
  state.commands.filter((cmd) => cmd[0] === 'xpra' && cmd[1] === 'start');

test('a fresh sandbox starts a session, records the marker and answers its address', async () => {
  const { sandbox, state } = fakeSandbox();
  const session = await managerOver(state).ensure(sandbox);

  assert.equal(session.display, 100);
  assert.equal(session.port, 14500);
  assert.equal(session.host, '172.17.0.2');
  assert.ok(session.token.length > 0);

  const started = startCommands(state);
  assert.equal(started.length, 1);
  assert.deepEqual(started[0], [
    'xpra',
    'start',
    ':100',
    '--html=on',
    '--bind-tcp=0.0.0.0:14500',
    '--daemon=yes',
    `--log-file=${SCREEN_LOG_PATH}`,
  ]);

  const marker = JSON.parse(state.files.get(SCREEN_MARKER_PATH) ?? '{}') as Record<string, unknown>;
  assert.equal(marker.display, 100);
  assert.equal(marker.port, 14500);
  assert.equal(marker.token, session.token);
});

test('a live session the marker names is reused without a second start', async () => {
  const { sandbox, state } = fakeSandbox();
  const manager = managerOver(state);
  const first = await manager.ensure(sandbox);
  const second = await manager.ensure(sandbox);

  assert.equal(startCommands(state).length, 1);
  assert.equal(second.token, first.token);
  assert.equal(second.port, first.port);
});

test('a marker found by a respawned manager recovers the same session', async () => {
  const { sandbox, state } = fakeSandbox();
  const first = await managerOver(state).ensure(sandbox);
  const recovered = await managerOver(state).ensure(sandbox);

  assert.equal(startCommands(state).length, 1);
  assert.deepEqual(recovered, first);
});

test('a marker whose display is gone restarts it, keeping the token', async () => {
  const { sandbox, state } = fakeSandbox();
  const first = await managerOver(state).ensure(sandbox);

  state.displays.delete(100);
  state.ports.set(14500, false);

  const restarted = await managerOver(state).ensure(sandbox);

  assert.equal(startCommands(state).length, 2);
  assert.equal(restarted.token, first.token);
  assert.equal(restarted.display, 100);
  assert.equal(restarted.port, 14500);
});

test('a live display whose port died is stopped before the restart', async () => {
  const { sandbox, state } = fakeSandbox();
  await managerOver(state).ensure(sandbox);

  state.ports.set(14500, false);
  // `xpra start` on the same, still-live display settles it again.
  state.onStart = (display, port) => {
    state.displays.add(display);

    return port === 14500;
  };

  const restarted = await managerOver(state).ensure(sandbox);

  assert.ok(
    state.commands.some((cmd) => cmd[0] === 'xpra' && cmd[1] === 'stop' && cmd[2] === ':100'),
  );
  assert.equal(restarted.port, 14500);
});

test('a foreign session on :100 pushes the new session to the next display', async () => {
  const { sandbox, state } = fakeSandbox();
  state.displays.add(100);

  const session = await managerOver(state).ensure(sandbox);

  assert.equal(session.display, 101);
  assert.equal(session.port, 14500);
});

test('a sandbox image without xpra reports the reason instead of starting', async () => {
  const { sandbox, state } = fakeSandbox({ xpra: false });

  await assert.rejects(
    managerOver(state).ensure(sandbox),
    (error: unknown) => error instanceof ScreenSessionError && error.reason === 'missing-xpra',
  );
  assert.equal(startCommands(state).length, 0);
});

test('a taken port is retried on the next candidate', async () => {
  const { sandbox, state } = fakeSandbox();
  state.startLog = 'xpra initialization error:\n failed to setup tcp socket on 0.0.0.0:14500 [Errno 98] Address already in use';
  state.onStart = (_display, port) => port === 14501;

  const session = await managerOver(state).ensure(sandbox);

  assert.equal(session.port, 14501);
  assert.deepEqual(
    startCommands(state).map((cmd) => cmd[4]),
    ['--bind-tcp=0.0.0.0:14500', '--bind-tcp=0.0.0.0:14501'],
  );
});

test('a start that never answers fails with start-failed and one attempt', async () => {
  const { sandbox, state } = fakeSandbox({ onStart: () => false, startLog: 'something else' });

  await assert.rejects(
    managerOver(state).ensure(sandbox),
    (error: unknown) => error instanceof ScreenSessionError && error.reason === 'start-failed',
  );
  assert.equal(startCommands(state).length, 1);
});

test('the pure helpers read xpra listings, pick displays and names', () => {
  assert.deepEqual(
    screenDisplays(
      '\nWarning: running as root\n/run/xpra:\n\tLIVE session at :99\n\tLIVE session at :100\n/root/.xpra:\n\tLIVE session at :100',
    ),
    [99, 100],
  );
  assert.deepEqual(screenDisplays('DEAD session at :99'), []);
  assert.equal(screenDisplay([]), 100);
  assert.equal(screenDisplay([100, 101, 103]), 102);
  assert.equal(screenHost('127.0.0.1 172.17.0.2 \n'), '172.17.0.2');
  assert.equal(screenHost('127.0.0.1 only here'), undefined);
  assert.ok(screenPortTaken('failed to setup tcp socket [Errno 98] Address already in use'));
  assert.ok(!screenPortTaken('xpra initialization error: something else'));
  assert.deepEqual(screenStartCommand({ display: 100, port: 14500 })[0], 'xpra');
});
