import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  SandboxProvider,
  SandboxProvisionInput,
  SandboxRuntime,
} from 'sandbox';

import { createMachineRegistry } from '../src/host/registry.js';

const input: SandboxProvisionInput = {
  image: 'node:22-slim',
  root: '/workspace',
  resources: { cpuCount: 1, memoryMiB: 512, diskMiB: 4096 },
  network: { mode: 'disabled', ssh: false },
};

void test('preserves live terminal control through the VM registry', async () => {
  const received: string[] = [];
  const provider: SandboxProvider = {
    provision: async () => ({
      ...runtime('vm-terminal'),
      start: async (command) => {
        command.onOutput?.({ stream: 'stdout', data: 'ready' });
        return {
          result: Promise.resolve({
            exitCode: 0,
            stdout: 'ready',
            stderr: '',
            stdoutBytes: Buffer.from('ready'),
            stderrBytes: new Uint8Array(),
          }),
          write: async (data) => {
            received.push(data);
          },
          resize: async () => undefined,
          terminate: async () => {
            received.push('terminated');
          },
        };
      },
    }),
  };
  const registry = createMachineRegistry('docker', provider);
  const tracked = await registry.provider.provision(input);
  if (tracked.start === undefined)
    assert.fail('Live process capability was lost');
  const output: string[] = [];
  const process = await tracked.start({
    cmd: ['bash'],
    onOutput: ({ data }) => output.push(data),
  });
  await process.write('hello\r');
  await process.terminate();
  assert.deepEqual(output, ['ready']);
  assert.deepEqual(received, ['hello\r', 'terminated']);
  assert.equal((await process.result).stdout, 'ready');
});

void test('keeps live execution absent for a provider without that capability', async () => {
  const registry = createMachineRegistry('docker', {
    provision: async () => runtime('legacy'),
  });
  assert.equal(
    typeof (await registry.provider.provision(input)).start,
    'undefined',
  );
});

void test('keeps a VM registered when disposal fails', async () => {
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
  const registry = createMachineRegistry('docker', provider);
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
