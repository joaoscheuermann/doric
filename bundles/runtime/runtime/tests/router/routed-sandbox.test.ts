// The domain's sandbox port over `sandbox/v1` by lease id (phase 3, slice
// S47a, contract §2.3, §5): a Project's lease is acquired, used and released
// through the fake `sandbox/v1` provider, and `routedSandbox`'s lease sandbox
// carries every operation by lease id. Tests 1–4 of the slice.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { SandboxProcessOutput } from 'sandbox';

import { routedSandbox } from '../../src/host/routed-sandbox.js';
import { fakeSandbox } from '../support/sandbox.js';
import {
  largeFile,
  MiB,
  rawStderr,
  rawStdout,
  recordingSandbox,
} from './sandbox.js';
import {
  assertFails,
  callsOf,
  contextHarness,
  eventually,
  gate,
  type Harness,
  projectState,
  rejectionOf,
  started,
  within,
} from './support.js';

/** A ready Project created through `runtime/v2`. */
const readyProject = async (h: Harness, name = 'Project') => {
  const { project } = await h.runtime().createProject({ name });
  assert.ok(project !== undefined);
  await projectState(h, project.id, 'ready');

  return project;
};

describe('the routed sandbox port', () => {
  test("1: a Project acquires its lease through sandbox/v1.Acquire once, its sandbox is the fake's, and deleting it releases that lease then discards its identity", async (t) => {
    const ssh = {
      host: '127.0.0.1',
      port: 2222,
      username: 'root' as const,
      privateKey: 'key',
      knownHosts: 'known',
      hostKeyFingerprint: 'SHA256:fingerprint',
    };
    const sandbox = { ...fakeSandbox({ id: 'vm-7' }), ssh: async () => ssh };
    const h = await started(t, { sandbox: { sandbox: sandbox as never } });

    const project = await readyProject(h);

    assert.deepEqual(callsOf(h, 'sandbox.acquire'), [{ identity: project.id }]);
    const [leaseId] = h.sandboxProvider.leases();
    assert.ok(leaseId !== undefined, 'the fake holds the lease');
    // runtime/v2.VmSsh finds the Project by its lease's sandbox id and reads
    // the access through that lease.
    const { vmSsh } = await h.runtime().vmSsh({ vmId: 'vm-7' });
    assert.equal(vmSsh?.projectId, project.id);
    assert.equal(vmSsh?.ssh?.host, '127.0.0.1');
    assert.deepEqual(
      h.sandboxProvider.operations.map(({ method, leaseId: id }) => [
        method,
        id,
      ]),
      [['ssh', leaseId]],
    );

    await h.runtime().terminateProject({ id: project.id });
    await projectState(h, project.id, 'cancelled');
    assert.equal(
      (await h.runtime().deleteProject({ id: project.id })).deleteResult,
      'deleted',
    );

    assert.deepEqual(callsOf(h, 'sandbox.release'), [{ leaseId }]);
    assert.deepEqual(callsOf(h, 'sandbox.discard'), [{ identity: project.id }]);
    const order = h.calls
      .map(({ method }) => method)
      .filter(
        (method) =>
          method === 'sandbox.release' || method === 'sandbox.discard',
      );
    assert.deepEqual(order, ['sandbox.release', 'sandbox.discard']);
    assert.deepEqual(callsOf(h, 'sandbox.acquire').length, 1);
  });

  test("2: an acquisition the domain abandons (the Project ends while Acquire is held) aborts the fake's Acquire call", async (t) => {
    const held = gate();
    // Opened before the harness stops, so no held Acquire outlives the case.
    t.after(() => held.open());
    const signals: AbortSignal[] = [];
    const h = await started(t, {
      sandbox: {
        acquire: async ({ signal }) => {
          if (signal !== undefined) signals.push(signal);
          await held.promise;
          throw new Error('not reached');
        },
      },
    });

    const { project } = await h.runtime().createProject({ name: 'Held' });
    assert.ok(project !== undefined);
    await eventually(
      () => callsOf(h, 'sandbox.acquire').length === 1,
      'the routed Acquire',
    );

    await h.runtime().terminateProject({ id: project.id });

    await eventually(
      () => signals.length > 0 && signals.every((signal) => signal.aborted),
      "the fake's Acquire call aborted",
    );
  });

  test('3: exec, putFile, getFile, diff, stats, ssh and cloneRepo of a lease sandbox reach the fake by lease id and answer its values', async (t) => {
    const { sandbox, seen } = recordingSandbox();
    const { calls, context, sandboxProvider } = await contextHarness(t, {
      sandbox: { sandbox },
    });
    const port = routedSandbox(context.services);

    const lease = await within(
      port.acquire({ identity: 'p-1', signal: new AbortController().signal }),
      'acquire',
    );
    assert.equal(lease.sandbox.id, 'vm-3');
    assert.equal(lease.sandbox.root, '/work');
    const [leaseId] = sandboxProvider.leases();
    assert.ok(leaseId !== undefined);

    const exited = await lease.sandbox.exec({
      cmd: ['git', 'status'],
      cwd: '/work/app',
      env: ['A=1'],
      user: 'dev',
      timeoutMs: 5000,
      tty: true,
    });
    assert.deepEqual(
      {
        ...exited,
        stdoutBytes: [...exited.stdoutBytes],
        stderrBytes: [...exited.stderrBytes],
      },
      {
        exitCode: 3,
        stdout: 'out',
        stderr: 'err',
        stdoutBytes: [...rawStdout],
        stderrBytes: [...rawStderr],
      },
    );
    const [input] = seen.execs;
    assert.deepEqual(
      {
        cmd: input?.cmd,
        cwd: input?.cwd,
        env: input?.env,
        user: input?.user,
        timeoutMs: input?.timeoutMs,
        tty: input?.tty,
      },
      {
        cmd: ['git', 'status'],
        cwd: '/work/app',
        env: ['A=1'],
        user: 'dev',
        timeoutMs: 5000,
        tty: true,
      },
    );
    const killed = await lease.sandbox.exec({ cmd: ['killed'] });
    assert.equal(killed.exitCode, null);
    assert.equal(killed.stderr, 'killed');

    const bytes = largeFile();
    await lease.sandbox.putFile('/work/big.bin', bytes);
    assert.equal(sandboxProvider.putFiles.length, 1);
    const [put] = sandboxProvider.putFiles;
    assert.equal(put?.leaseId, leaseId);
    assert.equal(put?.chunks.length, 3);
    assert.ok(put?.chunks.every((length) => length > 0 && length <= MiB));
    assert.equal(seen.puts.length, 1, 'written once');
    assert.deepEqual(seen.puts[0]?.[1], bytes);

    assert.deepEqual(await lease.sandbox.getFile('/work/big.bin'), bytes);
    const empty = await lease.sandbox.getFile('/work/none');
    assert.equal(empty.length, 0);

    assert.equal(await lease.sandbox.diff(), 'diff --git a/x b/x');
    assert.deepEqual(seen.diffs, [undefined]);
    assert.deepEqual(callsOf({ calls }, 'sandbox.diff'), [{ leaseId }]);

    assert.equal(await lease.sandbox.stats?.(), undefined);
    assert.equal(await lease.sandbox.ssh(), undefined);

    const cloned = await lease.sandbox.cloneRepo({
      url: 'https://example.com/repo.git',
      auth: { kind: 'token', token: 'secret-token', username: 'bot' },
    });
    assert.deepEqual(cloned, { path: '/work/repo', commit: 'abc123' });
    assert.deepEqual(seen.clones[0]?.auth, {
      kind: 'token',
      token: 'secret-token',
      username: 'bot',
    });
    const [cloneCall] = callsOf({ calls }, 'sandbox.cloneRepo') as {
      request?: { auth?: unknown };
    }[];
    assert.deepEqual(cloneCall?.request?.auth, {
      token: { token: 'secret-token', username: 'bot' },
    });

    assert.ok(
      sandboxProvider.operations.every(({ leaseId: id }) => id === leaseId),
      'every operation names the lease',
    );
  });

  test("4: start passes each output to onOutput in order, sends write/resize in call order, resolves result with the exit, terminate() aborts the fake's Start; a sandbox without start rejects unsupported_operation", async (t) => {
    const { sandbox, processes } = recordingSandbox({ startable: true });
    const { context, sandboxProvider } = await contextHarness(t, {
      sandbox: { sandbox },
    });
    const port = routedSandbox(context.services);
    const lease = await within(
      port.acquire({ identity: 'p-1', signal: new AbortController().signal }),
      'acquire',
    );
    const seen: SandboxProcessOutput[] = [];

    const process = await within(
      lease.sandbox.start?.({
        cmd: ['sh'],
        cols: 120,
        rows: 40,
        onOutput: (output) => seen.push(output),
      }) ?? Promise.reject(new Error('the lease sandbox has no start')),
      'start',
    );
    await eventually(
      () => processes.length === 1,
      'the fake started the process',
    );
    const [running] = processes;
    assert.ok(running !== undefined);
    assert.deepEqual(running.input.cmd, ['sh']);
    assert.equal(running.input.cols, 120);
    assert.equal(running.input.rows, 40);

    running.input.onOutput?.({ stream: 'stdout', data: 'a' });
    running.input.onOutput?.({ stream: 'stderr', data: 'b' });
    running.input.onOutput?.({ stream: 'stdout', data: 'c' });
    await process.write('x');
    await process.resize(80, 24);
    await process.write('y');
    await eventually(
      () => sandboxProvider.starts[0]?.requests.length === 3,
      'the writes and the resize at the fake',
    );
    assert.deepEqual(sandboxProvider.starts[0]?.requests, [
      { write: 'x' },
      { resize: [80, 24] },
      { write: 'y' },
    ]);
    await eventually(() => seen.length === 3, 'the outputs');
    running.finish({
      exitCode: 0,
      stdout: 'ac',
      stderr: 'b',
      stdoutBytes: new TextEncoder().encode('ac'),
      stderrBytes: new TextEncoder().encode('b'),
    });
    const result = await within(process.result, 'the result');
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'ac');
    assert.deepEqual(seen, [
      { stream: 'stdout', data: 'a' },
      { stream: 'stderr', data: 'b' },
      { stream: 'stdout', data: 'c' },
    ]);

    const second = await within(
      lease.sandbox.start?.({ cmd: ['sleep', '60'] }) ??
        Promise.reject(new Error('the lease sandbox has no start')),
      'start',
    );
    await eventually(
      () => sandboxProvider.starts.length === 2,
      'the second Start',
    );
    await second.terminate();
    await eventually(
      () => sandboxProvider.starts[1]?.signal.aborted === true,
      "the fake's Start call aborted",
    );
    await rejectionOf(second.result, 'the terminated result');

    const plain = await contextHarness(t, {
      sandbox: { sandbox: recordingSandbox().sandbox },
    });
    const plainLease = await within(
      routedSandbox(plain.context.services).acquire({
        identity: 'p-2',
        signal: new AbortController().signal,
      }),
      'acquire',
    );
    await assertFails(
      plainLease.sandbox.start?.({ cmd: ['sh'] }) ??
        Promise.reject(new Error('the lease sandbox has no start')),
      'unsupported_operation',
    );
  });
});
