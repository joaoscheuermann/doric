import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { SandboxProvisionInput } from 'sandbox';

import { discardWorkspace } from '../src/index.js';
import type { DockerHostConfig } from '../src/lib/host.js';
import { provisionDocker } from '../src/lib/provider.js';
import type {
  ContainerInspect,
  ContainerRef,
  ContainerSummary,
  CreateContainerInput,
  DockerClient,
} from '../src/lib/types/docker.js';

type InspectRaw = Record<string, unknown>;

interface FakeContainer {
  readonly id: string;
  readonly created: number;
  readonly labels: Readonly<Record<string, string>>;
  readonly raw: InspectRaw;
  running: boolean;
}

const MiB = 1024 * 1024;

/**
 * What Docker reports for a sandbox container made for the default request:
 * no network, 512 MiB, one CPU, a 4096 MiB writable layer, and the workspace
 * volume at /workspace. Tests change one field to model a different request.
 */
const sandboxRaw = (
  workspace: string,
  overrides: { readonly image?: string; readonly host?: InspectRaw } = {},
): InspectRaw => ({
  Config: {
    Image: overrides.image ?? 'node:22-slim',
    WorkingDir: '/workspace',
    Labels: {
      'doric.sandbox': 'true',
      'doric.sandbox.root': '/workspace',
      'doric.sandbox.workspace': workspace,
    },
    ExposedPorts: null,
  },
  HostConfig: {
    NetworkMode: 'none',
    Memory: 512 * MiB,
    NanoCpus: 1_000_000_000,
    StorageOpt: { size: '4096M' },
    Binds: [`doric-workspace-${workspace}:/workspace`],
    PortBindings: {},
    Dns: null,
    ...overrides.host,
  },
});

/**
 * A Docker daemon that keeps containers and volumes between hosts, as the real
 * daemon does. Each test provisions through a fresh client as a new host would.
 */
const fakeDaemon = () => {
  const containers = new Map<string, FakeContainer>();
  const volumes = new Set<string>();
  let clock = 0;
  let refusing = false;

  const idOf = (container: ContainerRef | string): string =>
    typeof container === 'string' ? container : container.id;

  const stateOf = (id: string): FakeContainer => {
    const container = containers.get(id);

    if (container === undefined) {
      throw new Error(`No such container: ${id}`);
    }

    return container;
  };

  const insert = (raw: InspectRaw, running: boolean): string => {
    clock += 1;
    const id = `container-${String(clock)}`;
    const config = raw.Config as { readonly Labels: Record<string, string> };

    containers.set(id, {
      id,
      created: clock,
      labels: config.Labels,
      raw,
      running,
    });

    return id;
  };

  const matches = (
    labels: Readonly<Record<string, string>>,
    filters: readonly string[],
  ): boolean =>
    filters.every((filter) => {
      const separator = filter.indexOf('=');

      return labels[filter.slice(0, separator)] === filter.slice(separator + 1);
    });

  const client = {
    inspectImage: async () => ({ id: 'image-1', raw: {} }),
    pullImage: async () => undefined,
    createVolume: async ({ name }: { readonly name: string }) => {
      volumes.add(name);
    },
    removeVolume: async (name: string) => {
      volumes.delete(name);
    },
    createContainer: async (input: CreateContainerInput) => {
      // Docker keeps the settings it was asked for, under the inspect names.
      const id = insert(
        {
          Config: {
            Image: input.image,
            WorkingDir: input.workingDir,
            Labels: input.labels ?? {},
            ExposedPorts: Object.fromEntries(
              (input.exposedPorts ?? []).map((port) => [port, {}]),
            ),
          },
          HostConfig: input.hostConfig ?? {},
        },
        false,
      );

      return { id, warnings: [] };
    },
    startContainer: async (container: ContainerRef | string) => {
      stateOf(idOf(container)).running = true;
    },
    restartContainer: async (container: ContainerRef | string) => {
      stateOf(idOf(container)).running = true;
    },
    listContainers: async ({
      labels,
    }: {
      readonly labels: readonly string[];
    }) =>
      [...containers.values()]
        .filter((container) => matches(container.labels, labels))
        .map(
          (container): ContainerSummary => ({
            id: container.id,
            running: container.running,
            created: container.created,
          }),
        ),
    inspectContainer: async (
      container: ContainerRef | string,
    ): Promise<ContainerInspect> => {
      const state = stateOf(idOf(container));

      return {
        id: state.id,
        ipAddress: '172.17.0.2',
        ports: {},
        raw: state.raw,
      };
    },
    removeContainer: async (container: ContainerRef | string) => {
      if (refusing) {
        throw new Error('Docker daemon is unavailable');
      }

      containers.delete(idOf(container));
    },
  } as unknown as DockerClient;

  return {
    client,
    volumes,
    /** Makes the daemon refuse container removals, or accept them again. */
    refuseRemovals(refuse: boolean): void {
      refusing = refuse;
    },
    /** Adds a container of the workspace, as an earlier host left it. */
    seed(
      workspace: string,
      running: boolean,
      raw: InspectRaw = sandboxRaw(workspace),
    ): string {
      return insert(raw, running);
    },
    idsFor(workspace: string): string[] {
      return [...containers.values()]
        .filter(
          (container) =>
            container.labels['doric.sandbox.workspace'] === workspace,
        )
        .map((container) => container.id);
    },
    exists: (id: string): boolean => containers.has(id),
  };
};

