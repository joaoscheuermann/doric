// L1 (phase 3, S59 D4, Q6, Q7): `routedMcpLease`, the `McpLease` over
// `runtime.lease/v1`. A run describes the Project's current lease (scope
// `{projectId}` only, target `{}`), then `start` opens `Start` with the head
// `{target: {expectSandboxId}, request}` and resolves at `started` with a
// live process: outputs in order, `exit` as its result (an absent exit code
// as `null`), a stream ending without `exit` as `invalid_output`, nothing
// sent after the exit, `terminate()` cancelling the stream. A `Start` failing
// `unsupported_operation` rejects `start` with that code; a lease status
// makes the run's outcome that status. The run and its stream live outside
// the caller's call (D2).

import assert from 'node:assert/strict';
import test from 'node:test';

import { ContractError } from 'bundle/contracts';
import type { SandboxProcess, SandboxProcessOutput } from 'sandbox';

import { routedMcpLease } from '../src/host/lease.js';
import type { McpLease, McpSandbox } from '../src/host/ports.js';
import {
  type AdapterWorld,
  adapterWorld,
  contractErrorFrom,
  P1,
  SANDBOX_ID,
  THREAD,
} from './support/adapters.js';
import { eventually } from './support/wait.js';

const setup = async (t: test.TestContext) => {
  const world = adapterWorld();
  t.after(() => world.stop());
  const context = await world.context();

  return { world, lease: routedMcpLease(context.services) };
};

/** Starts `node server.js` on P1's lease and answers the process and what it wrote. */
const startOn = async (lease: McpLease) => {
  const outputs: SandboxProcessOutput[] = [];
  const outcome = await lease.run(P1, async (sandbox: McpSandbox) => {
    assert.ok(sandbox.start !== undefined, 'the routed sandbox can start');

    return sandbox.start({
      cmd: ['node', 'server.js'],
      env: ['TOKEN=secret-1'],
      cwd: '/workspace/tools',
      tty: false,
      onOutput: (output) => outputs.push(output),
    });
  });

  assert.equal(outcome.status, 'ready');
  const process = (outcome as { readonly value: SandboxProcess }).value;

  return { process, outputs };
};

const latest = (world: AdapterWorld) => {
  const process = world.processes.at(-1);
  assert.ok(process !== undefined, 'a Start stream is open');
  return process;
};

void test('L1: no call before run', async (t) => {
  const { world } = await setup(t);

  assert.deepEqual(world.calls, []);
});

void test("L1 (Q7): run describes the Project's current lease, then Start sends the head {target {expectSandboxId}, request}, both under scope {projectId} only", async (t) => {
  const { world, lease } = await setup(t);

  await startOn(lease);

  const [describe] = world.callsOf('lease.describe');
  assert.deepEqual(describe?.request, { target: {} });
  assert.deepEqual(describe?.scope, { projectId: P1 });
  const [start] = world.callsOf('lease.start');
  assert.deepEqual(start?.scope, { projectId: P1 });
  assert.deepEqual(start?.request, {
    target: { expectSandboxId: SANDBOX_ID },
    request: {
      cmd: ['node', 'server.js'],
      cwd: '/workspace/tools',
      env: ['TOKEN=secret-1'],
      tty: false,
    },
  });
});

void test('L1: start resolves at started, while the process runs; outputs reach onOutput in order', async (t) => {
  const { world, lease } = await setup(t);
  const { outputs } = await startOn(lease);
  const fake = latest(world);

  assert.deepEqual(outputs, []);
  fake.output('stderr', 'listening\n');
  fake.output('stdout', '{"jsonrpc":"2.0"}\n');
  fake.output('stderr', 'ready\n');

  await eventually(
    () => outputs.length === 3,
    'three outputs',
    () => outputs,
  );
  assert.deepEqual(outputs, [
    { stream: 'stderr', data: 'listening\n' },
    { stream: 'stdout', data: '{"jsonrpc":"2.0"}\n' },
    { stream: 'stderr', data: 'ready\n' },
  ]);
});

void test('L1: exit resolves result; an absent exit code reads as null', async (t) => {
  const { world, lease } = await setup(t);
  const { process } = await startOn(lease);

  latest(world).exit({ stderr: 'killed' });

  const result = await process.result;
  assert.equal(result.exitCode, null);
  assert.equal(result.stderr, 'killed');
});

