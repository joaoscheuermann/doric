import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderMessage } from 'llms';

import { defaultConfig } from '../src/lib/config.js';
import { createSessionService } from '../src/lib/session-service.js';
import type {
  Session,
  SessionEvent,
  SessionState,
  SessionStore,
} from '../src/lib/sessions.js';

test('uses one lease and executes simultaneous prompts in FIFO order', async () => {
  const harness = createHarness();
  let acquisitions = 0;
  let releases = 0;
  let unblockFirst: () => void = () => undefined;

  const firstGate = new Promise<void>((resolve) => {
    unblockFirst = resolve;
  });
  const calls: string[] = [];
  const sandboxes: string[] = [];

  const service = createSessionService({
    ...harness.dependencies,
    pool: {
      acquire: async () => {
        acquisitions += 1;

        return {
          sandbox,
          release: async () => {
            releases += 1;
          },
        };
      },
    } as never,
    execute: async ({ prompt }, lease) => {
      calls.push(prompt);

      sandboxes.push(lease.sandbox.id);

      if (prompt === 'first') {
        await firstGate;
      }
    },
  });
  const created = await service.create();

  await harness.waitFor('ready');

  const [first, second] = await Promise.all([
    service.prompt(created.id, 'first'),
    service.prompt(created.id, 'second'),
  ]);

  assert.equal(first.status, 'accepted');

  assert.equal(second.status, 'accepted');

  await waitUntil(() => calls.length === 1);

  assert.deepEqual(calls, ['first']);

  unblockFirst();

  await waitUntil(() => calls.length === 2);

  await harness.waitFor('ready');

  assert.deepEqual(calls, ['first', 'second']);

  assert.deepEqual(sandboxes, ['vm-1', 'vm-1']);

  assert.equal(acquisitions, 1);

  assert.equal(releases, 0);

  await service.terminate(created.id);

  await service.dispose();

  assert.equal(releases, 1);

  assert.equal((await service.find(created.id))?.state, 'cancelled');
});

test('keeps processing queued prompts after one prompt fails', async () => {
  const harness = createHarness();
  const calls: string[] = [];

  const service = createSessionService({
    ...harness.dependencies,
    pool: leasePool(),
    execute: async ({ prompt }) => {
      calls.push(prompt);

      if (prompt === 'broken') {
        throw new Error('credential secret-value');
      }
    },
  });
  const created = await service.create();

  await harness.waitFor('ready');

  const first = await service.prompt(created.id, 'broken');
  const second = await service.prompt(created.id, 'next');

  assert.equal(first.status, 'accepted');

  assert.equal(second.status, 'accepted');

  await waitUntil(() => calls.length === 2);

  await harness.waitFor('ready');

  const failure = harness.events().find(({ type }) => type === 'agent.failed');

  assert.ok(failure !== undefined && first.status === 'accepted');

  assert.equal(failure.promptId, first.promptId);

  assert.doesNotMatch(JSON.stringify(failure), /secret-value/u);

  await service.terminate(created.id);

  await service.dispose();
});

test('cancels the active prompt and every queued prompt before one release', async () => {
  const harness = createHarness();
  let releases = 0;

  const service = createSessionService({
    ...harness.dependencies,
    pool: leasePool(() => {
      releases += 1;
    }),
    execute: ({ signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        ),
      ),
  });
  const created = await service.create();

  await harness.waitFor('ready');

  const first = await service.prompt(created.id, 'first');
  const second = await service.prompt(created.id, 'second');

  await harness.waitFor('running');

  assert.equal((await service.terminate(created.id))?.state, 'cancelling');

  await service.dispose();

  const cancelled = harness
    .events()
    .filter(({ type }) => type === 'agent.cancelled');

  assert.equal(cancelled.length, 2);

  assert.deepEqual(
    new Set(cancelled.map(({ promptId }) => promptId)),
    new Set(
      [first, second].flatMap((value) =>
        value.status === 'accepted' ? [value.promptId] : [],
      ),
    ),
  );

  assert.equal(releases, 1);

  assert.equal((await service.find(created.id))?.state, 'cancelled');
});

test('fails a queued session when sandbox acquisition is exhausted', async () => {
  const harness = createHarness();

  const service = createSessionService({
    ...harness.dependencies,
    pool: {
      acquire: async () => {
        throw new Error('creation attempts exhausted');
      },
    } as never,
  });
  const created = await service.create();

  assert.equal(created.state, 'queued');

  await harness.waitFor('failed');

  assert.equal(
    (await service.find(created.id))?.errorCode,
    'sandbox_acquisition_failed',
  );

  await service.dispose();

  assert.deepEqual(await service.ssh(created.id), { status: 'expired' });
});

test('captures the configuration generation when the session is created', async () => {
  const harness = createHarness();
  const oldGeneration = generation('old');
  const newGeneration = generation('new');
  let active = oldGeneration;
  let releaseAcquire: () => void = () => undefined;

  const acquireGate = new Promise<void>((resolve) => {
    releaseAcquire = resolve;
  });
  let observed: unknown;

  const service = createSessionService({
    ...harness.dependencies,
    config: { current: () => active } as never,
    pool: {
      acquire: async () => {
        await acquireGate;

        return { sandbox, release: async () => undefined };
      },
    } as never,
    execute: async ({ generation: value }) => {
      observed = value;
    },
  });
  const created = await service.create();

  active = newGeneration;

  releaseAcquire();

  await harness.waitFor('ready');

  await service.prompt(created.id, 'work');

  await waitUntil(() => observed !== undefined);

  assert.equal(observed, oldGeneration);

  await service.terminate(created.id);

  await service.dispose();
});

