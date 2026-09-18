import assert from 'node:assert/strict';
import test from 'node:test';

import pino from 'pino';

import type { SandboxSession } from 'sandbox';

import { createSandpool } from '../src/index.js';

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
};

type Fake = {
  readonly session: SandboxSession;
  readonly disposals: () => number;
};

const logger = pino({ enabled: false });

test('validates pool limits synchronously', () => {
  const create = async () => fake('unused').session;

  for (const minIdle of [-1, 0.5, Number.NaN]) {
    assert.throws(() =>
      createSandpool({ minIdle, maxSandboxes: 1, create, logger }),
    );
  }

  for (const maxSandboxes of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(() =>
      createSandpool({ minIdle: 0, maxSandboxes, create, logger }),
    );
  }

  assert.throws(() =>
    createSandpool({ minIdle: 2, maxSandboxes: 1, create, logger }),
  );

  for (const maxCreateAttempts of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(() =>
      createSandpool({
        minIdle: 0,
        maxSandboxes: 1,
        maxCreateAttempts,
        create,
        logger,
      }),
    );
  }
});

test('returns synchronously and warms the minimum idle sessions in parallel', async () => {
  const creations = [deferred<SandboxSession>(), deferred<SandboxSession>()];
  let calls = 0;

  const pool = createSandpool({
    minIdle: 2,
    maxSandboxes: 2,
    logger,
    create: () =>
      creations[calls++]?.promise ?? Promise.reject(new Error('extra')),
  });

  assert.equal(calls, 2);

  assert.deepEqual(pool.status(), {
    lifecycle: 'active',
    idle: 0,
    leased: 0,
    creating: 2,
    disposing: 0,
    queued: 0,
    total: 2,
    heated: false,
    lastFailure: undefined,
  });

  creations[0]?.resolve(fake('one').session);

  creations[1]?.resolve(fake('two').session);

  await pool.waitUntilHeated();

  assert.equal(pool.status().idle, 2);

  await pool.dispose();
});

test('serves acquisitions in FIFO order without exceeding capacity', async () => {
  let id = 0;

  const pool = createSandpool({
    minIdle: 0,
    maxSandboxes: 1,
    logger,
    create: async () => fake(String(++id)).session,
  });
  const firstPromise = pool.acquire();
  const secondPromise = pool.acquire();
  const thirdPromise = pool.acquire();
  const first = await firstPromise;

  assert.equal(pool.status().total, 1);

  assert.equal(first.sandbox.id, '1');

  await first.release();

  const second = await secondPromise;

  assert.equal(second.sandbox.id, '2');

  await second.release();

  const third = await thirdPromise;

  assert.equal(third.sandbox.id, '3');

  await third.release();

  await pool.dispose();
});

test('cancels queued acquisitions and heat waiters', async () => {
  const creation = deferred<SandboxSession>();

  const pool = createSandpool({
    minIdle: 1,
    maxSandboxes: 1,
    logger,
    create: () => creation.promise,
  });
  const acquireController = new AbortController();
  const heatController = new AbortController();
  const acquisition = pool.acquire({ signal: acquireController.signal });
  const heating = pool.waitUntilHeated({ signal: heatController.signal });

  acquireController.abort();

  heatController.abort();

  await assert.rejects(acquisition, { name: 'AbortError' });

  await assert.rejects(heating, { name: 'AbortError' });

  assert.equal(pool.status().queued, 0);

  const disposal = pool.dispose();
  const created = fake('late');

  creation.resolve(created.session);

  await disposal;

  assert.equal(created.disposals(), 1);
});

test('release is idempotent, invalidates the lease, and replaces with a new session', async () => {
  const sessions: Fake[] = [];

  const pool = createSandpool({
    minIdle: 1,
    maxSandboxes: 1,
    logger,
    create: async () => {
      const created = fake(String(sessions.length + 1));

      sessions.push(created);

      return created.session;
    },
  });

  await pool.waitUntilHeated();

  const first = await pool.acquire();

  assert.equal('dispose' in first.sandbox, false);

  assert.equal(await first.sandbox.ssh(), undefined);

  const releaseOne = first.release();
  const releaseTwo = first.release();

  assert.equal(releaseOne, releaseTwo);

  await assert.rejects(
    () => first.sandbox.readFile('anything'),
    /no longer active/u,
  );

  await assert.rejects(first.sandbox.ssh(), /no longer active/u);

  await releaseOne;

  await pool.waitUntilHeated();

  const second = await pool.acquire();

  assert.notEqual(second.sandbox.id, first.sandbox.id);

  assert.equal(sessions[0]?.disposals(), 1);

  await second.release();

  await pool.dispose();
});

