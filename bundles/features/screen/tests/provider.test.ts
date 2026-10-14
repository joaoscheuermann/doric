// `screen.sessions/v1` through the sessions owner: lease states map to the
// contract's answer, a session is published on the relay, tokens are replaced
// cleanly, and concurrent attaches share one ensure.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { Log } from 'bundle/contracts';
import type { LeaseOutcome, RuntimeLease } from 'runtime/contracts';

import type { ScreenRelay, ScreenRelayTarget } from '../src/host/relay.js';
import { createScreenSessions } from '../src/host/provider.js';
import { type ScreenSession, ScreenSessionError } from '../src/host/session.js';

const quietLog = (): Log =>
  ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }) as unknown as Log;

const session = (token: string): ScreenSession => ({
  token,
  display: 100,
  port: 14500,
  host: '172.17.0.2',
});

const leaseOf = (outcome: LeaseOutcome<ScreenSession>, onTask?: () => void): RuntimeLease =>
  ({
    withLease: async (task: (sandbox: unknown) => Promise<ScreenSession>) => {
      if (outcome.status !== 'ready') {
        return outcome;
      }

      onTask?.();
      const sandbox = {};

      return { status: 'ready' as const, value: await task(sandbox) };
    },
  }) as unknown as RuntimeLease;

const relayOf = () => {
  const exposed = new Map<string, ScreenRelayTarget>();
  const forgotten: string[] = [];
  const relay: ScreenRelay = {
    origin: 'http://127.0.0.1:5555',
    expose: (token, target) => {
      exposed.set(token, target);
    },
    forget: (token) => {
      forgotten.push(token);
      exposed.delete(token);
    },
    dispose: async () => undefined,
  };

  return { relay, exposed, forgotten };
};

test('a lease still coming up answers pending and opens no relay', async () => {
  const fake = relayOf();
  let relays = 0;
  const sessions = createScreenSessions({
    log: () => quietLog(),
    relay: async () => {
      relays += 1;

      return fake.relay;
    },
    manager: () => ({ ensure: async () => session('token-1') }),
  });

  const answer = await sessions.attach({
    projectId: 'p1',
    lease: leaseOf({ status: 'pending' }),
  });

  assert.deepEqual(answer, { status: 'pending' });
  assert.equal(relays, 0);
});

test('a lease that cannot run answers unavailable', async () => {
  const fake = relayOf();
  let ensures = 0;
  const sessions = createScreenSessions({
    log: () => quietLog(),
    relay: async () => fake.relay,
    manager: () => ({
      ensure: async () => {
        ensures += 1;

        return session('token-1');
      },
    }),
  });

  for (const status of ['unavailable', 'expired', 'missing'] as const) {
    const answer = await sessions.attach({
      projectId: 'p1',
      lease: leaseOf({ status }),
    });

    assert.deepEqual(answer, { status: 'unavailable', reason: 'sandbox' });
  }

  assert.equal(ensures, 0, 'the ensure task never ran');
});

test('an image without xpra answers the missing-xpra reason', async () => {
  const fake = relayOf();
  const sessions = createScreenSessions({
    log: () => quietLog(),
    relay: async () => fake.relay,
    manager: () => ({
      ensure: async () => {
        throw new ScreenSessionError('missing-xpra');
      },
    }),
  });

  const answer = await sessions.attach({
    projectId: 'p1',
    lease: leaseOf({ status: 'ready', value: session('token-1') }),
  });

  assert.deepEqual(answer, { status: 'unavailable', reason: 'missing-xpra' });
});

test('a live session answers its relay URL and publishes the upstream', async () => {
  const fake = relayOf();
  const sessions = createScreenSessions({
    log: () => quietLog(),
    relay: async () => fake.relay,
    manager: () => ({ ensure: async () => session('token-1') }),
  });

  let tasks = 0;
  const answer = await sessions.attach({
    projectId: 'p1',
    lease: leaseOf({ status: 'ready', value: session('token-1') }, () => {
      tasks += 1;
    }),
  });

  assert.deepEqual(answer, {
    status: 'ready',
    url: 'http://127.0.0.1:5555/screen/token-1/',
    display: ':100',
  });
  assert.deepEqual(fake.exposed.get('token-1'), {
    host: '172.17.0.2',
    port: 14500,
  });
  assert.equal(tasks, 1);
});

test('a replaced session forgets the token it replaced', async () => {
  const fake = relayOf();
  let token = 'token-1';
  const sessions = createScreenSessions({
    log: () => quietLog(),
    relay: async () => fake.relay,
    manager: () => ({ ensure: async () => session(token) }),
  });

  const lease = () => leaseOf({ status: 'ready', value: session(token) });

  await sessions.attach({ projectId: 'p1', lease: lease() });
  token = 'token-2';
  const second = await sessions.attach({ projectId: 'p1', lease: lease() });

  assert.deepEqual(second, {
    status: 'ready',
    url: 'http://127.0.0.1:5555/screen/token-2/',
    display: ':100',
  });
  assert.deepEqual(fake.forgotten, ['token-1']);
  assert.equal(fake.exposed.has('token-1'), false);
});

test('concurrent attaches share one ensure', async () => {
  const fake = relayOf();
  let ensures = 0;
  let release: ((value: ScreenSession) => void) | undefined;
  const gate = new Promise<ScreenSession>((resolve) => {
    release = resolve;
  });
  const sessions = createScreenSessions({
    log: () => quietLog(),
    relay: async () => fake.relay,
    manager: () => ({
      ensure: async () => {
        ensures += 1;

        return gate;
      },
    }),
  });

  const input = {
    projectId: 'p1',
    lease: leaseOf({ status: 'ready', value: session('token-1') }),
  };
  const first = sessions.attach(input);
  const second = sessions.attach(input);

  release?.(session('token-1'));

  const [one, two] = await Promise.all([first, second]);

  assert.equal(ensures, 1);
  assert.deepEqual(one, two);
  assert.equal(one.status, 'ready');
});

test('a failure that is not a screen session failure reaches the caller', async () => {
  const sessions = createScreenSessions({
    log: () => quietLog(),
    manager: () => ({
      ensure: async () => {
        throw new Error('boom');
      },
    }),
  });

  await assert.rejects(
    sessions.attach({
      projectId: 'p1',
      lease: leaseOf({ status: 'ready', value: session('token-1') }),
    }),
    /boom/,
  );
});
