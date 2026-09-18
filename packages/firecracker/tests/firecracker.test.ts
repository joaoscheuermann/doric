import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { SandboxProvisionInput, SandboxRuntime } from 'sandbox';

import {
  createFirecrackerApi,
  createFirecrackerClient,
  DEFAULT_FIRECRACKER_PATHS,
  type FirecrackerConfig,
  type FirecrackerRequest,
  prepareImage,
} from '../src/index.js';
import { renderFirecrackerNetworkRules } from '../src/lib/network.js';

test('configures the Firecracker API in boot-safe order', async () => {
  const requests: FirecrackerRequest[] = [];

  const api = createFirecrackerApi(
    '/run/firecracker.socket',
    async (_socket, request) => {
      requests.push(request);

      return { status: 204, body: new Uint8Array() };
    },
  );

  await api.configure({
    cpuCount: 2,
    memoryMiB: 1024,
    kernel: '/kernel',
    initramfs: '/initramfs',
    baseDisk: '/base.ext4',
    writableDisk: '/writable.ext4',
    tap: 'doric0',
    guestMac: '06:00:00:00:00:01',
  });

  await api.start();

  assert.deepEqual(
    requests.map(({ path }) => path),
    [
      '/boot-source',
      '/machine-config',
      '/drives/base',
      '/drives/writable',
      '/entropy',
      '/network-interfaces/eth0',
      '/actions',
    ],
  );

  assert.deepEqual(requests.at(-1)?.body, { action_type: 'InstanceStart' });
});

test('rejects non-success API responses without including response bodies', async () => {
  const api = createFirecrackerApi('/run/firecracker.socket', async () => ({
    status: 400,
    body: Buffer.from('secret diagnostic'),
  }));

  await assert.rejects(
    api.start(),
    (cause: unknown) =>
      cause instanceof Error &&
      cause.message.includes('status 400') &&
      !cause.message.includes('secret'),
  );
});

test('uses container defaults and preflights before delegated provisioning', async () => {
  let checked = false;
  let provisioned: SandboxProvisionInput | undefined;

  const runtime: SandboxRuntime = {
    id: 'vm-1',
    exec: async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      stdoutBytes: new Uint8Array(),
      stderrBytes: new Uint8Array(),
    }),
    putFile: async () => undefined,
    getFile: async () => new Uint8Array(),
    ssh: async () => undefined,
    dispose: async () => undefined,
  };

  const client = createFirecrackerClient({
    preflight: async (config) => {
      checked = true;

      assert.deepEqual(config.paths, DEFAULT_FIRECRACKER_PATHS);

      assert.equal(config.networkPool, '10.231.0.0/16');

      assert.equal(config.cacheLimitBytes, 20 * 1024 ** 3);
    },
    provision: async (input) => {
      provisioned = input;

      return runtime;
    },
  });

  const input: SandboxProvisionInput = {
    image: 'node:22-slim',
    root: '/workspace',
    resources: { cpuCount: 1, memoryMiB: 512, diskMiB: 4096 },
    network: { mode: 'disabled', ssh: false },
  };

  assert.equal((await client.provision(input)).id, 'vm-1');

  assert.equal(checked, true);

  assert.equal(provisioned, input);
});

test('renders host-input and protected-destination VM rules', () => {
  const rules = renderFirecrackerNetworkRules('doric_test', 'doric0', {
    mode: 'egress',
    ssh: false,
    dnsServers: ['1.1.1.1'],
    allowPrivate: [{ cidr: '10.0.0.8/32', protocol: 'tcp', ports: [443] }],
  });

  assert.match(rules, /chain input/u);

  assert.match(rules, /iifname "doric0" drop/u);

  assert.ok(
    rules.indexOf('ip daddr 10.0.0.0/8 drop') <
      rules.indexOf('ip daddr 1.1.1.1 udp dport 53 accept'),
  );

  assert.ok(
    rules.indexOf('ip daddr 10.0.0.8/32 tcp dport { 443 } accept') <
      rules.indexOf('ip daddr 10.0.0.0/8 drop'),
  );
});

test('reuses an if-not-present OCI cache entry without image tooling', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doric-image-cache-'));
  const cache = join(directory, 'cache');
  const state = join(directory, 'state');
  const image = 'node:22-slim';
  const key = 'a'.repeat(64);
  const reference = createHash('sha256').update(image).digest('hex');

  const config: FirecrackerConfig = {
    paths: { ...DEFAULT_FIRECRACKER_PATHS, cache, state },
    networkPool: '10.231.0.0/16',
    cacheLimitBytes: 1024,
    readinessTimeoutMs: 1000,
    jailerUid: 0,
    jailerGid: 0,
    transport: async () => ({ status: 204, body: new Uint8Array() }),
  };

  try {
    await Promise.all([
      mkdir(join(cache, 'images'), { recursive: true }),
      mkdir(join(cache, 'refs'), { recursive: true }),
    ]);

    await Promise.all([
      writeFile(join(cache, 'images', `${key}.ext4`), Buffer.alloc(128)),
      writeFile(
        join(cache, 'images', `${key}.json`),
        JSON.stringify({
          digest: `sha256:${'b'.repeat(64)}`,
          env: ['PATH=/usr/bin'],
          user: 'node',
        }),
      ),
      writeFile(
        join(cache, 'refs', `${reference}.json`),
        JSON.stringify({ key }),
      ),
    ]);

    const prepared = await prepareImage(
      image,
      'sandbox-1',
      config,
      undefined,
      'if-not-present',
    );

    assert.equal(prepared.user, 'node');

    assert.deepEqual(prepared.env, ['PATH=/usr/bin']);

    assert.equal(
      (await stat(join(cache, 'uses', key, 'sandbox-1'))).isFile(),
      true,
    );

    await prepared.release();

    await assert.rejects(stat(join(cache, 'uses', key, 'sandbox-1')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects non-registry OCI transport references before acquisition', async () => {
  const config: FirecrackerConfig = {
    paths: DEFAULT_FIRECRACKER_PATHS,
    networkPool: '10.231.0.0/16',
    cacheLimitBytes: 1024,
    readinessTimeoutMs: 1000,
    jailerUid: 0,
    jailerGid: 0,
    transport: async () => ({ status: 204, body: new Uint8Array() }),
  };

  await assert.rejects(
    prepareImage('https://registry.example/image', 'sandbox-1', config),
    /public OCI registry reference/u,
  );
});