test('retries transient creation failures and preserves the last failure', async () => {
  const failure = new Error('factory unavailable');
  let attempts = 0;

  const pool = createSandpool({
    minIdle: 1,
    maxSandboxes: 1,
    logger,
    create: async () => {
      attempts += 1;

      if (attempts === 1) {
        throw failure;
      }

      return fake('recovered').session;
    },
  });

  await pool.waitUntilHeated();

  assert.equal(attempts, 2);

  assert.equal(pool.status().lastFailure, failure);

  await pool.dispose();
});

test('rejects pending acquisitions after the creation limit and allows a later retry batch', async () => {
  const failure = new Error('factory unavailable');
  let attempts = 0;

  const pool = createSandpool({
    minIdle: 1,
    maxSandboxes: 2,
    maxCreateAttempts: 3,
    logger,
    create: async () => {
      attempts += 1;

      if (attempts <= 3) {
        throw failure;
      }

      return fake(`recovered-${String(attempts)}`).session;
    },
  });
  const acquisition = pool.acquire();
  const heating = pool.waitUntilHeated();

  await assert.rejects(acquisition, /after 3 attempts/u);

  await assert.rejects(heating, /after 3 attempts/u);

  assert.equal(attempts, 3);

  assert.equal(pool.status().queued, 0);

  assert.equal(pool.status().lastFailure, failure);

  const recovered = await pool.acquire();

  assert.equal(attempts, 5);

  assert.match(recovered.sandbox.id, /^recovered-[45]$/u);

  await recovered.release();

  await pool.dispose();
});

test('counts disposal until a transient disposal failure recovers', async () => {
  let attempts = 0;

  const created = fake('retry-dispose', async () => {
    attempts += 1;

    if (attempts === 1) {
      throw new Error('busy');
    }
  });

  const pool = createSandpool({
    minIdle: 0,
    maxSandboxes: 1,
    logger,
    create: async () => created.session,
  });
  const lease = await pool.acquire();
  const release = lease.release();

  assert.equal(pool.status().disposing, 1);

  assert.equal(pool.status().total, 1);

  await release;

  assert.equal(attempts, 2);

  assert.equal(pool.status().total, 0);

  assert.match(String(pool.status().lastFailure), /busy/u);

  await pool.dispose();
});

test('dispose rejects waits, invalidates leases, and waits for pending factories', async () => {
  const pending = deferred<SandboxSession>();
  const first = fake('leased');
  let calls = 0;

  const pool = createSandpool({
    minIdle: 1,
    maxSandboxes: 2,
    logger,
    create: () =>
      calls++ === 0 ? Promise.resolve(first.session) : pending.promise,
  });

  await pool.waitUntilHeated();

  const lease = await pool.acquire();
  const queued = pool.acquire();
  const heating = pool.waitUntilHeated();
  const disposal = pool.dispose();

  assert.equal(disposal, pool.dispose());

  await assert.rejects(queued, /disposing/u);

  await assert.rejects(heating, /disposing/u);

  await assert.rejects(() => lease.sandbox.diff(), /no longer active/u);

  const late = fake('late');

  pending.resolve(late.session);

  await disposal;

  assert.equal(first.disposals(), 1);

  assert.equal(late.disposals(), 1);

  assert.equal(pool.status().lifecycle, 'disposed');

  await assert.rejects(() => pool.acquire(), /not active/u);
});

const fake = (
  id: string,
  dispose: () => Promise<void> = async () => undefined,
): Fake => {
  let count = 0;

  const unsupported = async (): Promise<never> => {
    throw new Error('not implemented by fake');
  };

  const session: SandboxSession = {
    id,
    root: '/workspace',
    exec: unsupported,
    cloneRepo: unsupported,
    readFile: unsupported,
    writeFile: unsupported,
    putFile: unsupported,
    getFile: unsupported,
    diff: async () => '',
    ssh: async () => undefined,
    dispose: async () => {
      count += 1;

      await dispose();
    },
  };

  return { session, disposals: () => count };
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;

    reject = rejectPromise;
  });

  return { promise, resolve, reject };
};
