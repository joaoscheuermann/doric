import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import type { MessageInitShape } from '@bufbuild/protobuf';
import { Code } from '@connectrpc/connect';
import type {
  PutFileRequestSchema,
  StartRequestSchema,
} from 'runtime/contracts/gen/doric/sandbox/v1/sandbox_pb.js';

import {
  callerOf,
  collect,
  concat,
  eventually,
  execResult,
  type FakeBehavior,
  failsWith,
  fakeProvider,
  patterned,
  requestStream,
  serveFirecracker,
  withoutStart,
} from './support/served.js';

// `sandbox/v1` by lease id through the router (phase 3, S44; spec
// `docs/designs/grpc-processes.md`, "Sandbox leases"): the firecracker host part
// served as `src/host/main.ts` serves it, over a fake sandbox provider.

type StartItem = MessageInitShape<typeof StartRequestSchema>;
type PutItem = MessageInitShape<typeof PutFileRequestSchema>;

const projectId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
const MiB = 1024 * 1024;

const open = async (
  t: TestContext,
  behavior: FakeBehavior = {},
  options: Parameters<typeof serveFirecracker>[1] = {},
) => {
  const fake = fakeProvider(behavior);
  const served = await serveFirecracker(fake, options);

  t.after(() => served.stop());

  return { fake, served };
};

const head = (leaseId: string, cmd: readonly string[] = ['sh']): StartItem => ({
  item: { case: 'head', value: { leaseId, request: { cmd: [...cmd] } } },
});

const unknownLease = failsWith(Code.NotFound, 'unknown_lease');

void test('Acquire answers a lease on a new sandbox, and Exec on it runs there and answers its result', async (t) => {
  const { fake, served } = await open(t, {
    exec: () =>
      execResult({
        exitCode: null,
        stdout: 'out',
        stderr: 'err',
        stdoutBytes: new Uint8Array([1, 2, 255]),
        stderrBytes: new Uint8Array([0]),
      }),
  });
  const client = served.client();

  const lease = await client.acquire({ identity: 'p1' });

  assert.ok(lease.leaseId.length > 0);
  assert.equal(lease.sandboxId, 'vm-1');
  assert.equal(lease.root, '/workspace');

  const { response } = await client.exec({
    leaseId: lease.leaseId,
    request: { cmd: ['echo', 'hi'] },
  });

  assert.deepEqual(
    fake.execs.map(({ sandboxId, input }) => [sandboxId, input.cmd]),
    [['vm-1', ['echo', 'hi']]],
  );
  assert.equal(response?.exitCode, undefined);
  assert.equal(response?.stdout, 'out');
  assert.equal(response?.stderr, 'err');
  assert.deepEqual(response?.stdoutBytes, new Uint8Array([1, 2, 255]));
  assert.deepEqual(response?.stderrBytes, new Uint8Array([0]));
});

void test('Exec on an unknown lease or another instance’s lease fails with unknown_lease and runs nothing', async (t) => {
  const { fake, served } = await open(t);
  const owner = served.client(callerOf('runtime', 1));
  const other = served.client(callerOf('runtime', 2));
  const lease = await owner.acquire({ identity: 'p1' });

  await assert.rejects(
    owner.exec({ leaseId: 'no-such-lease', request: { cmd: ['true'] } }),
    unknownLease,
  );
  await assert.rejects(
    other.exec({ leaseId: lease.leaseId, request: { cmd: ['true'] } }),
    unknownLease,
  );
  assert.deepEqual(fake.execs, []);
});

void test('a released lease is gone: a second Release is a no-op and later operations fail with unknown_lease', async (t) => {
  const { fake, served } = await open(t);
  const client = served.client();
  const lease = await client.acquire({ identity: 'p1' });

  await client.release({ leaseId: lease.leaseId });
  await client.release({ leaseId: lease.leaseId });

  await eventually(() => fake.disposed.includes('vm-1'), 'vm-1 disposed');
  await assert.rejects(
    client.exec({ leaseId: lease.leaseId, request: { cmd: ['true'] } }),
    unknownLease,
  );
  await assert.rejects(client.ssh({ leaseId: lease.leaseId }), unknownLease);
  assert.deepEqual(fake.execs, []);
});

