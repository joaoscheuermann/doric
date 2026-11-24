// L1–L2 (phase 3, S57; D2): `routedPapercraftLease`, the `PapercraftLease`
// over `runtime.lease/v1`, under the job steps `jobRunnerOver` runs. One run
// describes the Project's sandbox once, then binds every step to it with
// `expectSandboxId`: the runner is copied with `PutFile` (a head, then chunks
// of at most 1 MiB; none for an empty file), the output is read with
// `GetFile`, the job folder is removed with `Exec rm -rf`. The first lease
// failure ends the run: the job answers the lease state and no later step is
// called.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ContractError } from 'bundle/contracts';

import { routedPapercraftLease } from '../src/host/lease.js';
import { moduleNative } from '../src/host/native.js';
import { jobRunnerOver, runnerScriptOf } from '../src/host/sandbox.js';
import {
  type FakeCall,
  MIB,
  projectId,
  type RouterWorld,
  routerWorld,
  scriptedSandbox,
} from './support/router.js';

const SANDBOX_ID = 'sandbox-1';
const ROOT = '/workspace';
const NONE = { status: 'none' } as const;

const leaseCalls = (world: RouterWorld): FakeCall[] =>
  world.calls.filter(({ method }) => method.startsWith('lease.'));

const targetOf = (call: FakeCall): unknown =>
  call.method === 'lease.putFile'
    ? {
        expectSandboxId: (call.request as { expectSandboxId?: string })
          .expectSandboxId,
      }
    : (call.request as { target?: unknown }).target;

/** The command of a recorded `Exec`. */
const cmdOf = (call: FakeCall | undefined): string[] | undefined =>
  (call?.request as { request?: { cmd?: string[] } } | undefined)?.request?.cmd;

/** A job runner over the routed lease of a fresh world whose sandbox answers `NONE`. */
const setup = async (t: test.TestContext, runner: Uint8Array) => {
  const world = routerWorld();
  t.after(() => world.stop());
  world.lease.status = 'ready';
  world.lease.sandboxId = SANDBOX_ID;
  world.lease.sandbox = scriptedSandbox(() => NONE, ROOT);
  const context = await world.contextOf();
  const runJob = jobRunnerOver(
    routedPapercraftLease(context.services),
    async () => runnerScriptOf(runner),
    moduleNative,
  );

  return { world, runJob };
};

const libraryJob = {
  kind: 'library',
  cwd: `${ROOT}/app`,
  windowUnserved: [],
} as const;

void test('L1: one job describes the sandbox once, then every Exec, PutFile and GetFile expects its id; the runner goes in chunks of at most 1 MiB, the output comes back with GetFile and the job folder is removed', async (t) => {
  const runner = Uint8Array.from(
    { length: Math.floor(2.5 * MIB) },
    (_, index) => index % 253,
  );
  const { world, runJob } = await setup(t, runner);

  const answer = await runJob(projectId, libraryJob);

  assert.deepEqual(answer, NONE);
  const calls = leaseCalls(world);
  assert.equal(calls[0]?.method, 'lease.describe');
  assert.deepEqual(calls[0]?.request, { target: {} });
  assert.equal(world.callsOf('lease.describe').length, 1);
  for (const call of calls.slice(1)) {
    assert.deepEqual(
      targetOf(call),
      { expectSandboxId: SANDBOX_ID },
      call.method,
    );
    assert.deepEqual(call.scope, { projectId }, call.method);
  }
  const runnerPut = world.puts.find(({ path }) =>
    /\/runner-[^/]+\.mjs$/u.test(path),
  );
  assert.ok(
    runnerPut !== undefined,
    JSON.stringify(world.puts.map(({ path }) => path)),
  );
  assert.deepEqual(
    runnerPut.chunks.map((chunk) => chunk.length),
    [MIB, MIB, runner.length - 2 * MIB],
  );
  assert.deepEqual(Buffer.concat(runnerPut.chunks), Buffer.from(runner));
  const outputRead = world
    .callsOf('lease.getFile')
    .find(({ request }) =>
      (request as { request?: { path?: string } }).request?.path?.endsWith(
        '/output.json',
      ),
    );
  assert.ok(outputRead !== undefined);
  const jobDir = (
    outputRead.request as { request: { path: string } }
  ).request.path.replace(/\/output\.json$/u, '');
  const last = calls.at(-1);
  assert.equal(last?.method, 'lease.exec');
  assert.deepEqual(cmdOf(last), ['rm', '-rf', '--', jobDir]);
});

void test('L1: an empty runner is put as a head with no chunk', async (t) => {
  const { world, runJob } = await setup(t, new Uint8Array());

  await runJob(projectId, libraryJob);

  const runnerPut = world.puts.find(({ path }) =>
    /\/runner-[^/]+\.mjs$/u.test(path),
  );
  assert.ok(runnerPut !== undefined);
  assert.deepEqual(runnerPut.chunks, []);
});

void test('L2: an Exec failing unavailable with leaseStatus unavailable mid-job answers that the Project has no sandbox lease, and no later step is called', async (t) => {
  const { world, runJob } = await setup(t, Buffer.from('// runner\n'));
  world.lease.execFailure = {
    when: (cmd) => cmd[0] === 'node',
    error: new ContractError('unavailable', 'The sandbox went away.', {
      leaseStatus: 'unavailable',
    }),
  };

  const answer = await runJob(projectId, libraryJob);

  assert.deepEqual(answer, {
    status: 'unavailable',
    reason: 'the Project has no sandbox lease (unavailable)',
  });
  const last = leaseCalls(world).at(-1);
  assert.equal(last?.method, 'lease.exec');
  assert.equal(cmdOf(last)?.[0], 'node');
});