test('terminates an active session idempotently', async () => {
  const harness = createHarness();

  const service = createSessionService({
    ...harness.dependencies,
    pool: leasePool(),
  });
  const created = await service.create();

  await harness.waitFor('ready');

  assert.equal((await service.terminate(created.id))?.state, 'cancelling');

  assert.equal((await service.terminate(created.id))?.state, 'cancelling');

  await service.dispose();

  assert.equal((await service.find(created.id))?.state, 'cancelled');
});

test('exposes SSH only while a VM is leased to the active session', async () => {
  const harness = createHarness();

  const service = createSessionService({
    ...harness.dependencies,
    pool: leasePool(),
  });
  const created = await service.create();

  await harness.waitFor('ready');

  assert.deepEqual(await service.ssh(created.id), {
    status: 'ready',
    vmId: sandbox.id,
    ssh: sshAccess,
  });

  assert.deepEqual(await service.sshForVm(sandbox.id), {
    sessionId: created.id,
    ssh: sshAccess,
  });

  assert.equal(await service.sshForVm('different-vm'), undefined);

  await service.terminate(created.id);

  await service.dispose();

  assert.equal(await service.sshForVm(sandbox.id), undefined);

  assert.deepEqual(await service.ssh(created.id), { status: 'expired' });
});

const createHarness = () => {
  let value = session('queued');
  let messages: readonly ProviderMessage[] = [];
  const storedEvents: SessionEvent[] = [];
  const waiters: Array<{ state: SessionState; resolve: () => void }> = [];

  const update = (state: SessionState, errorCode?: string): Session => {
    value = session(state, errorCode, storedEvents.length);

    waiters
      .filter((waiter) => waiter.state === state)
      .forEach(({ resolve }) => resolve());

    return value;
  };

  const store: SessionStore = {
    create: async () => ({ session: value, snapshot, messages }),
    find: async () => ({ session: value, snapshot, messages }),
    list: async () => ({ sessions: [value], nextCursor: undefined }),
    reconcile: async () => 0,
    markReady: async () => update('ready'),
    markRunning: async () => update('running'),
    finishPrompt: async (_id: string, next: readonly ProviderMessage[]) => {
      messages = next;

      return update('ready');
    },
    acceptPrompt: async (_id: string, promptId: string) => {
      const accepted = storedEvent(
        promptId,
        'prompt.accepted',
        storedEvents.length + 1,
      );

      storedEvents.push(accepted);

      value = session(value.state, value.errorCode, storedEvents.length);

      return { status: 'accepted' as const, event: accepted };
    },
    requestCancellation: async () => update('cancelling'),
    finish: async (
      _id: string,
      target: 'failed' | 'cancelled',
      errorCode?: string,
    ) => update(target, errorCode),
    appendEvent: async (_id: string, promptId: string, event: unknown) => {
      const type = (event as { type: string }).type;

      const stored = storedEvent(
        promptId,
        type,
        storedEvents.length + 1,
        event,
      );

      storedEvents.push(stored);

      value = session(value.state, value.errorCode, storedEvents.length);

      return stored;
    },
    eventsAfter: async (_id: string, sequence: number) =>
      storedEvents.filter((event) => event.sequence > sequence),
    delete: async () => 'active' as const,
  };

  return {
    events: () => [...storedEvents],
    waitFor: (state: SessionState) => {
      if (value.state === state) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout>;

        const waiter = {
          state,
          resolve: () => {
            clearTimeout(timeout);

            resolve();
          },
        };

        timeout = setTimeout(() => {
          const index = waiters.indexOf(waiter);

          if (index >= 0) {
            waiters.splice(index, 1);
          }

          reject(new Error(`Timed out waiting for session state ${state}.`));
        }, 1_000);

        waiters.push(waiter);
      });
    },
    dependencies: {
      store,
      config: { current: () => generation('current') } as never,
      publisher: {
        event: () => undefined,
        updated: () => undefined,
        deleted: () => undefined,
      },
      logger: { debug: () => undefined, error: () => undefined } as never,
    },
  };
};
const id = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';

const snapshot = {
  configuration: defaultConfig,
  revision: 1,
  updatedAt: new Date(0).toISOString(),
};

const generation = (marker: string) => ({
  snapshot,
  marker,
  redactions: () => ['secret-value'],
  providers: new Map(),
  catalog: { skills: [], tools: [] },
});

const session = (
  state: SessionState,
  errorCode?: string,
  lastSequence = 0,
): Session => ({
  id,
  state,
  configRevision: 1,
  ...(errorCode === undefined ? {} : { errorCode }),
  lastSequence,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
});

const storedEvent = (
  promptId: string,
  type: string,
  sequence: number,
  event: unknown = { type },
): SessionEvent => ({
  sessionId: id,
  promptId,
  sequence,
  type,
  event,
  createdAt: new Date(sequence * 1000).toISOString(),
});

const sandbox = {
  id: 'vm-1',
  ssh: async () => sshAccess,
};

const sshAccess = {
  host: '127.0.0.1',
  port: 2200,
  username: 'root' as const,
  privateKey: 'key',
  knownHosts: 'known',
  hostKeyFingerprint: 'fingerprint',
};

const leasePool = (release: () => void = () => undefined) =>
  ({
    acquire: async () => ({
      sandbox,
      release: async () => release(),
    }),
  }) as never;

const waitUntil = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }

    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.fail('Condition was not reached.');
};