void test('Release of another instance’s lease leaves it held and usable by its owner', async (t) => {
  const { fake, served } = await open(t);
  const owner = served.client(callerOf('runtime', 1));
  const other = served.client(callerOf('transport', 1));
  const lease = await owner.acquire({ identity: 'p1' });

  await other.release({ leaseId: lease.leaseId });

  const { response } = await owner.exec({
    leaseId: lease.leaseId,
    request: { cmd: ['true'] },
  });

  assert.equal(response?.exitCode, 0);
  assert.deepEqual(fake.disposed, []);
  assert.equal(served.pool().status().leased, 1);
});

void test('when an instance is gone its leases are released and fail with unknown_lease; another instance’s lease is untouched', async (t) => {
  const { fake, served } = await open(t);
  const a = callerOf('runtime', 1);
  const b = callerOf('runtime', 2);
  const leaseA = await served.client(a).acquire({ identity: 'project-a' });
  const leaseB = await served.client(b).acquire({ identity: 'project-b' });

  served.gone(a);

  await eventually(() => fake.disposed.includes(leaseA.sandboxId), 'A’s sandbox disposed');
  await assert.rejects(
    served.client(a).exec({ leaseId: leaseA.leaseId, request: { cmd: ['true'] } }),
    unknownLease,
  );

  const { response } = await served
    .client(b)
    .exec({ leaseId: leaseB.leaseId, request: { cmd: ['true'] } });

  assert.equal(response?.exitCode, 0);
  assert.ok(!fake.disposed.includes(leaseB.sandboxId));
});

void test('Start relays writes and resizes in order, answers each output in order, then the exit, then ends', async (t) => {
  const { fake, served } = await open(t);
  const client = served.client();
  const lease = await client.acquire({ identity: 'p1' });
  const requests = requestStream<StartItem>();
  const responses = collect(client.start(requests.iterable));

  t.after(() => requests.close());

  requests.push(head(lease.leaseId, ['bash', '-l']));
  await eventually(() => fake.processes.length === 1, 'process started');

  const process = fake.processes[0];

  assert.ok(process !== undefined);
  assert.equal(process.sandboxId, 'vm-1');
  assert.deepEqual(process.input.cmd, ['bash', '-l']);

  requests.push({ item: { case: 'write', value: 'x' } });
  requests.push({ item: { case: 'resize', value: { cols: 80, rows: 24 } } });
  await eventually(() => process.events.length === 2, 'write and resize reached');

  assert.deepEqual(process.events, ['write:x', 'resize:80x24']);

  process.output('stdout', 'one');
  process.output('stderr', 'two');
  process.output('stdout', 'three');
  process.finish(execResult({ exitCode: 3, stdout: 'onethree', stderr: 'two' }));

  const items = await responses;

  assert.deepEqual(
    items.map(({ item }) =>
      item.case === 'output'
        ? ['output', item.value.stream, item.value.data]
        : item.case === 'exit'
          ? ['exit', item.value.exitCode]
          : [item.case],
    ),
    [
      ['output', 'stdout', 'one'],
      ['output', 'stderr', 'two'],
      ['output', 'stdout', 'three'],
      ['exit', 3],
    ],
  );
});

void test('half-closing a Start stream does not stop the process', async (t) => {
  const { fake, served } = await open(t);
  const client = served.client();
  const lease = await client.acquire({ identity: 'p1' });
  const requests = requestStream<StartItem>();
  const responses = collect(client.start(requests.iterable));

  requests.push(head(lease.leaseId));
  requests.close();
  await eventually(() => fake.processes.length === 1, 'process started');

  const process = fake.processes[0];

  assert.ok(process !== undefined);
  process.output('stdout', 'late');
  process.finish(execResult({ exitCode: 0 }));

  const items = await responses;

  assert.equal(process.terminated, false);
  assert.deepEqual(
    items.map(({ item }) => item.case),
    ['output', 'exit'],
  );
});

