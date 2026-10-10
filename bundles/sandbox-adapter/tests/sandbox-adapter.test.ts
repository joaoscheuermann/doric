import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defineMethod,
  defineService,
  type LogFields,
  LogV1,
  logMethods,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import type { DockerClient } from 'docker-sandbox';
import { SandboxV1 } from 'runtime/contracts';
import type {
  SandboxProvider,
  SandboxProvisionInput,
  SandboxRuntime,
} from 'sandbox';

import { activateSandboxAdapter } from '../src/host/adapter.js';

interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly fields?: LogFields;
}

/** A provider that records each provisioning and lets a test hold disposals. */
const fakeProvider = () => {
  const provisioned: SandboxProvisionInput[] = [];
  const disposed: string[] = [];
  let next = 1;
  let disposal: Promise<void> | undefined;

  const provider: SandboxProvider = {
    provision: async (input) => {
      provisioned.push(input);
      const id = `vm-${String(next++)}`;

      return {
        ...runtime(id),
        dispose: async () => {
          await disposal;
          disposed.push(id);
        },
      };
    },
  };

  return {
    provider,
    provisioned,
    disposed,
    hold(promise: Promise<void>) {
      disposal = promise;
    },
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

/** Activates the adapter's host part over a recording log/v1 provider. */
const start = async (options: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly provider: SandboxProvider;
  readonly removedVolumes?: string[];
}) => {
  const logs: LogEntry[] = [];
  const level = (name: string) =>
    defineMethod({
      ...logMethods.info,
      execute: ([message, fields]) => {
        logs.push({
          level: name,
          message,
          ...(fields === undefined ? {} : { fields }),
        });
      },
    });
  const harness = createTestServices({
    bundle: { id: 'sandbox-adapter' },
    provide: [
      defineService(LogV1, {
        debug: level('debug'),
        info: level('info'),
        warn: level('warn'),
        error: level('error'),
      }),
    ],
  });
  const docker = {
    ...options.provider,
    removeVolume: async (name: string) => {
      options.removedVolumes?.push(name);
    },
  } as unknown as DockerClient;
  const cleanup = activateSandboxAdapter({
    environment: options.environment,
    docker: () => docker,
    firecracker: () => options.provider,
  })({ services: harness.services });

  return {
    sandbox: harness.services.use(SandboxV1),
    logs,
    async stop() {
      await cleanup();
      await harness.dispose();
    },
  };
};

const projectId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';

void test('acquires a named Docker sandbox with the deployment settings', async () => {
  const fake = fakeProvider();
  const adapter = await start({ environment: {}, provider: fake.provider });

  try {
    assert.deepEqual(await adapter.sandbox.describe(), {
      provider: 'docker',
      durableWorkspace: true,
    });

    const lease = await adapter.sandbox.acquire({ identity: projectId });

    assert.equal(lease.sandbox.id, 'vm-1');
    assert.deepEqual(fake.provisioned, [
      {
        image: 'node:22-bookworm',
        imagePullPolicy: 'if-not-present',
        name: undefined,
        workspace: projectId,
        root: '/workspace',
        resources: { cpuCount: 1, memoryMiB: 2048, diskMiB: 4096 },
        network: { mode: 'egress', ssh: false, dnsServers: ['1.1.1.1'] },
        timeoutMs: undefined,
      },
    ]);
    await lease.release();
  } finally {
    await adapter.stop();
  }
});

void test('selects Firecracker, its memory and SSH from the environment', async () => {
  const fake = fakeProvider();
  const removed: string[] = [];
  const adapter = await start({
    environment: {
      DORIC_SANDBOX_PROVIDER: 'firecracker',
      DORIC_SANDBOX_IMAGE: 'doric-sandbox:local',
      DORIC_SANDBOX_SSH: 'true',
    },
    provider: fake.provider,
    removedVolumes: removed,
  });

  try {
    assert.deepEqual(await adapter.sandbox.describe(), {
      provider: 'firecracker',
      durableWorkspace: false,
    });

    const lease = await adapter.sandbox.acquire({ identity: projectId });

    assert.equal(fake.provisioned[0]?.image, 'doric-sandbox:local');
    assert.equal(fake.provisioned[0]?.resources.memoryMiB, 512);
    assert.notEqual(fake.provisioned[0]?.network.ssh, false);
    assert.deepEqual(await adapter.sandbox.machines(), [
      { id: 'vm-1', provider: 'firecracker' },
    ]);

    // Firecracker keeps no durable workspace, so discarding is a no-op.
    await adapter.sandbox.discard(projectId);
    assert.deepEqual(removed, []);
    await lease.release();
  } finally {
    await adapter.stop();
  }
});

void test('only an exact "true" enables SSH, and an unknown provider means Docker', async () => {
  const fake = fakeProvider();
  const adapter = await start({
    environment: { DORIC_SANDBOX_PROVIDER: 'kvm', DORIC_SANDBOX_SSH: 'TRUE' },
    provider: fake.provider,
  });

  try {
    assert.equal((await adapter.sandbox.describe()).provider, 'docker');
    const lease = await adapter.sandbox.acquire({ identity: projectId });

    assert.equal(fake.provisioned[0]?.network.ssh, false);
    await lease.release();
  } finally {
    await adapter.stop();
  }
});

void test('discards a deleted Project workspace volume on Docker', async () => {
  const removed: string[] = [];
  const adapter = await start({
    environment: {},
    provider: fakeProvider().provider,
    removedVolumes: removed,
  });

  try {
    await adapter.sandbox.discard(projectId);

    assert.deepEqual(removed, [`doric-workspace-${projectId}`]);
  } finally {
    await adapter.stop();
  }
});

void test('lists provisioned machines until their disposal completes', async () => {
  const fake = fakeProvider();
  let finish!: () => void;
  fake.hold(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const adapter = await start({ environment: {}, provider: fake.provider });

  try {
    const first = await adapter.sandbox.acquire({ identity: 'project-a' });
    await adapter.sandbox.acquire({ identity: 'project-b' });

    assert.deepEqual(
      [...(await adapter.sandbox.machines())].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
      [
        { id: 'vm-1', provider: 'docker' },
        { id: 'vm-2', provider: 'docker' },
      ],
    );
    assert.deepEqual(await adapter.sandbox.machine('vm-1'), {
      id: 'vm-1',
      provider: 'docker',
    });
    assert.equal(await adapter.sandbox.machine('missing'), undefined);

    const released = first.release();
    // Still listed while its disposal is in flight.
    assert.equal((await adapter.sandbox.machine('vm-1'))?.id, 'vm-1');
    finish();
    await released;

    assert.equal(await adapter.sandbox.machine('vm-1'), undefined);
    assert.deepEqual(await adapter.sandbox.machines(), [
      { id: 'vm-2', provider: 'docker' },
    ]);
  } finally {
    finish();
    await adapter.stop();
  }
});

void test('deactivation disposes the pool and every leased sandbox', async () => {
  const fake = fakeProvider();
  const adapter = await start({ environment: {}, provider: fake.provider });
  await adapter.sandbox.acquire({ identity: 'project-a' });
  await adapter.sandbox.acquire({ identity: 'project-b' });

  await adapter.stop();

  assert.deepEqual([...fake.disposed].sort(), ['vm-1', 'vm-2']);
});

void test('sandpool records reach log/v1 with their component', async () => {
  const fake = fakeProvider();
  const adapter = await start({ environment: {}, provider: fake.provider });

  try {
    const lease = await adapter.sandbox.acquire({ identity: projectId });
    await lease.release();

    const pooled = adapter.logs.filter(
      (entry) => entry.fields?.component === 'sandpool',
    );
    assert.ok(pooled.length > 0);
    assert.ok(pooled.every((entry) => entry.level === 'debug'));
    assert.ok(pooled.every((entry) => entry.message.length > 0));
  } finally {
    await adapter.stop();
  }
});
