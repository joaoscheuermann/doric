import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { SandboxProvisionInput } from 'sandbox';

import { createDockerClient, discardWorkspace } from '../src/index.js';

const enabled = process.env.DORIC_TEST_SANDBOX === 'true';

/**
 * Each case names its own workspace, so it touches only the containers and the
 * volume it creates, and removes them with `discardWorkspace`.
 */
const workspaceOf = (): string => `bwp14-${randomUUID()}`;

const provisionInput = (
  workspace: string,
  overrides: Partial<SandboxProvisionInput> = {},
): SandboxProvisionInput => ({
  image: 'node:22-slim',
  imagePullPolicy: 'if-not-present',
  root: '/workspace',
  workspace,
  resources: { cpuCount: 1, memoryMiB: 256, diskMiB: 4096 },
  network: { mode: 'disabled', ssh: false },
  ...overrides,
});

const containerIds = async (
  client: ReturnType<typeof createDockerClient>,
  workspace: string,
): Promise<string[]> =>
  (
    await client.listContainers({
      labels: [`doric.sandbox.workspace=${workspace}`],
    })
  ).map(({ id }) => id);

void test('reattaches the workspace container and its files after the host restarts on Docker', {
  skip: enabled ? false : 'Requires DORIC_TEST_SANDBOX=true',
}, async () => {
  const workspace = workspaceOf();
  const hostBeforeRestart = createDockerClient();
  const hostAfterRestart = createDockerClient();
  // The first lease is never disposed, as when the host process dies.
  const first = await hostBeforeRestart.provision(provisionInput(workspace));

  try {
    await first.putFile('/workspace/kept.txt', Buffer.from('kept'));

    const second = await hostAfterRestart.provision(provisionInput(workspace));

    assert.equal(second.id, first.id);
    assert.deepEqual(await containerIds(hostAfterRestart, workspace), [
      first.id,
    ]);
    assert.equal(
      Buffer.from(await second.getFile('/workspace/kept.txt')).toString(),
      'kept',
    );

    await second.dispose();
  } finally {
    await discardWorkspace(hostAfterRestart, workspace);
  }
});

void test('keeps the running container when a stopped duplicate of the workspace is present on Docker', {
  skip: enabled ? false : 'Requires DORIC_TEST_SANDBOX=true',
}, async () => {
  const workspace = workspaceOf();
  const client = createDockerClient();
  const running = await client.provision(provisionInput(workspace));

  try {
    await client.createContainer({
      image: 'node:22-slim',
      cmd: ['true'],
      labels: { 'doric.sandbox.workspace': workspace },
    });

    const reattached = await createDockerClient().provision(
      provisionInput(workspace),
    );

    assert.equal(reattached.id, running.id);
    assert.deepEqual(await containerIds(client, workspace), [running.id]);

    await reattached.dispose();
  } finally {
    await discardWorkspace(client, workspace);
  }
});

/**
 * A request the container no longer matches replaces it. The workspace file
 * written before the change is still there afterwards, in a fresh container.
 */
const replacesOnChange = async (
  changed: Partial<SandboxProvisionInput>,
): Promise<void> => {
  const workspace = workspaceOf();
  const hostBefore = createDockerClient();
  const hostAfter = createDockerClient();
  const first = await hostBefore.provision(provisionInput(workspace));

  try {
    await first.putFile('/workspace/kept.txt', Buffer.from('kept'));

    const second = await hostAfter.provision(
      provisionInput(workspace, changed),
    );

    assert.notEqual(second.id, first.id);
    assert.deepEqual(await containerIds(hostAfter, workspace), [second.id]);
    assert.equal(
      Buffer.from(await second.getFile('/workspace/kept.txt')).toString(),
      'kept',
    );

    await second.dispose();
  } finally {
    await discardWorkspace(hostAfter, workspace);
  }
};

void test('replaces a container whose network mode changed on Docker', {
  skip: enabled ? false : 'Requires DORIC_TEST_SANDBOX=true',
}, async () => {
  await replacesOnChange({ network: { mode: 'egress', ssh: false } });
});

void test('replaces a container whose image changed on Docker', {
  skip: enabled ? false : 'Requires DORIC_TEST_SANDBOX=true',
}, async () => {
  await replacesOnChange({ image: 'node:22-bookworm-slim' });
});

void test('serves concurrent provisions of one workspace from one container on Docker', {
  skip: enabled ? false : 'Requires DORIC_TEST_SANDBOX=true',
}, async () => {
  const workspace = workspaceOf();
  const client = createDockerClient();

  try {
    const [first, second] = await Promise.all([
      client.provision(provisionInput(workspace)),
      client.provision(provisionInput(workspace)),
    ]);

    assert.equal(second.id, first.id);
    assert.deepEqual(await containerIds(client, workspace), [first.id]);

    await first.dispose();
    await second.dispose();
  } finally {
    await discardWorkspace(client, workspace);
  }
});