void test('cancelling a Start call terminates the process', async (t) => {
  const { fake, served } = await open(t);
  const client = served.client();
  const lease = await client.acquire({ identity: 'p1' });
  const requests = requestStream<StartItem>();
  const abort = new AbortController();
  const responses = collect(client.start(requests.iterable, { signal: abort.signal }));

  t.after(() => requests.close());

  requests.push(head(lease.leaseId));
  await eventually(() => fake.processes.length === 1, 'process started');

  abort.abort();

  await assert.rejects(responses);
  await eventually(() => fake.processes[0]?.terminated === true, 'process terminated');
});

void test('Release and the owner’s InstanceGone do not end a Start stream already open on the lease', async (t) => {
  const { fake, served } = await open(t);
  const caller = callerOf('runtime', 1);
  const client = served.client(caller);
  const released = await client.acquire({ identity: 'project-a' });
  const dropped = await client.acquire({ identity: 'project-b' });
  const first = requestStream<StartItem>();
  const second = requestStream<StartItem>();
  const firstResponses = collect(client.start(first.iterable));
  const secondResponses = collect(client.start(second.iterable));

  t.after(() => {
    first.close();
    second.close();
  });

  first.push(head(released.leaseId));
  second.push(head(dropped.leaseId));
  await eventually(() => fake.processes.length === 2, 'both processes started');

  await client.release({ leaseId: released.leaseId });
  served.gone(caller);
  await eventually(() => fake.disposed.length === 2, 'both sandboxes released');

  for (const process of fake.processes) {
    assert.equal(process.terminated, false);
    process.output('stdout', 'still here');
    process.finish(execResult({ exitCode: 0 }));
  }

  for (const items of [await firstResponses, await secondResponses]) {
    assert.deepEqual(
      items.map(({ item }) => item.case),
      ['output', 'exit'],
    );
  }
});

void test('a Start whose first item is not a head fails with invalid_input and starts nothing', async (t) => {
  const { fake, served } = await open(t);
  const client = served.client();
  await client.acquire({ identity: 'p1' });
  const requests = requestStream<StartItem>();
  const responses = collect(client.start(requests.iterable));

  t.after(() => requests.close());

  requests.push({ item: { case: 'write', value: 'x' } });

  await assert.rejects(responses, failsWith(Code.InvalidArgument, 'invalid_input'));
  assert.deepEqual(fake.processes, []);
});

void test('Start on a sandbox without live processes fails with UNIMPLEMENTED', async (t) => {
  const { fake, served } = await open(t, {}, {
    adjust: (binding) => ({ ...binding, pool: withoutStart(binding.pool) }),
  });
  const client = served.client();
  const lease = await client.acquire({ identity: 'p1' });
  const requests = requestStream<StartItem>();
  const responses = collect(client.start(requests.iterable));

  t.after(() => requests.close());

  requests.push(head(lease.leaseId));

  await assert.rejects(
    responses,
    failsWith(Code.Unimplemented, 'unsupported_operation'),
  );
  assert.deepEqual(fake.processes, []);
});

void test('Start on an unknown lease fails with unknown_lease', async (t) => {
  const { fake, served } = await open(t);
  const requests = requestStream<StartItem>();
  const responses = collect(served.client().start(requests.iterable));

  t.after(() => requests.close());

  requests.push(head('no-such-lease'));

  await assert.rejects(responses, unknownLease);
  assert.deepEqual(fake.processes, []);
});

void test('PutFile writes the head’s path once with every chunk, in order', async (t) => {
  const { fake, served } = await open(t);
  const client = served.client();
  const lease = await client.acquire({ identity: 'p1' });
  const chunks = [patterned(5), new Uint8Array([9, 9]), patterned(3)];

  await client.putFile(
    (async function* (): AsyncGenerator<PutItem> {
      yield {
        item: {
          case: 'head',
          value: { leaseId: lease.leaseId, request: { path: 'out/data.bin' } },
        },
      };

      for (const chunk of chunks) {
        yield { item: { case: 'chunk', value: chunk } };
      }
    })(),
  );

  assert.deepEqual(
    fake.puts.map(({ sandboxId, path, bytes }) => ({ sandboxId, path, bytes })),
    [{ sandboxId: 'vm-1', path: '/workspace/out/data.bin', bytes: concat(chunks) }],
  );
});

