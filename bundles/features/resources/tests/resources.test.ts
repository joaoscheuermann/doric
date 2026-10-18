// resources/v1 (§3.12) and the window's reads over it: the host machine, and
// the Project's container through a fake runtime.lease/v1 whose lease is
// either held (the task runs on a sandbox with a stats reader) or in one of
// its other states. The window side is observed as the REST client answered:
// lease states are data, `pending` carries `Retry-After: 1`, a failed call is
// a sentence.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type CallScope,
  ContractError,
  defineMethod,
  defineService,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import {
  type LeaseOutcome,
  type LeaseTask,
  RuntimeLeaseV1,
  runtimeLeaseMethods,
} from 'runtime/contracts';
import type { Sandbox, SandboxStats } from 'sandbox';

import { createResourcesReads } from '../src/client/api/resources.js';
import { ResourcesV1 } from '../src/contracts/index.js';
import { activate, cpuPercentBetween } from '../src/host/index.js';

type LeaseState = 'ready' | 'pending' | 'unavailable' | 'expired' | 'missing';

interface Lease {
  state: LeaseState;
  /** Closing starts, or the lease drops, while the task runs. */
  dropDuringTask: boolean;
  /** The Projects the reads asked the lease for. */
  readonly scopes: (string | undefined)[];
  /** A failure of the call itself (a lost bridge). */
  failure?: Error;
  /** What the leased sandbox's provider answers. */
  stats?: () => Promise<SandboxStats | undefined>;
}

const sandboxOf = (lease: Lease) =>
  ({
    id: 'vm-1',
    root: '/workspace',
    stats: lease.stats,
  }) as unknown as Sandbox;

/** Only `withLease`: any other lease method (an acquiring read) is absent. */
const fakeLease = (lease: Lease) =>
  defineService(RuntimeLeaseV1.id, {
    withLease: defineMethod({
      ...runtimeLeaseMethods.withLease,
      execute: async (task: LeaseTask<unknown>, call) => {
        lease.scopes.push(call.scope?.projectId);
        if (lease.failure !== undefined) throw lease.failure;
        if (lease.state !== 'ready') return { status: lease.state };
        const value = await task(sandboxOf(lease));
        const outcome: LeaseOutcome<unknown> = lease.dropDuringTask
          ? { status: 'unavailable' }
          : { status: 'ready', value };
        return outcome;
      },
    }),
  });

const setup = async (lease: Lease) => {
  const harness = createTestServices({
    bundle: { id: 'resources' },
    provide: [fakeLease(lease)],
  });
  await activate({ services: harness.services });
  const resources = (scope?: CallScope) =>
    harness.services.use(ResourcesV1, scope);
  return {
    resources,
    reads: createResourcesReads((projectId) =>
      resources(projectId === undefined ? undefined : { projectId }),
    ),
    dispose: harness.dispose,
  };
};

const leaseOf = (overrides: Partial<Lease> = {}): Lease => ({
  state: 'ready',
  dropDuringTask: false,
  scopes: [],
  ...overrides,
});

const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('resources/v1.host()', () => {
  test('reads the machine with no CPU share first, then one, without a lease', async (t) => {
    const lease = leaseOf();
    const { resources, dispose } = await setup(lease);
    t.after(dispose);

    const first = await resources().host();
    assert.match(first.at, isoTime);
    assert.equal('cpuPercent' in first, false);
    assert.ok(first.cpuCount > 0);
    assert.ok(first.memoryUsedBytes <= first.memoryTotalBytes);
    assert.equal(typeof first.loadAverage, 'number');
    assert.ok(Number.isInteger(first.uptimeSeconds));

    // Burn some CPU so the counters advance between the two samples.
    const until = Date.now() + 50;
    while (Date.now() < until);
    const second = await resources().host();
    if (second.cpuPercent !== undefined) {
      assert.ok(second.cpuPercent >= 0 && second.cpuPercent <= 100);
    }
    assert.deepEqual(lease.scopes, []);
  });

  test('reads the busy share of every core between two samples', () => {
    assert.equal(
      cpuPercentBetween(
        [{ idle: 100, total: 200 }],
        [{ idle: 150, total: 300 }],
      ),
      50,
    );
    assert.equal(
      cpuPercentBetween([{ idle: 0, total: 100 }], [{ idle: 0, total: 100 }]),
      undefined,
    );
  });
});

