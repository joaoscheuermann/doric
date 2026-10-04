import assert from 'node:assert/strict';
import test from 'node:test';

import pino from 'pino';

import type { SandboxSession } from 'sandbox';

import { createSandpool } from '../src/index.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
}

interface Fake {
  readonly session: SandboxSession;
  readonly disposals: () => number;
}

const logger = pino({ enabled: false });

void test('validates pool limits synchronously', () => {
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

void test('returns synchronously and warms the minimum idle sessions in parallel', async () => {
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

void test('serves acquisitions in FIFO order without exceeding capacity', async () => {
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

void test('provisions each identified acquisition its own session', async () => {
  const created: (string | undefined)[] = [];
  let warm = 0;

  const pool = createSandpool({
    minIdle: 1,
    maxSandboxes: 3,
    logger,
    create: async (identity) => {
      created.push(identity);

      return fake(
        identity === undefined
          ? `warm-${String((warm += 1))}`
          : `${identity}-${String(created.length)}`,
      ).session;
    },
  });

  await pool.waitUntilHeated();

  const idle = pool.status().idle;

  assert.ok(idle >= 1);

  const first = await pool.acquire({ identity: 'project-a' });

  assert.match(first.sandbox.id, /^project-a-/u);

  assert.equal(pool.status().idle, idle);

  await first.release();

  const second = await pool.acquire({ identity: 'project-a' });

  assert.match(second.sandbox.id, /^project-a-/u);

  assert.notEqual(second.sandbox.id, first.sandbox.id);

  assert.equal(pool.status().idle, idle);

  // The warmed sessions stay reserved for callers that name no identity.
  const unnamed = await pool.acquire();

  assert.match(unnamed.sandbox.id, /^warm-/u);

  await unnamed.release();

  await second.release();

  await pool.dispose();
});

void test('serves an acquisition without an identity from an idle session', async () => {
  let created = 0;

  const pool = createSandpool({
    minIdle: 1,
    maxSandboxes: 3,
    logger,
    create: async () => fake(`warm-${String((created += 1))}`).session,
  });

  await pool.waitUntilHeated();

  const idle = pool.status().idle;

  const lease = await pool.acquire();

  assert.match(lease.sandbox.id, /^warm-/u);

  assert.equal(pool.status().idle, idle - 1);

  assert.equal(created, idle);

  assert.equal(pool.status().total, idle);

  await lease.release();

  await pool.dispose();
});

void test('provisions mixed acquisitions in queue order within capacity', async () => {
  const identities: (string | undefined)[] = [];
  const creations: Deferred<SandboxSession>[] = [];

  const pool = createSandpool({
    minIdle: 0,
    maxSandboxes: 2,
    logger,
    create: (identity) => {
      identities.push(identity);

      const creation = deferred<SandboxSession>();

      creations.push(creation);

      return creation.promise;
    },
  });

  const identified = pool.acquire({ identity: 'project-a' });
  const unnamed = pool.acquire();
  const later = pool.acquire({ identity: 'project-c' });

  // Two sessions fit, so the first two callers are provisioned in queue order.
  assert.deepEqual(identities, ['project-a', undefined]);

  creations[0]?.resolve(fake('session-a').session);

  const first = await identified;

  assert.equal(first.sandbox.id, 'session-a');

  assert.equal(pool.status().total, 2);

  creations[1]?.resolve(fake('session-b').session);

  const second = await unnamed;

  assert.equal(second.sandbox.id, 'session-b');

  assert.deepEqual(identities, ['project-a', undefined]);

  await first.release();

  // The release frees the capacity the third caller was waiting for.
  assert.deepEqual(identities, ['project-a', undefined, 'project-c']);

  creations[2]?.resolve(fake('session-c').session);

  const third = await later;

  assert.equal(third.sandbox.id, 'session-c');

  assert.equal(pool.status().total, 2);

  await second.release();

  await third.release();

  await pool.dispose();
});

void test('counts failed identified creations toward the attempt batch', async () => {
  const failure = new Error('factory unavailable');
  let attempts = 0;

  const pool = createSandpool({
    minIdle: 0,
    maxSandboxes: 1,
    maxCreateAttempts: 2,
    logger,
    create: async () => {
      attempts += 1;

      if (attempts <= 2) {
        throw failure;
      }

      return fake(`recovered-${String(attempts)}`).session;
    },
  });

  await assert.rejects(
    pool.acquire({ identity: 'project-a' }),
    /after 2 attempts/u,
  );

  assert.equal(attempts, 2);

  assert.equal(pool.status().lastFailure, failure);

  const recovered = await pool.acquire({ identity: 'project-a' });

  assert.equal(recovered.sandbox.id, 'recovered-3');

  assert.equal(pool.status().queued, 0);

  await recovered.release();

  await pool.dispose();
});

void test('disposes a session whose identified caller cancelled the acquisition', async () => {
  const creation = deferred<SandboxSession>();
  const provisioned = fake('provisioned');

  const pool = createSandpool({
    minIdle: 0,
    maxSandboxes: 1,
    logger,
    create: () => creation.promise,
  });

  const controller = new AbortController();
  const acquisition = pool.acquire({
    identity: 'project-a',
    signal: controller.signal,
  });

  controller.abort();

  await assert.rejects(acquisition, { name: 'AbortError' });

  creation.resolve(provisioned.session);

  await settle();

  assert.equal(provisioned.disposals(), 1);

  assert.equal(pool.status().total, 0);

  await pool.dispose();
});

void test('cancels queued acquisitions and heat waiters', async () => {
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

void test('release is idempotent, invalidates the lease, and replaces with a new session', async () => {
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

void test('retries transient creation failures and preserves the last failure', async () => {
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

void test('rejects pending acquisitions after the creation limit and allows a later retry batch', async () => {
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

void test('counts disposal until a transient disposal failure recovers', async () => {
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

void test('dispose rejects waits, invalidates leases, and waits for pending factories', async () => {
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

const settle = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;

    reject = rejectPromise;
  });

  return { promise, resolve, reject };
};