const config: DockerHostConfig = {
  connection: { kind: 'unix' },
  dropbearPath: join(tmpdir(), 'doric-workspace-test-missing-dropbear'),
  statePath: join(tmpdir(), `doric-workspace-test-${randomUUID()}`),
  platform: 'darwin',
};

/** Provisions a workspace for the default request, with `overrides` applied. */
const provision = (
  client: DockerClient,
  workspace: string,
  overrides: Partial<SandboxProvisionInput> = {},
) => {
  const input: SandboxProvisionInput = {
    image: 'node:22-slim',
    imagePullPolicy: 'if-not-present',
    root: '/workspace',
    workspace,
    resources: { cpuCount: 1, memoryMiB: 512, diskMiB: 4096 },
    network: { mode: 'disabled', ssh: false },
    ...overrides,
  };

  return provisionDocker(client, input, config);
};

void test('creates one container for a workspace that has none', async () => {
  const daemon = fakeDaemon();

  const runtime = await provision(daemon.client, 'project-a');

  assert.deepEqual(daemon.idsFor('project-a'), [runtime.id]);
});

void test('reconnects a running container that matches the request and keeps its ID', async () => {
  const daemon = fakeDaemon();
  const left = daemon.seed('project-a', true);

  const runtime = await provision(daemon.client, 'project-a');

  assert.equal(runtime.id, left);
  assert.deepEqual(daemon.idsFor('project-a'), [left]);
});

void test('removes stopped duplicates of a workspace and keeps its running container', async () => {
  const daemon = fakeDaemon();
  daemon.seed('project-a', true);
  const stopped = daemon.seed('project-a', false);

  const runtime = await provision(daemon.client, 'project-a');

  assert.equal(daemon.exists(stopped), false);
  assert.deepEqual(daemon.idsFor('project-a'), [runtime.id]);
});

void test('keeps the workspace volume when it removes a duplicate container', async () => {
  const daemon = fakeDaemon();
  daemon.seed('project-a', true);
  daemon.seed('project-a', false);

  await provision(daemon.client, 'project-a');

  assert.equal(daemon.volumes.has('doric-workspace-project-a'), true);
});

/**
 * A container the request no longer matches is replaced by a fresh one, and the
 * workspace volume stays, so the files are the same afterwards.
 */
const incompatible: readonly {
  readonly name: string;
  readonly seeded: InspectRaw;
  readonly request: Partial<SandboxProvisionInput>;
}[] = [
  {
    name: 'a bridge container for a request with the network disabled',
    seeded: sandboxRaw('project-a', { host: { NetworkMode: 'bridge' } }),
    request: { network: { mode: 'disabled', ssh: false } },
  },
  {
    name: 'a disabled container for a request with egress',
    seeded: sandboxRaw('project-a'),
    request: { network: { mode: 'egress', ssh: false } },
  },
  {
    name: 'an image other than the requested one',
    seeded: sandboxRaw('project-a', { image: 'node:20-slim' }),
    request: {},
  },
  {
    name: 'a memory limit other than the requested one',
    seeded: sandboxRaw('project-a', { host: { Memory: 256 * MiB } }),
    request: {},
  },
  {
    name: 'a CPU limit other than the requested one',
    seeded: sandboxRaw('project-a', { host: { NanoCpus: 2_000_000_000 } }),
    request: {},
  },
  {
    name: 'a writable layer quota other than the requested one',
    seeded: sandboxRaw('project-a', {
      host: { StorageOpt: { size: '2048M' } },
    }),
    request: {},
  },
  {
    name: 'a container without the writable layer quota the request sets',
    seeded: sandboxRaw('project-a', { host: { StorageOpt: undefined } }),
    request: {},
  },
  {
    name: 'a container whose DNS servers differ from the request',
    seeded: sandboxRaw('project-a', { host: { NetworkMode: 'bridge' } }),
    request: {
      network: { mode: 'egress', ssh: false, dnsServers: ['1.1.1.1'] },
    },
  },
];

