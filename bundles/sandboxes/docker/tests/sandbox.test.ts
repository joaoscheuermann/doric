import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defineMethod,
  defineService,
  type LogFields,
  LogV1,
  logMethods,
} from 'bundle/contracts';
import { createMinimalHooks, createTestServices } from 'bundle/testing';
import type { CreateDockerClientOptions, DockerClient } from 'docker-sandbox';
import { SandboxV1 } from 'runtime/contracts';
import type {
  SandboxProvider,
  SandboxProvisionInput,
  SandboxRuntime,
} from 'sandbox';

import {
  activateDockerSandbox,
  dockerSandboxSettings,
} from '../src/host/sandbox.js';

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

/** Activates the bundle's host part over a recording log/v1 provider. */
const start = async (options: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly provider: SandboxProvider;
  readonly removedVolumes?: string[];
  /** Observes the client options the deployment's settings produce. */
  readonly client?: (options: CreateDockerClientOptions) => void;
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
    bundle: { id: 'docker' },
    provide: [
      createMinimalHooks(),
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
    listContainers: async () => [],
    removeVolume: async (name: string) => {
      options.removedVolumes?.push(name);
    },
  } as unknown as DockerClient;
  const cleanup = activateDockerSandbox({
    environment: options.environment,
    client: (clientOptions) => {
      options.client?.(clientOptions);

      return docker;
    },
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
  const bundle = await start({ environment: {}, provider: fake.provider });

  try {
    assert.deepEqual(await bundle.sandbox.describe(), {
      provider: 'docker',
      durableWorkspace: true,
    });

    const lease = await bundle.sandbox.acquire({ identity: projectId });

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
    await bundle.stop();
  }
});

void test('reads the image and SSH from the environment', async () => {
  const fake = fakeProvider();
  const bundle = await start({
    environment: {
      DORIC_SANDBOX_PROVIDER: 'firecracker',
      DORIC_SANDBOX_IMAGE: 'doric-sandbox:local',
      DORIC_SANDBOX_SSH: 'true',
    },
    provider: fake.provider,
  });

  try {
    // The bundle is the provider; DORIC_SANDBOX_PROVIDER only selects which
    // bundle the default composition enables.
    assert.equal((await bundle.sandbox.describe()).provider, 'docker');
    const lease = await bundle.sandbox.acquire({ identity: projectId });

    assert.equal(fake.provisioned[0]?.image, 'doric-sandbox:local');
    assert.equal(fake.provisioned[0]?.resources.memoryMiB, 2048);
    assert.notEqual(fake.provisioned[0]?.network.ssh, false);
    await lease.release();
  } finally {
    await bundle.stop();
  }
});

void test('only an exact "true" enables SSH', async () => {
  const fake = fakeProvider();
  const bundle = await start({
    environment: { DORIC_SANDBOX_SSH: 'TRUE' },
    provider: fake.provider,
  });

  try {
    const lease = await bundle.sandbox.acquire({ identity: projectId });

    assert.equal(fake.provisioned[0]?.network.ssh, false);
    await lease.release();
  } finally {
    await bundle.stop();
  }
});

void test('only an exact "true" shares the Docker socket', () => {
  assert.equal(dockerSandboxSettings({}).dockerSocket, false);

  assert.equal(
    dockerSandboxSettings({ DORIC_SANDBOX_DOCKER_SOCKET: 'TRUE' }).dockerSocket,
    false,
  );

  assert.equal(
    dockerSandboxSettings({ DORIC_SANDBOX_DOCKER_SOCKET: 'true' }).dockerSocket,
    true,
  );
});

void test('hands the deployment socket sharing to the Docker client', async () => {
  const seen: CreateDockerClientOptions[] = [];
  const fake = fakeProvider();
  const bundle = await start({
    environment: { DORIC_SANDBOX_DOCKER_SOCKET: 'true' },
    provider: fake.provider,
    client: (options) => seen.push(options),
  });

  try {
    await bundle.sandbox.describe();

    assert.deepEqual(seen, [{ exposeDockerSocket: true }]);
  } finally {
    await bundle.stop();
  }
});

void test('discards a deleted Project workspace volume on Docker', async () => {
  const removed: string[] = [];
  const bundle = await start({
    environment: {},
    provider: fakeProvider().provider,
    removedVolumes: removed,
  });

  try {
    await bundle.sandbox.discard(projectId);

    assert.deepEqual(removed, [`doric-workspace-${projectId}`]);
  } finally {
    await bundle.stop();
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
  const bundle = await start({ environment: {}, provider: fake.provider });

  try {
    const first = await bundle.sandbox.acquire({ identity: 'project-a' });
    await bundle.sandbox.acquire({ identity: 'project-b' });

    assert.deepEqual(
      [...(await bundle.sandbox.machines())].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
      [
        { id: 'vm-1', provider: 'docker' },
        { id: 'vm-2', provider: 'docker' },
      ],
    );
    assert.deepEqual(await bundle.sandbox.machine('vm-1'), {
      id: 'vm-1',
      provider: 'docker',
    });
    assert.equal(await bundle.sandbox.machine('missing'), undefined);

    const released = first.release();
    // Still listed while its disposal is in flight.
    assert.equal((await bundle.sandbox.machine('vm-1'))?.id, 'vm-1');
    finish();
    await released;

    assert.equal(await bundle.sandbox.machine('vm-1'), undefined);
    assert.deepEqual(await bundle.sandbox.machines(), [
      { id: 'vm-2', provider: 'docker' },
    ]);
  } finally {
    finish();
    await bundle.stop();
  }
});

void test('deactivation disposes the pool and every leased sandbox', async () => {
  const fake = fakeProvider();
  const bundle = await start({ environment: {}, provider: fake.provider });
  await bundle.sandbox.acquire({ identity: 'project-a' });
  await bundle.sandbox.acquire({ identity: 'project-b' });

  await bundle.stop();

  assert.deepEqual([...fake.disposed].sort(), ['vm-1', 'vm-2']);
});

void test('sandpool records reach log/v1 with their component', async () => {
  const fake = fakeProvider();
  const bundle = await start({ environment: {}, provider: fake.provider });

  try {
    const lease = await bundle.sandbox.acquire({ identity: projectId });
    await lease.release();

    const pooled = bundle.logs.filter(
      (entry) => entry.fields?.component === 'sandpool',
    );
    assert.ok(pooled.length > 0);
    assert.ok(pooled.every((entry) => entry.level === 'debug'));
    assert.ok(pooled.every((entry) => entry.message.length > 0));
  } finally {
    await bundle.stop();
  }
});
