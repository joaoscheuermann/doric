// `resources`' host part through the router (phase 3, slice S50b, tests
// R1–R7): `resources/v1` served by `createResourcesService`. `Host` reads the
// machine in process; `Project` reads the calling Project's container through
// one `runtime.lease/v1.Stats`, answers a non-ready lease as its status, and
// rejects any other lease failure with its code (coordinator decision Q3).

import assert from 'node:assert/strict';
import { cpus, totalmem } from 'node:os';
import test from 'node:test';

import { toJson } from '@bufbuild/protobuf';
import { ConnectError } from '@connectrpc/connect';
import {
  type CallScope,
  ContractError,
  fromConnectError,
  isContractError,
} from 'bundle/contracts';

import {
  HostResponseSchema,
  ProjectResponseSchema,
} from '../src/contracts/gen/doric/resources/v1/resources_pb.js';
import { harness } from './support/router.js';

/** The scope of a Project call from the window. */
const scope: CallScope = { projectId: 'project-1' };

/** The Doric code of a failed call: read off a `ConnectError`, or a `ContractError`'s. */
const codeOf = (error: unknown): string => {
  if (error instanceof ConnectError) {
    return fromConnectError(error).code;
  }

  assert.ok(isContractError(error), `expected a Doric error: ${error}`);

  return error.code;
};

/** Whether a rejection carries the Doric code given. */
const refusal =
  (code: string) =>
  (error: unknown): boolean => {
    assert.equal(codeOf(error), code, String(error));

    return true;
  };

/** The `UNAVAILABLE` failure `runtime.lease/v1` answers for a non-ready lease. */
const leaseFailure = (leaseStatus: string): ContractError =>
  new ContractError(
    'unavailable',
    `Project lease is not ready (${leaseStatus}).`,
    { leaseStatus },
  );

/** Asserts `at` is an ISO time taken between `before` and `after`. */
const assertTakenBetween = (at: unknown, before: number, after: number) => {
  assert.equal(typeof at, 'string');

  const time = Date.parse(at as string);

  assert.equal(new Date(time).toISOString(), at, `not an ISO time: ${at}`);
  assert.ok(time >= before && time <= after, `${at} is not now`);
};

void test('R1: Host answers the machine; the first answer of the process has no cpuPercent, a second one is in [0, 100] or absent', async (t) => {
  const h = await harness(t);
  const client = h.client();

  const first = toJson(HostResponseSchema, await client.host({})) as Record<
    string,
    unknown
  >;

  assert.equal(first.cpuCount, cpus().length);
  assert.equal(first.memoryTotalBytes, totalmem());
  assert.equal(
    new Date(Date.parse(first.at as string)).toISOString(),
    first.at,
  );
  assert.equal('cpuPercent' in first, false);

  const second = await client.host({});

  if (second.cpuPercent !== undefined) {
    assert.ok(
      second.cpuPercent >= 0 && second.cpuPercent <= 100,
      String(second.cpuPercent),
    );
  }
});

void test('R2: Project answers the Stats reading as ready, stamped now, with one Stats of an empty target', async (t) => {
  const h = await harness(t, {
    stats: () => ({
      response: {
        cpuPercent: 12,
        cpuCount: 2,
        memoryUsedBytes: 5,
        memoryLimitBytes: 10,
        at: 'x',
      },
    }),
  });

  const before = Date.now();
  const answer = toJson(
    ProjectResponseSchema,
    await h.client(scope).project({}),
  ) as { status: string; value: Record<string, unknown> };
  const after = Date.now();

  assert.equal(answer.status, 'ready');
  assertTakenBetween(answer.value.at, before, after);
  assert.deepEqual(answer.value, {
    status: 'ready',
    at: answer.value.at,
    cpuPercent: 12,
    cpuCount: 2,
    memoryUsedBytes: 5,
    memoryLimitBytes: 10,
  });
  assert.deepEqual(
    h.stats.map((call) => call.request),
    [{ target: {} }],
  );
});

void test('R3: a Stats answer without a reading is a ready lease whose reading is unavailable', async (t) => {
  const h = await harness(t, { stats: () => ({}) });

  const before = Date.now();
  const answer = toJson(
    ProjectResponseSchema,
    await h.client(scope).project({}),
  ) as { status: string; value: Record<string, unknown> };
  const after = Date.now();

  assert.equal(answer.status, 'ready');
  assertTakenBetween(answer.value.at, before, after);
  assert.deepEqual(answer.value, {
    status: 'unavailable',
    at: answer.value.at,
  });
});

void test('R4: a Stats failing unavailable with a leaseStatus answers that status, with no value', async (t) => {
  for (const leaseStatus of ['pending', 'unavailable', 'expired', 'missing']) {
    await t.test(leaseStatus, async (st) => {
      const h = await harness(st, {
        stats: () => {
          throw leaseFailure(leaseStatus);
        },
      });

      assert.deepEqual(
        toJson(ProjectResponseSchema, await h.client(scope).project({})),
        { status: leaseStatus },
      );
    });
  }
});

void test('R5: a Stats failing without a leaseStatus fails Project with its code (Q3)', async (t) => {
  await t.test('internal (the provider’s stats() failed)', async (st) => {
    const h = await harness(st, {
      stats: () => {
        throw new ContractError('internal', 'The provider failed to read.');
      },
    });

    await assert.rejects(h.client(scope).project({}), refusal('internal'));
  });

  await t.test('unavailable without leaseStatus', async (st) => {
    const h = await harness(st, {
      stats: () => {
        throw new ContractError('unavailable', 'The runtime is gone.');
      },
    });

    await assert.rejects(h.client(scope).project({}), refusal('unavailable'));
  });
});

void test('R6: a Stats failing invalid_input fails Project with invalid_input', async (t) => {
  const h = await harness(t, {
    stats: () => {
      throw new ContractError(
        'invalid_input',
        'runtime.lease/v1 needs a Project or Thread scope.',
      );
    },
  });

  await assert.rejects(h.client().project({}), refusal('invalid_input'));
});

void test('R7: Stats carries the Project call’s scope', async (t) => {
  const promptScope: CallScope = {
    projectId: 'project-1',
    threadId: 'thread-1',
    promptId: 'prompt-1',
  };
  const h = await harness(t);

  await h.client(promptScope).project({});

  assert.deepEqual(
    h.stats.map((call) => call.scope),
    [promptScope],
  );
});