void test('L1: exit with a code resolves result with it', async (t) => {
  const { world, lease } = await setup(t);
  const { process } = await startOn(lease);

  latest(world).exit({ exitCode: 3, stdout: 'bye' });

  const result = await process.result;
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, 'bye');
});

void test('L1: a stream ending without exit rejects result invalid_output', async (t) => {
  const { world, lease } = await setup(t);
  const { process } = await startOn(lease);

  latest(world).end();

  await assert.rejects(process.result, (error: unknown) => {
    assert.equal(contractErrorFrom(error).code, 'invalid_output');
    return true;
  });
});

void test('L1: a stream failing after started rejects result with its code', async (t) => {
  const { world, lease } = await setup(t);
  const { process } = await startOn(lease);

  latest(world).fail(new ContractError('internal', 'The sandbox went away.'));

  await assert.rejects(process.result, (error: unknown) => {
    assert.equal(contractErrorFrom(error).code, 'internal');
    return true;
  });
});

void test('L1: write and resize send one item each; after the exit, write sends nothing', async (t) => {
  const { world, lease } = await setup(t);
  const { process } = await startOn(lease);
  const fake = latest(world);

  await process.write('{"id":1}\n');
  await process.resize(120, 40);
  await eventually(
    () => fake.writes.length === 1 && fake.resizes.length === 1,
    'the write and the resize',
    () => ({ writes: fake.writes, resizes: fake.resizes }),
  );
  assert.deepEqual(fake.writes, ['{"id":1}\n']);
  assert.deepEqual(fake.resizes, [{ cols: 120, rows: 40 }]);

  fake.exit({ exitCode: 0 });
  await process.result;
  await process.write('late\n');
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(fake.writes, ['{"id":1}\n']);
});

void test('L1: terminate cancels the Start stream', async (t) => {
  const { world, lease } = await setup(t);
  const { process } = await startOn(lease);
  const fake = latest(world);

  assert.equal(fake.signal.aborted, false);
  await process.terminate();

  await eventually(() => fake.signal.aborted, 'the stream cancelled');
});

void test('L1 (Q6): Start failing unsupported_operation rejects start with that code; the run answers what the task did', async (t) => {
  const { world, lease } = await setup(t);
  world.startError = new ContractError(
    'unsupported_operation',
    'The sandbox cannot keep a process running.',
  );

  const outcome = await lease.run(P1, async (sandbox) => {
    try {
      await sandbox.start?.({ cmd: ['node', 'server.js'] });
      return 'started';
    } catch (error) {
      return contractErrorFrom(error).code;
    }
  });

  assert.deepEqual(outcome, {
    status: 'ready',
    value: 'unsupported_operation',
  });
});

void test("L1: Start failing unavailable {leaseStatus expired} makes the run's outcome expired", async (t) => {
  const { world, lease } = await setup(t);
  world.startError = new ContractError('unavailable', 'The lease ended.', {
    leaseStatus: 'expired',
  });

  const outcome = await lease.run(P1, async (sandbox) => {
    await sandbox
      .start?.({ cmd: ['node', 'server.js'] })
      .catch(() => undefined);
    return 'done';
  });

  assert.deepEqual(outcome, { status: 'expired' });
});

void test('L1: Describe failing unavailable {leaseStatus pending} answers pending; the task never runs and nothing starts', async (t) => {
  const { world, lease } = await setup(t);
  world.describe = new ContractError('unavailable', 'No sandbox yet.', {
    leaseStatus: 'pending',
  });
  let ran = false;

  const outcome = await lease.run(P1, async () => {
    ran = true;
    return 'ran';
  });

  assert.deepEqual(outcome, { status: 'pending' });
  assert.equal(ran, false);
  assert.deepEqual(world.callsOf('lease.start'), []);
});

void test("L1 (D2): a run started from a handler's call carries no deadline, and its process outlives that call", async (t) => {
  const { world, lease } = await setup(t);

  const process = await world.within(
    async () => (await startOn(lease)).process,
    { scope: { projectId: P1, threadId: THREAD }, timeoutMs: 30_000 },
  );
  const fake = latest(world);

  for (const call of [
    ...world.callsOf('lease.describe'),
    ...world.callsOf('lease.start'),
  ]) {
    assert.equal(call.deadline, 0, call.method);
    assert.deepEqual(call.scope, { projectId: P1 }, call.method);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fake.signal.aborted, false);

  fake.exit({ exitCode: 0 });
  assert.equal((await process.result).exitCode, 0);
});
