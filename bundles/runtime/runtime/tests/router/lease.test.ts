// `runtime.lease/v1` over the router (phase 3, slice S47a, contract §2.6,
// §4): which sandbox a call targets (Thread session, prompt, Project or
// Thread scope), the not-ready refusals with their `leaseStatus`, and each
// operation on the fake `sandbox/v1` provider by lease id. Tests 5–20 of the
// slice.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { MessageInitShape } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import type { CallScope, ContractError } from 'bundle/contracts';
import type { SandboxLease } from 'sandpool';

import type {
  PutFileRequestSchema,
  StartRequestSchema,
} from '../../src/contracts/gen/doric/runtime/lease/v1/lease_pb.js';
import type { ScriptedRun } from '../support/executor.js';
import {
  largeFile,
  MiB,
  type RecordingSandboxOptions,
  recordingSandbox,
} from './sandbox.js';
import {
  callsOf,
  collect,
  contractErrorOf,
  eventually,
  type Gate,
  gate,
  type Harness,
  type HarnessOptions,
  harness,
  projectState,
  rejectionOf,
  settle,
  started,
  within,
} from './support.js';

const unknownId = '00000000-0000-4000-8000-00000000ffff';
const scopeMessage = 'runtime.lease/v1 needs a Project or Thread scope.';

/** A ready Project created through `runtime/v2`. */
const readyProject = async (h: Harness, name = 'Project') => {
  const { project } = await h.runtime().createProject({ name });
  assert.ok(project !== undefined);
  await projectState(h, project.id, 'ready');

  return project;
};

/** A started harness whose Projects lease one recording sandbox. */
const leased = async (
  t: Parameters<typeof started>[0],
  sandboxOptions: RecordingSandboxOptions = {},
  options: HarnessOptions = {},
) => {
  const recording = recordingSandbox({
    id: 'vm-5',
    root: '/srv',
    ...sandboxOptions,
  });
  const h = await started(t, {
    ...options,
    sandbox: { ...options.sandbox, sandbox: recording.sandbox },
  });

  return { h, ...recording };
};

/** The failure of `promise`: its gRPC code and its Doric error. */
const failure = async (
  promise: Promise<unknown>,
): Promise<{ readonly grpc: Code; readonly error: ContractError }> => {
  const rejected = await rejectionOf(promise);
  assert.ok(rejected instanceof ConnectError, String(rejected));

  return { grpc: rejected.code, error: contractErrorOf(rejected) };
};

/** Asserts an `UNAVAILABLE` lease failure with `leaseStatus`. */
const assertLeaseUnavailable = async (
  promise: Promise<unknown>,
  leaseStatus: string,
) => {
  const { grpc, error } = await failure(promise);
  assert.equal(grpc, Code.Unavailable, error.message);
  assert.equal(error.code, 'unavailable');
  assert.deepEqual(error.details, { leaseStatus });

  return error;
};

/** Every item of a server stream. */
const drain = async <T>(stream: AsyncIterable<T>): Promise<T[]> => {
  const items: T[] = [];
  for await (const item of stream) items.push(item);

  return items;
};

/** `items` as a request stream that half-closes after the last. */
async function* requestsOf<T>(items: readonly T[]): AsyncGenerator<T> {
  yield* items;
}

