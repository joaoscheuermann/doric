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
import { SandboxV1 } from 'runtime/contracts';
import type {
  SandboxProvider,
  SandboxProvisionInput,
  SandboxRuntime,
} from 'sandbox';

import { activateFirecrackerSandbox } from '../src/host/sandbox.js';

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
    bundle: { id: 'firecracker' },
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
  const cleanup = activateFirecrackerSandbox({
    environment: options.environment,
    client: () => options.provider,
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

void test('acquires a named Firecracker sandbox with the deployment settings', async () => {
  const fake = fakeProvider();
  const bundle = await start({ environment: {}, provider: fake.provider });

  try {
    assert.deepEqual(await bundle.sandbox.describe(), {
      provider: 'firecracker',
      durableWorkspace: false,
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
        resources: { cpuCount: 1, memoryMiB: 512, diskMiB: 4096 },
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
      DORIC_SANDBOX_IMAGE: 'doric-sandbox:local',
      DORIC_SANDBOX_SSH: 'true',
    },
    provider: fake.provider,
  });

  try {
    const lease = await bundle.sandbox.acquire({ identity: projectId });

    assert.equal(fake.provisioned[0]?.image, 'doric-sandbox:local');
    assert.notEqual(fake.provisioned[0]?.network.ssh, false);
    assert.deepEqual(await bundle.sandbox.machines(), [
      { id: 'vm-1', provider: 'firecracker' },
    ]);
    await lease.release();
    assert.deepEqual(await bundle.sandbox.machines(), []);
  } finally {
    await bundle.stop();
  }
});

void test('discarding a Project does nothing, since no workspace is durable', async () => {
  const fake = fakeProvider();
  const bundle = await start({ environment: {}, provider: fake.provider });

  try {
    const lease = await bundle.sandbox.acquire({ identity: projectId });

    await bundle.sandbox.discard(projectId);

    assert.equal(
      await bundle.sandbox.machine('vm-1').then((m) => m?.id),
      'vm-1',
    );
    assert.deepEqual(fake.disposed, []);
    await lease.release();
  } finally {
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