void test('a PutFile stream that does not start with a head fails with invalid_input and writes nothing', async (t) => {
  const { fake, served } = await open(t);
  const client = served.client();
  await client.acquire({ identity: 'p1' });

  await assert.rejects(
    client.putFile(
      (async function* (): AsyncGenerator<PutItem> {
        yield { item: { case: 'chunk', value: new Uint8Array([1]) } };
      })(),
    ),
    failsWith(Code.InvalidArgument, 'invalid_input'),
  );
  assert.deepEqual(fake.puts, []);
});

void test('GetFile answers a file in chunks of at most 1 MiB, and an empty file with no item', async (t) => {
  const big = patterned(2.5 * MiB);
  const { served } = await open(t, {
    files: new Map([
      ['/workspace/big.bin', big],
      ['/workspace/empty.bin', new Uint8Array()],
    ]),
  });
  const client = served.client();
  const lease = await client.acquire({ identity: 'p1' });

  const chunks = (
    await collect(
      client.getFile({ leaseId: lease.leaseId, request: { path: 'big.bin' } }),
    )
  ).map(({ chunk }) => chunk);

  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((chunk) => chunk.length > 0 && chunk.length <= MiB));
  assert.ok(Buffer.from(concat(chunks)).equals(Buffer.from(big)));

  assert.deepEqual(
    await collect(
      client.getFile({ leaseId: lease.leaseId, request: { path: 'empty.bin' } }),
    ),
    [],
  );
});

void test('Stats and Ssh answer no response when the sandbox has none', async (t) => {
  const { served } = await open(t);
  const client = served.client();
  const lease = await client.acquire({ identity: 'p1' });

  assert.equal((await client.stats({ leaseId: lease.leaseId })).response, undefined);
  assert.equal((await client.ssh({ leaseId: lease.leaseId })).response, undefined);
});

void test('Stats and Ssh answer the sandbox’s reading and access', async (t) => {
  const { served } = await open(t, {
    stats: { cpuPercent: 12.5, memoryUsedBytes: 1024, at: '2026-11-23T10:00:00.000Z' },
    ssh: {
      host: '10.0.0.2',
      port: 2222,
      username: 'root',
      privateKey: 'KEY',
      knownHosts: 'known',
      hostKeyFingerprint: 'SHA256:abc',
    },
  });
  const client = served.client();
  const lease = await client.acquire({ identity: 'p1' });

  const stats = (await client.stats({ leaseId: lease.leaseId })).response;
  const ssh = (await client.ssh({ leaseId: lease.leaseId })).response;

  assert.equal(stats?.cpuPercent, 12.5);
  assert.equal(stats?.memoryUsedBytes, 1024);
  assert.equal(stats?.cpuCount, undefined);
  assert.equal(stats?.at, '2026-11-23T10:00:00.000Z');
  assert.equal(ssh?.host, '10.0.0.2');
  assert.equal(ssh?.port, 2222);
  assert.equal(ssh?.privateKey, 'KEY');
});

void test('ReadFile, WriteFile, Diff and CloneRepo with token auth pass through to the sandbox', async (t) => {
  const { fake, served } = await open(t, {
    files: new Map([['/workspace/notes.txt', new TextEncoder().encode('héllo')]]),
    exec: ({ cmd }) =>
      cmd.includes('rev-parse')
        ? execResult({ stdout: 'abc123\n' })
        : cmd[0] === 'git' && cmd[1] === 'diff'
          ? execResult({ stdout: 'diff --git a/x b/x\n' })
          : execResult(),
  });
  const client = served.client();
  const lease = await client.acquire({ identity: 'p1' });

  assert.equal(
    (await client.readFile({ leaseId: lease.leaseId, request: { path: 'notes.txt' } }))
      .response?.content,
    'héllo',
  );

  await client.writeFile({
    leaseId: lease.leaseId,
    request: { path: 'dir/new.txt', content: 'written' },
  });

  assert.deepEqual(
    fake.puts.map(({ path, bytes }) => [path, new TextDecoder().decode(bytes)]),
    [['/workspace/dir/new.txt', 'written']],
  );

  const cloned = await client.cloneRepo({
    leaseId: lease.leaseId,
    request: {
      url: 'https://example.com/repo.git',
      auth: { kind: { case: 'token', value: { token: 'tok-1' } } },
    },
  });

  assert.deepEqual(
    { path: cloned.response?.path, commit: cloned.response?.commit },
    { path: '/workspace/repo', commit: 'abc123' },
  );

  const clone = fake.execs.find(({ input }) => input.cmd.includes('clone'));

  assert.ok(clone !== undefined, 'git clone ran in the sandbox');
  assert.ok(
    (clone.input.env ?? []).some((entry) =>
      entry.includes(Buffer.from('x-access-token:tok-1').toString('base64')),
    ),
    'the token reached the clone',
  );

  const diff = await client.diff({ leaseId: lease.leaseId });

  assert.equal(diff.response?.diff, 'diff --git a/x b/x\n');
});

