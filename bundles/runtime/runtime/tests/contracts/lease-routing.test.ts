// The routed Project lease helper (phase 3, slice S55a, contract §2.1, §5
// H1–H6): `leaseStatusOf`, `execRequestOf`, `execResultOf` and
// `runOnProjectLease`. The `lease` client is the boundary: a fake `describe`
// that records its requests and answers or fails as the case sets, and steps
// whose work the case controls.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { type Client, ConnectError } from '@connectrpc/connect';
import {
  ContractError,
  fromConnectError,
  isContractError,
  toConnectError,
} from 'bundle/contracts';

import {
  type DescribeRequestSchema,
  DescribeResponseSchema,
  ExecResponseSchema,
  type LeaseService,
} from '../../src/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import {
  execRequestOf,
  execResultOf,
  type LeaseFailureStatus,
  leaseStatusOf,
  type ProjectLeaseSteps,
  runOnProjectLease,
} from '../../src/contracts/index.js';

type DescribeInit = MessageInitShape<typeof DescribeRequestSchema>;

const STATUSES: readonly LeaseFailureStatus[] = [
  'pending',
  'unavailable',
  'expired',
  'missing',
];

/** A lease failure as `runtime.lease/v1` sends it, `leaseStatus` in its details. */
const leaseFailure = (leaseStatus: string): ContractError =>
  new ContractError('unavailable', `lease is ${leaseStatus}`, { leaseStatus });

/** The same failure as a client call rejects with it. */
const overTheWire = (error: ContractError): ConnectError =>
  toConnectError(error);

/** The Doric error a rejection carries, as a caller reads it. */
const contractErrorOf = (error: unknown): ContractError => {
  if (error instanceof ConnectError) return fromConnectError(error);
  assert.ok(isContractError(error), `expected a Doric error: ${String(error)}`);

  return error;
};

/** What `promise` rejects with; fails the test when it resolves. */
const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    (value) => assert.fail(`resolved with ${JSON.stringify(value)}`),
    (error: unknown) => error,
  );

/**
 * A fake lease client: `describe` records each request and answers the
 * sandbox `vm-1` at `/work`, or rejects with `failure` when one is set.
 */
const fakeLease = (failure?: unknown) => {
  const requests: DescribeInit[] = [];
  const lease: Pick<Client<typeof LeaseService>, 'describe'> = {
    describe: async (request) => {
      requests.push(request);
      if (failure !== undefined) throw failure;

      return create(DescribeResponseSchema, { id: 'vm-1', root: '/work' });
    },
  };

  return { lease, requests };
};

describe('leaseStatusOf', () => {
  test('H1: each lease status from a ContractError', () => {
    for (const status of STATUSES) {
      assert.equal(leaseStatusOf(leaseFailure(status)), status, status);
    }
  });

  test('H1: each lease status from a ConnectError', () => {
    for (const status of STATUSES) {
      assert.equal(
        leaseStatusOf(overTheWire(leaseFailure(status))),
        status,
        status,
      );
    }
  });

  test('H1: undefined for unavailable without the detail, another code, a non-error, an unknown status', () => {
    const cases: readonly (readonly [string, unknown])[] = [
      [
        'unavailable without details',
        new ContractError('unavailable', 'runtime unreachable'),
      ],
      [
        'unavailable with other details',
        new ContractError('unavailable', 'runtime unreachable', {
          reason: 'starting',
        }),
      ],
      [
        'unavailable without the detail, over the wire',
        overTheWire(new ContractError('unavailable', 'runtime unreachable')),
      ],
      [
        'another code with a leaseStatus',
        new ContractError('internal', 'boom', { leaseStatus: 'pending' }),
      ],
      [
        'another code over the wire',
        overTheWire(
          new ContractError('internal', 'boom', { leaseStatus: 'pending' }),
        ),
      ],
      ['a plain Error', new Error('unavailable')],
      [
        'a plain object shaped like the detail',
        { code: 'unavailable', details: { leaseStatus: 'pending' } },
      ],
      ['a string', 'unavailable'],
      ['undefined', undefined],
      ['null', null],
      ['an unknown status', leaseFailure('gone')],
      ['ready', leaseFailure('ready')],
      [
        'a non-string status',
        new ContractError('unavailable', 'odd', { leaseStatus: 1 }),
      ],
    ];

    for (const [name, failure] of cases) {
      assert.equal(leaseStatusOf(failure), undefined, name);
    }
  });
});

