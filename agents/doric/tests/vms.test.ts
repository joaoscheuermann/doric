import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';
import type {
  SandboxProvisionInput,
  SandboxProvider,
  SandboxRuntime,
} from 'sandbox';

import { createVmRegistry } from '../src/lib/vms.js';
import { createVmsRouter } from '../src/routes/vms.js';

const input: SandboxProvisionInput = {
  image: 'node:22-slim',
  root: '/workspace',
  resources: { cpuCount: 1, memoryMiB: 512, diskMiB: 4096 },
  network: { mode: 'disabled', ssh: false },
};

test('tracks provisioned VMs until disposal completes', async () => {
  let release!: () => void;
  const disposing = new Promise<void>((resolve) => {
    release = resolve;
  });
  let nextId = 1;
  const provider: SandboxProvider = {
    provision: async () => ({
      ...runtime(`vm-${String(nextId++)}`),
      dispose: () => disposing,
    }),
  };
  const registry = createVmRegistry('firecracker', provider);

  const first = await registry.provider.provision(input);
  const second = await registry.provider.provision(input);

  assert.deepEqual(
    [...registry.list()].sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: 'vm-1', provider: 'firecracker' },
      { id: 'vm-2', provider: 'firecracker' },
    ],
  );
  assert.deepEqual(registry.find('vm-1'), {
    id: 'vm-1',
    provider: 'firecracker',
  });

  const disposed = first.dispose();
  assert.deepEqual(
    new Set(registry.list().map(({ id }) => id)),
    new Set(['vm-1', 'vm-2']),
  );
  assert.equal(registry.find('vm-1')?.id, 'vm-1');
  release();
  await disposed;

  assert.deepEqual(registry.list(), [{ id: 'vm-2', provider: 'firecracker' }]);
  assert.equal(registry.find('vm-1'), undefined);
  await second.dispose();
});

test('keeps a VM registered when disposal fails', async () => {
  let reject!: (cause: Error) => void;
  const disposal = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const provider: SandboxProvider = {
    provision: async () => ({
      ...runtime('vm-1'),
      dispose: () => disposal,
    }),
  };
  const registry = createVmRegistry('docker', provider);
  const tracked = await registry.provider.provision(input);

  const disposed = tracked.dispose();
  assert.equal(registry.find('vm-1')?.id, 'vm-1');
  assert.deepEqual(
    registry.list().map(({ id }) => id),
    ['vm-1'],
  );
  const failed = assert.rejects(disposed);
  reject(new Error('disposal failed'));
  await failed;
  assert.deepEqual(registry.list(), [{ id: 'vm-1', provider: 'docker' }]);
  assert.equal(registry.find('vm-1')?.id, 'vm-1');
});

test('returns every running VM', async () => {
  const host = await serveVms();

  try {
    const response = await fetch(`${host.url}/vms`);
    assert.equal(response.status, 200);
    const inventory = (await response.json()) as typeof vms;
    assert.deepEqual(
      inventory.sort((a, b) => a.id.localeCompare(b.id)),
      [...vms].sort((a, b) => a.id.localeCompare(b.id)),
    );
  } finally {
    await host.close();
  }
});

test('returns leased VM SSH access without permitting caches', async () => {
  const host = await serveVms();

  try {
    const response = await fetch(`${host.url}/vms/vm-1/ssh`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      vm: vms[0],
      projectId,
      ssh: access,
    });
  } finally {
    await host.close();
  }
});

test('rejects SSH access for an idle VM', async () => {
  const host = await serveVms();

  try {
    const response = await fetch(`${host.url}/vms/vm-2/ssh`);
    assert.equal(response.status, 409);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      'vm_ssh_unavailable',
    );
  } finally {
    await host.close();
  }
});

test('reports missing VMs through the stable error code', async () => {
  const host = await serveVms();

  try {
    const response = await fetch(`${host.url}/vms/missing/ssh`);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      'vm_not_found',
    );
  } finally {
    await host.close();
  }
});

const serveVms = async () => {
  const app = express();
  app.use(
    '/vms',
    createVmsRouter({
      list: () => vms,
      find: (id) => vms.find((vm) => vm.id === id),
      ssh: async (id) =>
        id === 'vm-1' ? { projectId, ssh: access } : undefined,
    }),
  );
  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((cause) =>
          cause === undefined ? resolve() : reject(cause),
        ),
      ),
  };
};

const runtime = (id: string): SandboxRuntime => ({
  id,
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
});

const projectId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
const vms = [
  { id: 'vm-1', provider: 'firecracker' as const },
  { id: 'vm-2', provider: 'firecracker' as const },
];
const access = {
  host: '127.0.0.1',
  port: 2200,
  username: 'root' as const,
  privateKey: 'private-key',
  knownHosts: '[127.0.0.1]:2200 ssh-ed25519 host-key',
  hostKeyFingerprint: 'SHA256:test',
};
