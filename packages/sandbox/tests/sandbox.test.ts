import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  SandboxExecInput,
  SandboxExecResult,
  SandboxProvider,
  SandboxProvisionInput,
  SandboxRuntime,
  SandboxSshAccess,
} from '../src/index.js';
import { createSandbox, normalizeSandboxNetwork } from '../src/index.js';

const resources = { cpuCount: 1, memoryMiB: 512, diskMiB: 4096 };

const ok = (stdout = ''): SandboxExecResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  stdoutBytes: Buffer.from(stdout),
  stderrBytes: new Uint8Array(),
});

type Fake = {
  provider: SandboxProvider;
  readonly provisions: SandboxProvisionInput[];
  readonly execs: SandboxExecInput[];
  readonly files: Map<string, Uint8Array>;
  disposals: number;
  access: SandboxSshAccess | undefined;
};

const fake = (): Fake => {
  const value: Fake = {
    provisions: [],
    execs: [],
    files: new Map(),
    disposals: 0,
    access: undefined,
    provider: undefined as never,
  };

  const runtime: SandboxRuntime = {
    id: 'runtime-1',
    async exec(input) {
      value.execs.push(input);

      if (input.cmd.join(' ') === 'git -C /workspace/repo rev-parse HEAD') {
        return ok('abc123\n');
      }

      return ok();
    },
    async putFile(path, bytes) {
      value.files.set(path, bytes);
    },
    async getFile(path) {
      const bytes = value.files.get(path);

      if (bytes === undefined) {
        throw new Error(`missing ${path}`);
      }

      return bytes;
    },
    async ssh() {
      return value.access;
    },
    async dispose() {
      value.disposals += 1;
    },
  };

  value.provider = {
    async provision(input: SandboxProvisionInput) {
      value.provisions.push(input);

      return runtime;
    },
  };

  return value;
};

test('normalizes omitted and SSH network policies', () => {
  assert.deepEqual(normalizeSandboxNetwork(undefined), {
    mode: 'disabled',
    ssh: false,
  });

  assert.deepEqual(
    normalizeSandboxNetwork({
      mode: 'disabled',
      ssh: true,
      dnsServers: ['1.1.1.1'],
    }),
    {
      mode: 'egress',
      ssh: {
        bindAddress: '127.0.0.1',
        advertisedHost: undefined,
        port: undefined,
      },
      dnsServers: ['1.1.1.1'],
    },
  );
});

test('rejects unsafe or incomplete network policies', () => {
  assert.throws(
    () => normalizeSandboxNetwork({ mode: 'egress' }),
    /requires at least one DNS/u,
  );

  assert.throws(
    () => normalizeSandboxNetwork({ mode: 'egress', dnsServers: ['dns.test'] }),
    /IPv4 literal/u,
  );

  assert.throws(
    () => normalizeSandboxNetwork({ mode: 'egress', dnsServers: ['::1'] }),
    /IPv4 literal/u,
  );

  assert.throws(
    () =>
      normalizeSandboxNetwork({
        mode: 'disabled',
        ssh: { bindAddress: '0.0.0.0' },
        dnsServers: ['1.1.1.1'],
      }),
    /requires advertisedHost/u,
  );

  assert.throws(
    () =>
      normalizeSandboxNetwork({
        mode: 'disabled',
        allowPrivate: [{ cidr: '10.0.0.0/33', protocol: 'tcp', ports: [443] }],
      }),
    /valid CIDR/u,
  );

  assert.throws(
    () =>
      normalizeSandboxNetwork({
        mode: 'disabled',
        allowPrivate: [{ cidr: 'fd00::/8', protocol: 'tcp', ports: [443] }],
      }),
    /valid CIDR/u,
  );
});

test('requires positive integer resource limits before provisioning', async () => {
  const value = fake();

  await assert.rejects(
    createSandbox({
      provider: value.provider,
      image: 'node:22-slim',
      resources: { ...resources, diskMiB: 0 },
    }),
    /diskMiB must be a positive integer/u,
  );

  assert.equal(value.provisions.length, 0);
});

test('passes normalized inputs to the provider and wraps workspace helpers', async () => {
  const value = fake();

  const sandbox = await createSandbox({
    provider: value.provider,
    image: 'node:22-slim',
    imagePullPolicy: 'if-not-present',
    resources,
  });

  assert.equal(sandbox.id, 'runtime-1');

  assert.deepEqual(value.provisions[0], {
    image: 'node:22-slim',
    imagePullPolicy: 'if-not-present',
    name: undefined,
    root: '/workspace',
    resources,
    network: { mode: 'disabled', ssh: false },
    timeoutMs: undefined,
  });

  await sandbox.writeFile('src/hello.txt', 'hello');

  assert.deepEqual(value.execs[0]?.cmd, ['mkdir', '-p', '/workspace/src']);

  assert.equal(await sandbox.readFile('/workspace/src/hello.txt'), 'hello');

  await assert.rejects(sandbox.getFile('/etc/passwd'), /must stay under/u);
});

test('clones and diffs through provider-neutral exec', async () => {
  const value = fake();

  const sandbox = await createSandbox({
    provider: value.provider,
    image: 'node:22-slim',
    resources,
  });

  assert.deepEqual(
    await sandbox.cloneRepo({ url: 'https://example.test/repo.git' }),
    { path: '/workspace/repo', commit: 'abc123' },
  );

  await sandbox.diff();

  assert.deepEqual(value.execs.at(-1), {
    cmd: ['git', 'diff'],
    cwd: '/workspace/repo',
  });
});

test('forwards SSH and guards every operation after idempotent disposal', async () => {
  const value = fake();

  value.access = {
    host: '127.0.0.1',
    port: 2200,
    username: 'root',
    privateKey: 'private',
    knownHosts: 'known',
    hostKeyFingerprint: 'SHA256:test',
  };

  const sandbox = await createSandbox({
    provider: value.provider,
    image: 'node:22-slim',
    resources,
  });

  assert.equal((await sandbox.ssh())?.port, 2200);

  await sandbox.dispose();

  await sandbox.dispose();

  assert.equal(value.disposals, 1);

  assert.throws(() => sandbox.ssh(), /has been disposed/u);

  assert.throws(() => sandbox.exec({ cmd: ['true'] }), /has been disposed/u);
});