describe('runOnProjectLease', () => {
  test('H2: a ready lease: one Describe{target: {}}, steps bound to the described sandbox, {ready, value}', async () => {
    const { lease, requests } = fakeLease();
    const seen: {
      id: string;
      root: string;
      target: ProjectLeaseSteps['target'];
    }[] = [];
    const answers: string[] = [];

    const outcome = await runOnProjectLease(lease, async (steps) => {
      seen.push({ id: steps.id, root: steps.root, target: steps.target });
      answers.push(await steps.step(async () => 'first'));
      answers.push(await steps.step(async () => 'second'));
      seen.push({ id: steps.id, root: steps.root, target: steps.target });

      return 42;
    });

    assert.deepEqual(outcome, { status: 'ready', value: 42 });
    assert.equal(requests.length, 1, 'one Describe');
    assert.deepEqual({ ...requests[0] }, { target: {} });
    assert.deepEqual(answers, ['first', 'second']);
    for (const steps of seen) {
      assert.deepEqual(
        { id: steps.id, root: steps.root, target: { ...steps.target } },
        { id: 'vm-1', root: '/work', target: { expectSandboxId: 'vm-1' } },
      );
    }
  });

  test('H3: Describe failing with each leaseStatus answers {status} and runs no task', async () => {
    for (const status of STATUSES) {
      for (const [form, failure] of [
        ['ConnectError', overTheWire(leaseFailure(status))],
        ['ContractError', leaseFailure(status)],
      ] as const) {
        const { lease } = fakeLease(failure);
        let ran = false;

        const outcome = await runOnProjectLease(lease, async () => {
          ran = true;
          return 'value';
        });

        assert.deepEqual(outcome, { status }, `${status} (${form})`);
        assert.equal(ran, false, `${status} (${form}): no task`);
      }
    }
  });

  test('H4: a step failing with a leaseStatus, caught by the task: {status}, and a later step fails with it without a call', async () => {
    const { lease } = fakeLease();
    let laterCalled = false;
    let later: unknown;

    const outcome = await runOnProjectLease(lease, async (steps) => {
      await steps
        .step(async () => {
          throw overTheWire(leaseFailure('unavailable'));
        })
        .catch(() => undefined);
      later = await rejectionOf(
        steps.step(async () => {
          laterCalled = true;
          return 'later';
        }),
      );

      return 'done';
    });

    assert.deepEqual(outcome, { status: 'unavailable' });
    assert.equal(laterCalled, false, 'the later step made no call');
    const error = contractErrorOf(later);
    assert.equal(error.code, 'unavailable');
    assert.deepEqual(error.details, { leaseStatus: 'unavailable' });
  });

  test('H4: the first leaseStatus is the answer, whatever the task does with the rejection', async () => {
    const tasks: readonly (readonly [
      string,
      (steps: ProjectLeaseSteps) => Promise<string>,
    ])[] = [
      [
        'the task rethrows it',
        async (steps) =>
          steps.step(async () => {
            throw overTheWire(leaseFailure('expired'));
          }),
      ],
      [
        'the task fails with its own error',
        async (steps) => {
          await steps
            .step(async () => {
              throw overTheWire(leaseFailure('expired'));
            })
            .catch(() => undefined);
          throw new ContractError('internal', 'the task gave up');
        },
      ],
      [
        'a later step would fail with another status',
        async (steps) => {
          await steps
            .step(async () => {
              throw overTheWire(leaseFailure('expired'));
            })
            .catch(() => undefined);
          await steps
            .step(async () => {
              throw overTheWire(leaseFailure('missing'));
            })
            .catch(() => undefined);
          return 'done';
        },
      ],
    ];

    for (const [name, task] of tasks) {
      const { lease } = fakeLease();

      assert.deepEqual(
        await runOnProjectLease(lease, task),
        { status: 'expired' },
        name,
      );
    }
  });

  test('H5: a step failing internal rejects with internal as a ContractError, message and details kept', async () => {
    const { lease } = fakeLease();
    let stepError: unknown;

    const error = await rejectionOf(
      runOnProjectLease(lease, async (steps) =>
        steps
          .step(async () => {
            throw overTheWire(
              new ContractError('internal', 'disk on fire', { path: '/x' }),
            );
          })
          .catch((failure: unknown) => {
            stepError = failure;
            throw failure;
          }),
      ),
    );

    for (const [name, failure] of [
      ['the step', stepError],
      ['the run', error],
    ] as const) {
      assert.ok(isContractError(failure), `${name}: a ContractError`);
      assert.equal(failure.code, 'internal', name);
      assert.equal(failure.message, 'disk on fire', name);
      assert.deepEqual(failure.details, { path: '/x' }, name);
    }
  });

  test('H5: a step failure without a leaseStatus does not end the run', async () => {
    const { lease } = fakeLease();
    let laterCalled = false;

    const outcome = await runOnProjectLease(lease, async (steps) => {
      await steps
        .step(async () => {
          throw overTheWire(new ContractError('unavailable', 'unreachable'));
        })
        .catch(() => undefined);

      return steps.step(async () => {
        laterCalled = true;
        return 'later';
      });
    });

    assert.deepEqual(outcome, { status: 'ready', value: 'later' });
    assert.equal(laterCalled, true);
  });

  test('H5: Describe failing other than by a leaseStatus rejects with its code, message and details; no task runs', async () => {
    const failures: readonly ContractError[] = [
      new ContractError('invalid_input', 'no projectId in the scope'),
      new ContractError('unavailable', 'runtime unreachable'),
      new ContractError('limit_exceeded', 'too large', { limit: 4 }),
    ];

    for (const expected of failures) {
      const { lease } = fakeLease(overTheWire(expected));
      let ran = false;

      const error = await rejectionOf(
        runOnProjectLease(lease, async () => {
          ran = true;
          return 'value';
        }),
      );

      assert.ok(isContractError(error), `${expected.code}: a ContractError`);
      assert.equal(error.code, expected.code);
      assert.equal(error.message, expected.message, expected.code);
      assert.deepEqual(error.details, expected.details, expected.code);
      assert.equal(ran, false, `${expected.code}: no task`);
    }
  });

  test("H5: the task's own failure rejects unchanged in code and message", async () => {
    const { lease } = fakeLease();

    const error = await rejectionOf(
      runOnProjectLease(lease, async () => {
        throw new ContractError('not_found', 'no such file', { path: 'a' });
      }),
    );

    const failure = contractErrorOf(error);
    assert.equal(failure.code, 'not_found');
    assert.equal(failure.message, 'no such file');
    assert.deepEqual(failure.details, { path: 'a' });
  });
});