void test('Describe answers firecracker without a durable workspace, Discard succeeds with nothing to discard, and Machines lists the leased sandboxes', async (t) => {
  const { fake, served } = await open(t);
  const client = served.client();

  const description = await client.describe({});

  assert.deepEqual(
    { provider: description.provider, durableWorkspace: description.durableWorkspace },
    { provider: 'firecracker', durableWorkspace: false },
  );

  await client.discard({ identity: projectId });

  assert.deepEqual(fake.provisioned, []);

  await client.acquire({ identity: 'project-a' });
  await client.acquire({ identity: 'project-b' });

  assert.deepEqual(
    (await client.machines({})).machines
      .map(({ id, provider }) => ({ id, provider }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: 'vm-1', provider: 'firecracker' },
      { id: 'vm-2', provider: 'firecracker' },
    ],
  );

  const known = await client.machine({ id: 'vm-1' });

  assert.deepEqual(
    { id: known.runningMachine?.id, provider: known.runningMachine?.provider },
    { id: 'vm-1', provider: 'firecracker' },
  );
  assert.equal((await client.machine({ id: 'missing' })).runningMachine, undefined);
});

void test('cancelling Acquire before the pool answers keeps no lease: the late sandbox is released', async (t) => {
  let provision!: () => void;
  const { fake, served } = await open(t, {
    provisioning: new Promise<void>((resolve) => {
      provision = resolve;
    }),
  });
  const abort = new AbortController();
  const acquiring = served
    .client()
    .acquire({ identity: 'p1' }, { signal: abort.signal });

  await eventually(() => fake.provisioned.length === 1, 'provisioning started');
  abort.abort();
  await assert.rejects(acquiring);

  provision();

  await eventually(() => fake.disposed.includes('vm-1'), 'late sandbox released');
  assert.equal(served.pool().status().leased, 0);
  assert.deepEqual((await served.client().machines({})).machines, []);
});

void test('releaseAll releases every lease of every instance, and stopping the bundle disposes every sandbox', async (t) => {
  const { fake, served } = await open(t);
  const a = served.client(callerOf('runtime', 1));
  const b = served.client(callerOf('transport', 1));
  const leaseA = await a.acquire({ identity: 'project-a' });
  await b.acquire({ identity: 'project-b' });

  await served.sandbox.releaseAll();

  assert.deepEqual([...fake.disposed].sort(), ['vm-1', 'vm-2']);
  assert.equal(served.pool().status().leased, 0);
  await assert.rejects(
    a.exec({ leaseId: leaseA.leaseId, request: { cmd: ['true'] } }),
    unknownLease,
  );

  await a.acquire({ identity: 'project-c' });
  await served.stop();

  assert.deepEqual([...fake.disposed].sort(), ['vm-1', 'vm-2', 'vm-3']);
});

void test('every RPC fails with unavailable while there is no binding', async (t) => {
  const { fake, served } = await open(t, {}, { unbound: true });
  const client = served.client();
  const unavailable = failsWith(Code.Unavailable, 'unavailable');

  await assert.rejects(client.describe({}), unavailable);
  await assert.rejects(client.acquire({ identity: 'p1' }), unavailable);
  await assert.rejects(client.machines({}), unavailable);
  assert.deepEqual(fake.provisioned, []);
});