for (const { name, seeded, request } of incompatible) {
  void test(`replaces ${name} and keeps the workspace volume`, async () => {
    const daemon = fakeDaemon();
    const stale = daemon.seed('project-a', true, seeded);

    const runtime = await provision(daemon.client, 'project-a', request);

    assert.notEqual(runtime.id, stale);
    assert.equal(daemon.exists(stale), false);
    assert.deepEqual(daemon.idsFor('project-a'), [runtime.id]);
    assert.equal(daemon.volumes.has('doric-workspace-project-a'), true);
  });
}

void test('rebuilds a container whose metadata lacks a requested limit', async () => {
  const daemon = fakeDaemon();
  const incomplete = daemon.seed(
    'project-a',
    true,
    sandboxRaw('project-a', { host: { NanoCpus: undefined } }),
  );

  const runtime = await provision(daemon.client, 'project-a');

  assert.notEqual(runtime.id, incomplete);
  assert.deepEqual(daemon.idsFor('project-a'), [runtime.id]);
});

void test('fails the acquisition when an incompatible container cannot be removed', async () => {
  const daemon = fakeDaemon();
  const stale = daemon.seed(
    'project-a',
    true,
    sandboxRaw('project-a', { image: 'node:20-slim' }),
  );

  daemon.refuseRemovals(true);

  await assert.rejects(provision(daemon.client, 'project-a'));

  assert.deepEqual(daemon.idsFor('project-a'), [stale]);
  assert.equal(daemon.volumes.has('doric-workspace-project-a'), true);

  daemon.refuseRemovals(false);

  const runtime = await provision(daemon.client, 'project-a');

  assert.deepEqual(daemon.idsFor('project-a'), [runtime.id]);
});

void test('leaves the containers of other workspaces alone', async () => {
  const daemon = fakeDaemon();
  const other = daemon.seed('project-b', true);

  await provision(daemon.client, 'project-a');

  assert.equal(daemon.exists(other), true);
});

void test('serves concurrent provisions of one workspace from one container', async () => {
  const daemon = fakeDaemon();

  const [first, second] = await Promise.all([
    provision(daemon.client, 'project-a'),
    provision(daemon.client, 'project-a'),
  ]);

  assert.equal(first.id, second.id);
  assert.deepEqual(daemon.idsFor('project-a'), [first.id]);
});

void test('keeps the container until the last lease of its workspace is disposed', async () => {
  const daemon = fakeDaemon();
  const first = await provision(daemon.client, 'project-a');
  const second = await provision(daemon.client, 'project-a');

  await first.dispose();

  assert.equal(daemon.exists(second.id), true);

  await second.dispose();

  assert.equal(daemon.exists(second.id), false);
});

void test('rejects an acquisition whose duplicate cannot be removed, then serves it once the daemon recovers', async () => {
  const daemon = fakeDaemon();
  const kept = daemon.seed('project-a', true);
  const duplicate = daemon.seed('project-a', false);

  daemon.refuseRemovals(true);

  await assert.rejects(provision(daemon.client, 'project-a'));

  assert.deepEqual(daemon.idsFor('project-a'), [kept, duplicate]);
  assert.equal(daemon.volumes.has('doric-workspace-project-a'), true);

  daemon.refuseRemovals(false);

  const runtime = await provision(daemon.client, 'project-a');

  assert.equal(runtime.id, kept);
  assert.deepEqual(daemon.idsFor('project-a'), [kept]);
});

void test('releases a shared lease once when it is disposed twice concurrently', async () => {
  const daemon = fakeDaemon();
  const first = await provision(daemon.client, 'project-a');
  const second = await provision(daemon.client, 'project-a');

  await Promise.all([first.dispose(), first.dispose()]);

  assert.equal(daemon.exists(second.id), true);

  await second.dispose();

  assert.equal(daemon.exists(second.id), false);
});

void test('retries the release of a lease whose removal failed', async () => {
  const daemon = fakeDaemon();
  const runtime = await provision(daemon.client, 'project-a');

  daemon.refuseRemovals(true);

  await assert.rejects(runtime.dispose());

  daemon.refuseRemovals(false);

  await runtime.dispose();

  assert.equal(daemon.exists(runtime.id), false);
});

void test('discards the containers and the volume of a workspace', async () => {
  const daemon = fakeDaemon();
  await provision(daemon.client, 'project-a');
  daemon.seed('project-a', false);

  await discardWorkspace(daemon.client, 'project-a');

  assert.deepEqual(daemon.idsFor('project-a'), []);
  assert.equal(daemon.volumes.has('doric-workspace-project-a'), false);
});