describe('execRequestOf', () => {
  test('H6: drops signal and keeps every other field', () => {
    assert.deepEqual(
      execRequestOf({
        cmd: ['git', 'status'],
        cwd: '/work/repo',
        env: ['A=1'],
        user: 'doric',
        timeoutMs: 5_000,
        tty: false,
        signal: new AbortController().signal,
      }),
      {
        cmd: ['git', 'status'],
        env: ['A=1'],
        cwd: '/work/repo',
        user: 'doric',
        timeoutMs: 5_000,
        tty: false,
      },
    );
  });

  test('H6: fills env with [] and leaves absent fields out', () => {
    const request = execRequestOf({ cmd: ['ls'] });

    assert.deepEqual(request, { cmd: ['ls'], env: [] });
    assert.deepEqual(Object.keys(request).sort(), ['cmd', 'env']);
  });
});

describe('execResultOf', () => {
  test('H6: an absent exitCode is null', () => {
    const stdoutBytes = new TextEncoder().encode('out');

    assert.deepEqual(
      execResultOf(
        create(ExecResponseSchema, {
          response: { stdout: 'out', stderr: 'err', stdoutBytes },
        }),
      ),
      {
        exitCode: null,
        stdout: 'out',
        stderr: 'err',
        stdoutBytes,
        stderrBytes: new Uint8Array(),
      },
    );
  });

  test('H6: a present exitCode is kept, 0 included', () => {
    for (const exitCode of [0, 2]) {
      assert.equal(
        execResultOf(create(ExecResponseSchema, { response: { exitCode } }))
          .exitCode,
        exitCode,
      );
    }
  });

  test("H6: an absent response is null, '' and empty bytes", () => {
    assert.deepEqual(execResultOf(create(ExecResponseSchema, {})), {
      exitCode: null,
      stdout: '',
      stderr: '',
      stdoutBytes: new Uint8Array(),
      stderrBytes: new Uint8Array(),
    });
  });
});
