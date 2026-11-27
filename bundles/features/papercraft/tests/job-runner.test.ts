// S57 D2, D4, D5: the runner and the job runner over ports.
//
// Contract matrix:
// - `runnerScriptOf(bytes)`: the bytes and the first 16 hex characters of
//   their SHA-256;
// - `jobRunnerOver(lease, runner, native)`: no runner → `unavailable` "this
//   host was built without the sandbox runner" without touching the lease; a
//   lease state other than `ready` → `unavailable` "the Project has no
//   sandbox lease (<status>)"; `ready` → the task's answer; a rejected
//   `lease.run` → the same rejection.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import { ContractError } from 'bundle/contracts';

import type { LeaseOutcome } from '../src/contracts/index.js';
import type { NativePackages } from '../src/host/native.js';
import type { PapercraftLease } from '../src/host/ports.js';
import {
  jobRunnerOver,
  type RunnerSandbox,
  type RunnerScript,
  runnerScriptOf,
  type SandboxJob,
} from '../src/host/sandbox.js';

const runner: RunnerScript = {
  bytes: Buffer.from('console.log("runner")', 'utf8'),
  hash: '0123456789abcdef',
};

/** esbuild as the job runner needs it: its version only. */
const native: NativePackages = {
  esbuild: () => ({
    build: (() => Promise.reject(new Error('no build in this test'))) as never,
    version: '0.28.2',
  }),
  tailwind: () => {
    throw new Error('no Tailwind in this test');
  },
};

const job: SandboxJob = { path: 'src/Hello.tsx', windowUnserved: [] };

/** A lease that answers `outcome` for every run, recording the Projects it ran for. */
const leaseAnswering = (
  outcome: () => Promise<LeaseOutcome<unknown>>,
): PapercraftLease & { readonly runs: string[] } => {
  const runs: string[] = [];

  return {
    runs,
    run: <T>(
      projectId: string,
      _task: (sandbox: RunnerSandbox) => Promise<T>,
    ): Promise<LeaseOutcome<T>> => {
      runs.push(projectId);
      return outcome() as Promise<LeaseOutcome<T>>;
    },
  };
};

describe('runnerScriptOf', () => {
  test('answers the bytes and the first 16 hex characters of their SHA-256', () => {
    const bytes = Buffer.from('export const runner = 1;\n', 'utf8');

    const script = runnerScriptOf(bytes);

    assert.deepEqual(Buffer.from(script.bytes), bytes);
    assert.equal(
      script.hash,
      createHash('sha256').update(bytes).digest('hex').slice(0, 16),
    );
  });
});

describe('jobRunnerOver', () => {
  test('answers unavailable without the runner and leaves the lease alone', async () => {
    const lease = leaseAnswering(() =>
      Promise.resolve({ status: 'unavailable' }),
    );

    const answer = await jobRunnerOver(
      lease,
      () => Promise.resolve(undefined),
      native,
    )('p1', job);

    assert.deepEqual(answer, {
      status: 'unavailable',
      reason: 'this host was built without the sandbox runner',
    });
    assert.deepEqual(lease.runs, []);
  });

  test('answers unavailable naming the lease state when the Project has no ready lease', async () => {
    const lease = leaseAnswering(() => Promise.resolve({ status: 'pending' }));

    const answer = await jobRunnerOver(
      lease,
      () => Promise.resolve(runner),
      native,
    )('p1', job);

    assert.deepEqual(answer, {
      status: 'unavailable',
      reason: 'the Project has no sandbox lease (pending)',
    });
    assert.deepEqual(lease.runs, ['p1']);
  });

  test("answers the job's output when the lease ran it", async () => {
    const output = { status: 'unavailable', reason: 'from the sandbox' };
    const lease = leaseAnswering(() =>
      Promise.resolve({ status: 'ready', value: output }),
    );

    const answer = await jobRunnerOver(
      lease,
      () => Promise.resolve(runner),
      native,
    )('p2', job);

    assert.deepEqual(answer, output);
    assert.deepEqual(lease.runs, ['p2']);
  });

  test("rejects with the lease's rejection", async () => {
    const refused = new ContractError('unavailable', 'the lease broke');
    const lease = leaseAnswering(() => Promise.reject(refused));

    await assert.rejects(
      jobRunnerOver(lease, () => Promise.resolve(runner), native)('p1', job),
      (error: unknown) => error === refused,
    );
  });
});