/** A request stream a case pushes into and half-closes. */
const pushable = <T>() => {
  const items: T[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  const rouse = () => {
    wake?.();
    wake = undefined;
  };

  return {
    push: (item: T) => {
      items.push(item);
      rouse();
    },
    end: () => {
      closed = true;
      rouse();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      for (;;) {
        if (items.length > 0) {
          yield items.shift() as T;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
};

type StartItem = MessageInitShape<typeof StartRequestSchema>;
type PutFileItem = MessageInitShape<typeof PutFileRequestSchema>;

const head = (cmd: readonly string[] = ['sh']): StartItem => ({
  item: { case: 'head', value: { request: { cmd: [...cmd] } } },
});

/** The `sandbox/v1.Exec` calls whose command is `cmd`, as JSON. */
const execsOf = (h: Harness, cmd: readonly string[]) =>
  (
    callsOf(h, 'sandbox.exec') as {
      leaseId?: string;
      request?: { cmd?: string[] };
    }[]
  ).filter(
    ({ request }) => JSON.stringify(request?.cmd) === JSON.stringify(cmd),
  );

/** Resolves when `held` opens or the run is stopped. */
const holdUntil = (held: Gate, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    void held.promise.then(resolve);
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });

describe('runtime.lease/v1', () => {
  test('5: before activate resolved, Describe fails UNAVAILABLE, code unavailable', async (t) => {
    const held = gate();
    const h = harness({ defineTypeGate: held.promise });
    t.after(() => h.stop());
    const activation = h.activate();
    await settle();

    const { grpc, error } = await failure(
      h.lease({ projectId: unknownId }).describe({}),
    );

    assert.equal(grpc, Code.Unavailable);
    assert.equal(error.code, 'unavailable');
    held.open();
    await within(activation, 'activate');
  });

  test('6: with no scope and no session, every operation fails INVALID_ARGUMENT with the scope message and reaches no sandbox (no first-active-Project fallback)', async (t) => {
    const { h, seen, processes } = await leased(t, { startable: true });
    await readyProject(h);
    await settle();
    const operations = h.sandboxProvider.operations.length;
    const lease = h.lease();
    const path = { request: { path: '/srv/a' } };
    const calls: [string, () => Promise<unknown>][] = [
      ['Describe', () => lease.describe({})],
      ['Exec', () => lease.exec({ request: { cmd: ['echo', 'nobody'] } })],
      ['ReadFile', () => lease.readFile(path)],
      ['ReadFileBytes', () => drain(lease.readFileBytes(path))],
      [
        'WriteFile',
        () => lease.writeFile({ request: { path: '/srv/a', content: 'x' } }),
      ],
      ['Ssh', () => lease.ssh({})],
      ['Diff', () => lease.diff({})],
      ['Start', () => drain(lease.start(requestsOf([head()])))],
      [
        'PutFile',
        () =>
          lease.putFile(
            requestsOf<PutFileItem>([
              { item: { case: 'head', value: path } },
              { item: { case: 'chunk', value: new Uint8Array([1]) } },
            ]),
          ),
      ],
      ['GetFile', () => drain(lease.getFile(path))],
      ['Stats', () => lease.stats({})],
    ];

    for (const [name, call] of calls) {
      const { grpc, error } = await failure(call());
      assert.equal(grpc, Code.InvalidArgument, `${name}: ${error.message}`);
      assert.equal(error.code, 'invalid_input', name);
      assert.equal(error.message, scopeMessage, name);
    }
    await settle();
    assert.equal(h.sandboxProvider.operations.length, operations);
    assert.deepEqual(execsOf(h, ['echo', 'nobody']), []);
    assert.equal(seen.puts.length, 0);
    assert.equal(processes.length, 0);
  });

  test("7: Project scope with a ready lease: Describe answers the fake's {id, root}; Exec runs on that lease and answers its result (no exitCode for a killed command)", async (t) => {
    const { h } = await leased(t);
    const project = await readyProject(h);
    const [leaseId] = h.sandboxProvider.leases();
    const lease = h.lease({ projectId: project.id });

    const described = await lease.describe({});
    assert.equal(described.id, 'vm-5');
    assert.equal(described.root, '/srv');

    const { response } = await lease.exec({ request: { cmd: ['echo', 'hi'] } });
    assert.equal(response?.exitCode, 3);
    assert.equal(response?.stdout, 'out');
    assert.deepEqual(
      execsOf(h, ['echo', 'hi']).map(({ leaseId: id }) => id),
      [leaseId],
    );

    const killed = await lease.exec({ request: { cmd: ['killed'] } });
    assert.equal(killed.response?.exitCode, undefined);
    assert.equal(killed.response?.stderr, 'killed');
  });

  test("8: Thread scope resolves the Thread's Project; an unknown Thread fails UNAVAILABLE with leaseStatus missing", async (t) => {
    const { h } = await leased(t);
    const project = await readyProject(h);
    const created = await h
      .threads()
      .createThread({ projectId: project.id, name: 'Thread' });
    assert.ok(created.thread !== undefined);

    const described = await h
      .lease({ threadId: created.thread.id })
      .describe({});
    assert.equal(described.id, 'vm-5');

    await assertLeaseUnavailable(
      h.lease({ threadId: unknownId }).describe({}),
      'missing',
    );
  });

  test("9: a lease that is not ready fails UNAVAILABLE with today's message and its leaseStatus (missing, expired, pending, unavailable), and reaches no sandbox", async (t) => {
    const acquireHeld = gate();
    const releaseHeld = gate();
    t.after(() => {
      acquireHeld.open();
      releaseHeld.open();
    });
    const { sandbox } = recordingSandbox({ id: 'vm-5', root: '/srv' });
    let holdNext = false;
    const h = await started(t, {
      sandbox: {
        acquire: async ({ signal }) => {
          if (holdNext) await holdUntil(acquireHeld, signal);
          return {
            sandbox,
            release: async () => {
              await releaseHeld.promise;
            },
          } as unknown as SandboxLease;
        },
      },
    });
    const notReady = async (scope: CallScope, leaseStatus: string) => {
      const error = await assertLeaseUnavailable(
        h.lease(scope).exec({ request: { cmd: ['echo', leaseStatus] } }),
        leaseStatus,
      );
      assert.equal(
        error.message,
        `Project lease is not ready (${leaseStatus}).`,
      );
      assert.deepEqual(execsOf(h, ['echo', leaseStatus]), []);
    };

    await notReady({ projectId: unknownId }, 'missing');

    releaseHeld.open();
    const ended = await readyProject(h, 'Ended');
    await h.runtime().terminateProject({ id: ended.id });
    await projectState(h, ended.id, 'cancelled');
    await notReady({ projectId: ended.id }, 'expired');

    holdNext = true;
    const { project: pending } = await h
      .runtime()
      .createProject({ name: 'Pending' });
    assert.ok(pending !== undefined);
    await eventually(
      () => callsOf(h, 'sandbox.acquire').length === 2,
      'the held Acquire',
    );
    await notReady({ projectId: pending.id }, 'pending');
  });

  test('9: a closing Project (its lease release held) fails UNAVAILABLE with leaseStatus unavailable', async (t) => {
    const releaseHeld = gate();
    t.after(() => releaseHeld.open());
    const { h } = await leased(
      t,
      {},
      {
        sandbox: { release: () => releaseHeld.promise },
      },
    );
    const project = await readyProject(h);

    const terminated = h.runtime().terminateProject({ id: project.id });
    await eventually(
      () => callsOf(h, 'sandbox.release').length === 1,
      'the held Release',
    );
    const error = await assertLeaseUnavailable(
      h
        .lease({ projectId: project.id })
        .exec({ request: { cmd: ['echo', 'closing'] } }),
      'unavailable',
    );
    assert.equal(error.message, 'Project lease is not ready (unavailable).');
    assert.deepEqual(execsOf(h, ['echo', 'closing']), []);

    releaseHeld.open();
    await within(terminated, 'TerminateProject');
  });

  test("10: expectSandboxId equal to the lease's sandbox runs; a different one fails UNAVAILABLE with leaseStatus unavailable and reaches no sandbox (T3.4)", async (t) => {
    const { h } = await leased(t);
    const project = await readyProject(h);
    const lease = h.lease({ projectId: project.id });

    const { response } = await lease.exec({
      target: { expectSandboxId: 'vm-5' },
      request: { cmd: ['echo', 'expected'] },
    });
    assert.equal(response?.stdout, 'out');

    await assertLeaseUnavailable(
      lease.exec({
        target: { expectSandboxId: 'vm-other' },
        request: { cmd: ['echo', 'replaced'] },
      }),
      'unavailable',
    );
    assert.deepEqual(execsOf(h, ['echo', 'replaced']), []);
  });

  test('11: a lease released under the operation (the provider answers unknown_lease) fails UNAVAILABLE with leaseStatus unavailable, not NOT_FOUND', async (t) => {
    let h: Harness | undefined;
    const { sandbox } = recordingSandbox({ id: 'vm-5', root: '/srv' });
    h = await started(t, {
      sandbox: {
        sandbox,
        beforeOperation: ({ method, leaseId }) => {
          if (method === 'exec') h?.sandboxProvider.drop(leaseId);
        },
      },
    });
    const project = await readyProject(h);

    await assertLeaseUnavailable(
      h
        .lease({ projectId: project.id })
        .exec({ request: { cmd: ['echo', 'lost'] } }),
      'unavailable',
    );
  });

  test('12: prompt scope runs on the bound sandbox while the prompt runs; after it finished the same call fails FAILED_PRECONDITION thread_control_inactive', async (t) => {
    const held = gate();
    t.after(() => held.open());
    const { h } = await leased(
      t,
      {},
      {
        execute: async (run: ScriptedRun) => {
          await holdUntil(held, run.signal);
          return 'done';
        },
      },
    );
    const project = await readyProject(h);
    const created = await h
      .threads()
      .createThread({ projectId: project.id, name: 'Thread' });
    assert.ok(created.thread !== undefined);
    const thread = created.thread;
    const { promptResult } = await h
      .threads()
      .prompt({ id: thread.id, prompt: 'Run.' });
    assert.ok(promptResult?.promptId !== undefined);
    await eventually(
      async () =>
        (await h.threads().thread({ id: thread.id })).thread?.state ===
        'running',
      'the running prompt',
    );
    const [leaseId] = h.sandboxProvider.leases();
    const lease = h.lease({
      projectId: project.id,
      threadId: thread.id,
      promptId: promptResult.promptId,
    });

    const { response } = await lease.exec({
      request: { cmd: ['echo', 'bound'] },
    });
    assert.equal(response?.stdout, 'out');
    assert.deepEqual(
      execsOf(h, ['echo', 'bound']).map(({ leaseId: id }) => id),
      [leaseId],
    );

    held.open();
    await eventually(
      async () =>
        (await h.threads().thread({ id: thread.id })).thread?.state === 'ready',
      'the finished prompt',
    );
    const { grpc, error } = await failure(
      lease.exec({ request: { cmd: ['echo', 'late'] } }),
    );
    assert.equal(grpc, Code.FailedPrecondition);
    assert.equal(error.code, 'thread_control_inactive');
    assert.deepEqual(execsOf(h, ['echo', 'late']), []);
  });

  test('13: a threadSessionId naming no session fails NOT_FOUND, unknown_session, whatever the scope', async (t) => {
    const { h } = await leased(t);
    const project = await readyProject(h);
    const target = { threadSessionId: 'no-such-session' };

    for (const scope of [undefined, { projectId: project.id }]) {
      const { grpc, error } = await failure(
        h.lease(scope).describe({ target }),
      );
      assert.equal(grpc, Code.NotFound, error.message);
      assert.equal(error.code, 'unknown_session');
    }
  });

  test('14: ReadFileBytes and GetFile of a 2.5 MiB file answer 3 items of at most 1 MiB that join to the file; an empty file answers no item', async (t) => {
    const { h, files } = await leased(t);
    const project = await readyProject(h);
    const bytes = largeFile();
    files.set('/srv/big.bin', bytes);
    files.set('/srv/empty', new Uint8Array());
    const lease = h.lease({ projectId: project.id });

    const reads: [
      string,
      (path: string) => AsyncIterable<{ chunk: Uint8Array }>,
    ][] = [
      ['ReadFileBytes', (path) => lease.readFileBytes({ request: { path } })],
      ['GetFile', (path) => lease.getFile({ request: { path } })],
    ];
    for (const [name, read] of reads) {
      const items = await drain(read('/srv/big.bin'));
      assert.equal(items.length, 3, name);
      assert.ok(
        items.every(({ chunk }) => chunk.length > 0 && chunk.length <= MiB),
        name,
      );
      assert.deepEqual(
        Buffer.concat(items.map(({ chunk }) => chunk)),
        Buffer.from(bytes),
        name,
      );
      assert.deepEqual(await drain(read('/srv/empty')), [], name);
    }
  });

  test('15: PutFile with a head and 3 chunks writes the joined bytes once after the half-close; a leading chunk or a second head fails INVALID_ARGUMENT and writes nothing', async (t) => {
    const { h, seen } = await leased(t);
    const project = await readyProject(h);
    const lease = h.lease({ projectId: project.id });
    const bytes = largeFile();
    const requests = pushable<PutFileItem>();

    const put = lease.putFile(requests);
    requests.push({
      item: { case: 'head', value: { request: { path: '/srv/up.bin' } } },
    });
    for (let start = 0; start < bytes.length; start += MiB)
      requests.push({
        item: { case: 'chunk', value: bytes.subarray(start, start + MiB) },
      });
    await settle();
    assert.equal(
      seen.puts.length,
      0,
      'nothing is written before the half-close',
    );
    requests.end();
    await within(put, 'PutFile');

    assert.equal(seen.puts.length, 1);
    assert.equal(seen.puts[0]?.[0], '/srv/up.bin');
    assert.deepEqual(seen.puts[0]?.[1], bytes);

    const leading = await failure(
      lease.putFile(
        requestsOf<PutFileItem>([
          { item: { case: 'chunk', value: new Uint8Array([1]) } },
        ]),
      ),
    );
    assert.equal(leading.grpc, Code.InvalidArgument);
    const second = await failure(
      lease.putFile(
        requestsOf<PutFileItem>([
          { item: { case: 'head', value: { request: { path: '/srv/a' } } } },
          { item: { case: 'head', value: { request: { path: '/srv/b' } } } },
        ]),
      ),
    );
    assert.equal(second.grpc, Code.InvalidArgument);
    await settle();
    assert.equal(seen.puts.length, 1);
    assert.equal(h.sandboxProvider.putFiles.length, 1);
  });

  test("16: ReadFile, WriteFile, Diff (with and without request), Stats (with and without a reading) and Ssh (vmId is the sandbox id) answer the fake's values", async (t) => {
    const { h, seen } = await leased(t);
    const project = await readyProject(h);
    const lease = h.lease({ projectId: project.id });

    const read = await lease.readFile({ request: { path: '/srv/a.txt' } });
    assert.equal(read.response?.content, 'content of /srv/a.txt');

    await lease.writeFile({
      request: { path: '/srv/b.txt', content: 'hello' },
    });
    assert.deepEqual(seen.writes, [['/srv/b.txt', 'hello']]);

    const seenBefore = seen.diffs.length;
    const all = await lease.diff({});
    assert.equal(all.response?.diff, 'diff --git a/x b/x');
    const some = await lease.diff({
      request: { cwd: '/srv/app', paths: ['a.ts'] },
    });
    assert.equal(some.response?.diff, 'diff --git a/x b/x');
    assert.deepEqual(seen.diffs.slice(seenBefore), [
      undefined,
      { cwd: '/srv/app', paths: ['a.ts'] },
    ]);

    assert.equal((await lease.stats({})).response, undefined);
    const ssh = await lease.ssh({});
    assert.equal(ssh.vmId, 'vm-5');
    assert.equal(ssh.response, undefined);

    const access = {
      host: '10.0.0.2',
      port: 22,
      username: 'root' as const,
      privateKey: 'key',
      knownHosts: 'known',
      hostKeyFingerprint: 'SHA256:x',
    };
    const reading = {
      cpuPercent: 12.5,
      cpuCount: 2,
      memoryUsedBytes: 1024,
      memoryLimitBytes: 4096,
      at: '2026-11-23T12:00:00.000Z',
    };
    const other = await leased(t, { id: 'vm-6', stats: reading, ssh: access });
    const otherProject = await readyProject(other.h);
    const otherLease = other.h.lease({ projectId: otherProject.id });

    const stats = await otherLease.stats({});
    assert.equal(stats.response?.cpuPercent, 12.5);
    assert.equal(stats.response?.cpuCount, 2);
    assert.equal(stats.response?.memoryUsedBytes, 1024);
    assert.equal(stats.response?.memoryLimitBytes, 4096);
    assert.equal(stats.response?.at, '2026-11-23T12:00:00.000Z');
    const sshed = await otherLease.ssh({});
    assert.equal(sshed.vmId, 'vm-6');
    assert.equal(sshed.response?.host, '10.0.0.2');
    assert.equal(sshed.response?.username, 'root');
  });

  test('17: Start runs the head on the lease, forwards writes and resizes in order, answers every output in order, then exit, then ends; a first item that is not a head fails INVALID_ARGUMENT and starts nothing', async (t) => {
    const { h, processes } = await leased(t, { startable: true });
    const project = await readyProject(h);
    const [leaseId] = h.sandboxProvider.leases();
    const lease = h.lease({ projectId: project.id });
    const requests = pushable<StartItem>();

    const items = collect(lease.start(requests));
    requests.push(head(['bash']));
    await eventually(() => processes.length === 1, 'the started process');
    const [running] = processes;
    assert.ok(running !== undefined);
    assert.deepEqual(running.input.cmd, ['bash']);
    assert.equal(h.sandboxProvider.starts[0]?.leaseId, leaseId);

    requests.push({ item: { case: 'write', value: 'ls\n' } });
    requests.push({ item: { case: 'resize', value: { cols: 100, rows: 30 } } });
    requests.push({ item: { case: 'write', value: 'exit\n' } });
    await eventually(
      () => running.writes.length === 2 && running.resizes.length === 1,
      'the writes and the resize',
    );
    assert.deepEqual(h.sandboxProvider.starts[0]?.requests, [
      { write: 'ls\n' },
      { resize: [100, 30] },
      { write: 'exit\n' },
    ]);

    running.input.onOutput?.({ stream: 'stdout', data: 'one' });
    running.input.onOutput?.({ stream: 'stderr', data: 'two' });
    await items.waitFor(2, 'the outputs');
    running.finish({
      exitCode: 0,
      stdout: 'one',
      stderr: 'two',
      stdoutBytes: new TextEncoder().encode('one'),
      stderrBytes: new TextEncoder().encode('two'),
    });
    requests.end();
    await within(items.done, 'the end of Start');

    assert.equal(items.error(), undefined);
    assert.deepEqual(
      items.items.map(({ item }) =>
        item.case === 'output'
          ? [item.value.stream, item.value.data]
          : [item.case, item.value?.exitCode],
      ),
      [
        ['stdout', 'one'],
        ['stderr', 'two'],
        ['exit', 0],
      ],
    );

    const refused = await failure(
      drain(
        lease.start(
          requestsOf<StartItem>([{ item: { case: 'write', value: 'ls\n' } }]),
        ),
      ),
    );
    assert.equal(refused.grpc, Code.InvalidArgument);
    assert.equal(processes.length, 1, 'nothing else started');
  });

  test('18: Start on a sandbox without start fails UNIMPLEMENTED, code unsupported_operation', async (t) => {
    const { h } = await leased(t);
    const project = await readyProject(h);

    const { grpc, error } = await failure(
      drain(h.lease({ projectId: project.id }).start(requestsOf([head()]))),
    );

    assert.equal(grpc, Code.Unimplemented, error.message);
    assert.equal(error.code, 'unsupported_operation');
  });

  test("19: cancelling a Start call aborts the fake's Start call; half-closing the request side does not, and the output still arrives", async (t) => {
    const { h, processes } = await leased(t, { startable: true });
    const project = await readyProject(h);
    const lease = h.lease({ projectId: project.id });

    const halfClosed = pushable<StartItem>();
    const kept = collect(lease.start(halfClosed));
    halfClosed.push(head(['tail', '-f']));
    halfClosed.end();
    await eventually(() => processes.length === 1, 'the first process');
    await settle();
    assert.equal(h.sandboxProvider.starts[0]?.signal.aborted, false);
    processes[0]?.input.onOutput?.({ stream: 'stdout', data: 'still here' });
    await kept.waitFor(1, 'the output after the half-close');
    processes[0]?.finish({
      exitCode: 0,
      stdout: 'still here',
      stderr: '',
      stdoutBytes: new TextEncoder().encode('still here'),
      stderrBytes: new Uint8Array(),
    });
    await within(kept.done, 'the end of the first Start');
    assert.equal(kept.error(), undefined);

    const controller = new AbortController();
    const cancelled = pushable<StartItem>();
    const items = collect(
      lease.start(cancelled, { signal: controller.signal }),
    );
    cancelled.push(head(['sleep', '60']));
    await eventually(
      () => h.sandboxProvider.starts.length === 2,
      'the second Start',
    );
    controller.abort();
    await eventually(
      () => h.sandboxProvider.starts[1]?.signal.aborted === true,
      "the fake's Start call aborted",
    );
    await within(items.done, 'the cancelled Start');
  });

  test("20: cancelling a lease Exec aborts the fake's Exec signal; a 200 ms deadline reaches the fake as an abort at the deadline (not detached)", async (t) => {
    const { h } = await leased(t);
    const project = await readyProject(h);
    const lease = h.lease({ projectId: project.id });
    const execOperations = () =>
      h.sandboxProvider.operations.filter(({ method }) => method === 'exec');
    const before = execOperations().length;

    const controller = new AbortController();
    const cancelled = lease.exec(
      { request: { cmd: ['hold'] } },
      { signal: controller.signal },
    );
    await eventually(
      () => execOperations().length === before + 1,
      'the held Exec',
    );
    controller.abort();
    await rejectionOf(cancelled, 'the cancelled Exec');
    await eventually(
      () => execOperations()[before]?.signal.aborted === true,
      "the fake's Exec signal aborted",
    );

    const startedAt = performance.now();
    const timed = lease.exec(
      { request: { cmd: ['hold'] } },
      { timeoutMs: 200 },
    );
    await eventually(
      () => execOperations().length === before + 2,
      'the timed Exec',
    );
    await rejectionOf(timed, 'the timed Exec');
    await eventually(
      () => execOperations()[before + 1]?.signal.aborted === true,
      "the fake's Exec signal aborted at the deadline",
      2_000,
    );
    assert.ok(performance.now() - startedAt >= 150, 'not before the deadline');
  });
});