describe('resources/v1.project() over the Project lease', () => {
  test('widens the provider reading into the container, on the calling Project', async (t) => {
    const lease = leaseOf({
      stats: async () => ({
        cpuPercent: 25,
        cpuCount: 2,
        memoryUsedBytes: 1024,
        memoryLimitBytes: 2048,
        at: 'provider-time',
      }),
    });
    const { resources, dispose } = await setup(lease);
    t.after(dispose);

    const outcome = await resources({ projectId: 'p-1' }).project();
    assert.equal(outcome.status, 'ready');
    if (outcome.status !== 'ready') return;
    assert.match(outcome.value.at, isoTime);
    assert.notEqual(outcome.value.at, 'provider-time');
    assert.deepEqual(
      { ...outcome.value, at: '' },
      {
        status: 'ready',
        at: '',
        cpuPercent: 25,
        cpuCount: 2,
        memoryUsedBytes: 1024,
        memoryLimitBytes: 2048,
      },
    );
    assert.deepEqual(lease.scopes, ['p-1']);
  });

  test('keeps only the fields the provider measured', async (t) => {
    const lease = leaseOf({
      stats: async () => ({ at: 'p', memoryUsedBytes: 10 }),
    });
    const { resources, dispose } = await setup(lease);
    t.after(dispose);

    const outcome = await resources({ projectId: 'p-1' }).project();
    assert.ok(outcome.status === 'ready');
    assert.deepEqual(Object.keys(outcome.value).sort(), [
      'at',
      'memoryUsedBytes',
      'status',
    ]);
  });

  test('answers an unavailable container when the provider has no reading or fails', async (t) => {
    for (const stats of [
      undefined,
      async () => undefined,
      async () => {
        throw new Error('provider unavailable');
      },
    ]) {
      const { resources, dispose } = await setup(leaseOf({ stats }));
      t.after(dispose);
      const outcome = await resources({ projectId: 'p-1' }).project();
      assert.ok(outcome.status === 'ready');
      assert.equal(outcome.value.status, 'unavailable');
      assert.match(outcome.value.at, isoTime);
      assert.deepEqual(Object.keys(outcome.value).sort(), ['at', 'status']);
    }
  });

  test('passes every other lease state through as data, never acquiring', async (t) => {
    for (const state of [
      'pending',
      'unavailable',
      'expired',
      'missing',
    ] as const) {
      const lease = leaseOf({
        state,
        stats: async () => {
          throw new Error('the task must not run');
        },
      });
      const { resources, dispose } = await setup(lease);
      t.after(dispose);
      assert.deepEqual(await resources({ projectId: 'p-1' }).project(), {
        status: state,
      });
    }
  });

  test('answers unavailable when the lease drops during the read', async (t) => {
    const lease = leaseOf({
      dropDuringTask: true,
      stats: async () => ({ at: 'p', cpuPercent: 1 }),
    });
    const { resources, dispose } = await setup(lease);
    t.after(dispose);
    assert.deepEqual(await resources({ projectId: 'p-1' }).project(), {
      status: 'unavailable',
    });
  });
});

describe("the window's resource reads", () => {
  test('answer the container, or the lease state with the route hint', async (t) => {
    const lease = leaseOf({
      stats: async () => ({
        at: 'p',
        memoryUsedBytes: 5,
        memoryLimitBytes: 10,
      }),
    });
    const { reads, dispose } = await setup(lease);
    t.after(dispose);

    const ready = await reads.project('p-1');
    assert.ok(ready.status === 'ready');
    assert.equal(ready.container.status, 'ready');
    assert.equal(ready.container.memoryUsedBytes, 5);
    assert.equal(ready.container.memoryLimitBytes, 10);

    lease.state = 'pending';
    assert.deepEqual(await reads.project('p-1'), {
      status: 'pending',
      retryAfterSeconds: 1,
    });
    for (const state of ['unavailable', 'expired', 'missing'] as const) {
      lease.state = state;
      assert.deepEqual(await reads.project('p-1'), { status: state });
    }
    assert.deepEqual(lease.scopes, ['p-1', 'p-1', 'p-1', 'p-1', 'p-1']);

    const host = await reads.host();
    assert.ok(host.cpuCount > 0);
  });

  test('refuse an invalid Project identifier before calling the host', async (t) => {
    const lease = leaseOf();
    const { reads, dispose } = await setup(lease);
    t.after(dispose);

    for (const id of ['', 'x'.repeat(201), 'a\0b']) {
      await assert.rejects(reads.project(id), {
        message: 'The item identifier is invalid.',
      });
    }
    assert.deepEqual(lease.scopes, []);
  });

  test('show the REST sentences when the host call fails', async (t) => {
    const lease = leaseOf();
    const { reads, dispose } = await setup(lease);
    t.after(dispose);

    lease.failure = new ContractError('disconnected', 'bridge lost');
    await assert.rejects(reads.project('p-1'), {
      message: 'Doric backend is unavailable.',
    });
    lease.failure = new Error('boom');
    await assert.rejects(reads.project('p-1'), {
      message: 'The request could not be completed.',
    });
  });
});
