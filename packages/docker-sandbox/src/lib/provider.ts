import type { SandboxProvisionInput, SandboxRuntime } from 'sandbox';

import { DockerHttpError } from './classes/errors.js';
import {
  configureDockerHost,
  type DockerHostConfig,
  type DockerHostResources,
  preflightDockerHost,
  removeDockerHostState,
} from './host.js';
import { reusable } from './reuse.js';
import type {
  ContainerInspect,
  ContainerRef,
  ContainerSummary,
  CreateContainerInput,
  DockerClient,
} from './types/docker.js';
import { extractFirstFile, packFile } from './utils/tar.js';
import { ensureWorkspaceVolume, workspaceContainers } from './workspace.js';

interface Workspace {
  readonly identity: string;
  readonly volume: string;
}

/** A container with the host side configured for it. */
interface Served {
  readonly container: ContainerRef;
  readonly host: DockerHostResources;
}

/** The container of a durable workspace, shared by the leases that serve it. */
interface Attachment extends Served {
  leases: number;
}

/** What one Docker client serves: a process holds one client. */
interface Registry {
  readonly attachments: Map<string, Attachment>;
  readonly queues: Map<string, Promise<void>>;
}

const registries = new WeakMap<DockerClient, Registry>();

/** Provisions a Docker-backed implementation of the common sandbox runtime. */
export const provisionDocker = async (
  client: DockerClient,
  input: SandboxProvisionInput,
  config: DockerHostConfig,
): Promise<SandboxRuntime> => {
  validateName(input.name);

  await preflightDockerHost(input.network, config);

  await ensureImage(client, input);

  if (input.workspace === undefined) {
    const container = await createSandboxContainer(client, input, undefined);
    const host = await bringUp(client, input, config, container, false);

    return runtimeFor(client, input, { container, host }, () =>
      teardown(client, container, host),
    );
  }

  const identity = input.workspace;

  return serialized(client, identity, () =>
    attach(client, input, config, identity),
  );
};

/**
 * Serves one durable workspace with the container this process already serves
 * for it, else the container an earlier host left running, else a new one.
 * A durable workspace outlives its container, so its volume is kept either way.
 */
const attach = async (
  client: DockerClient,
  input: SandboxProvisionInput,
  config: DockerHostConfig,
  identity: string,
): Promise<SandboxRuntime> => {
  const { attachments } = registryOf(client);
  const shared = attachments.get(identity);

  if (shared !== undefined) {
    shared.leases += 1;

    return runtimeFor(client, input, shared, () =>
      detach(client, identity, shared),
    );
  }

  const volume = await ensureWorkspaceVolume(client, identity, {
    timeoutMs: input.timeoutMs,
  });

  const workspace: Workspace = { identity, volume };
  const kept = await keepOneContainer(
    client,
    config,
    containerInput(input, workspace, true),
    identity,
    input.timeoutMs,
  );
  const container: ContainerRef =
    kept === undefined
      ? await createSandboxContainer(client, input, workspace)
      : { id: kept.id, warnings: [] };
  const host = await bringUp(
    client,
    input,
    config,
    container,
    kept !== undefined,
  );
  const attachment: Attachment = { container, host, leases: 1 };

  attachments.set(identity, attachment);

  return runtimeFor(client, input, attachment, () =>
    detach(client, identity, attachment),
  );
};

/**
 * Ends one lease. The container stays while another lease of its workspace
 * still serves it, and is torn down with the last one.
 */
const detach = (
  client: DockerClient,
  identity: string,
  attachment: Attachment,
): Promise<void> =>
  serialized(client, identity, async () => {
    if (attachment.leases > 1) {
      attachment.leases -= 1;

      return;
    }

    const { attachments } = registryOf(client);

    if (attachments.get(identity) === attachment) {
      attachments.delete(identity);
    }

    await teardown(client, attachment.container, attachment.host);
  });

/**
 * Keeps the first container of a workspace that can serve the request, and
 * removes the others: duplicates an earlier host left, and containers made with
 * settings the request no longer names. Returns the kept container, or
 * undefined when none can serve it. A refused removal fails the call.
 */
const keepOneContainer = async (
  client: DockerClient,
  config: DockerHostConfig,
  spec: CreateContainerInput,
  identity: string,
  timeoutMs: number | undefined,
): Promise<ContainerSummary | undefined> => {
  const found = [
    ...(await workspaceContainers(client, identity, { timeoutMs })),
  ].sort(keepFirst);
  const inspected = await Promise.all(
    found.map((container) => inspectIfPresent(client, container.id, timeoutMs)),
  );
  const index = inspected.findIndex(
    (inspect) => inspect !== undefined && reusable(spec, inspect),
  );

  const removals = await Promise.allSettled(
    found
      .filter((_, position) => position !== index)
      .map((container) => removeStale(client, config, container)),
  );
  const failures = removals.flatMap((removal) =>
    removal.status === 'rejected' ? [removal.reason] : [],
  );

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Docker duplicate removal failed');
  }

  return index < 0 ? undefined : found[index];
};

/** The container's inspect result, or undefined once the daemon no longer has it. */
const inspectIfPresent = (
  client: DockerClient,
  id: string,
  timeoutMs: number | undefined,
): Promise<ContainerInspect | undefined> =>
  client.inspectContainer(id, { timeoutMs }).catch((cause: unknown) => {
    if (cause instanceof DockerHttpError && cause.status === 404) {
      return undefined;
    }

    throw cause;
  });

/** Orders the running containers first, then the newest. */
const keepFirst = (left: ContainerSummary, right: ContainerSummary): number =>
  Number(right.running) - Number(left.running) || right.created - left.created;

/**
 * Removes a duplicate container of a workspace, then the host state it left.
 * A refused removal fails the acquisition: the duplicate still runs, so the
 * workspace must not be served as if it had one container. The workspace volume
 * is named and outlives its containers. The host state is best effort.
 */
const removeStale = async (
  client: DockerClient,
  config: DockerHostConfig,
  container: ContainerSummary,
): Promise<void> => {
  await client.removeContainer(container.id, { force: true, volumes: false });

  await removeDockerHostState(config, container.id).catch(() => undefined);
};

/**
 * Starts a container and configures its host side. A reattached container with
 * SSH is restarted, so an SSH daemon left by an earlier host, with keys it no
 * longer matches, does not keep running. A failure removes the container.
 */
const bringUp = async (
  client: DockerClient,
  input: SandboxProvisionInput,
  config: DockerHostConfig,
  container: ContainerRef,
  reattached: boolean,
): Promise<DockerHostResources> => {
  try {
    if (reattached && input.network.ssh !== false) {
      await client.restartContainer(container, { timeoutMs: input.timeoutMs });
    } else {
      await client.startContainer(container, { timeoutMs: input.timeoutMs });
    }
  } catch (cause) {
    await client
      .removeContainer(container, {
        force: true,
        volumes: true,
        timeoutMs: input.timeoutMs,
      })
      .catch(() => undefined);

    throw diskQuotaError(cause, input.resources.diskMiB);
  }

  try {
    return input.network.mode === 'disabled'
      ? { access: undefined, dispose: () => Promise.resolve() }
      : await configureDockerHost({
          client,
          container,
          inspect: await client.inspectContainer(container, {
            timeoutMs: input.timeoutMs,
          }),
          network: input.network,
          config,
        });
  } catch (cause) {
    await client
      .removeContainer(container, { force: true, volumes: true })
      .catch(() => undefined);

    throw cause;
  }
};

/**
 * The create body of a sandbox container. Reuse compares a container against
 * this same body, so the settings it names are defined in one place.
 */
const containerInput = (
  input: SandboxProvisionInput,
  workspace: Workspace | undefined,
  diskQuota: boolean,
): CreateContainerInput => {
  const ssh = input.network.ssh;

  return {
    image: input.image,
    name: input.name,
    cmd: ['sh', '-lc', 'while :; do sleep 3600; done'],
    workingDir: input.root,
    labels: {
      'doric.sandbox': 'true',
      'doric.sandbox.root': input.root,
      ...(workspace === undefined
        ? {}
        : { 'doric.sandbox.workspace': workspace.identity }),
    },
    hostConfig: {
      AutoRemove: false,
      Binds:
        workspace === undefined ? [] : [`${workspace.volume}:${input.root}`],
      NetworkMode: input.network.mode === 'disabled' ? 'none' : 'bridge',
      Memory: input.resources.memoryMiB * 1024 * 1024,
      NanoCpus: input.resources.cpuCount * 1_000_000_000,
      ...(diskQuota
        ? { StorageOpt: { size: `${input.resources.diskMiB}M` } }
        : {}),
      ...(input.network.dnsServers === undefined
        ? {}
        : { Dns: [...input.network.dnsServers] }),
      ...(ssh === false
        ? {}
        : {
            PortBindings: {
              '22/tcp': [
                {
                  HostIp: ssh.bindAddress,
                  HostPort: ssh.port === undefined ? '' : String(ssh.port),
                },
              ],
            },
          }),
    },
    networkDisabled: input.network.mode === 'disabled',
    exposedPorts: ssh === false ? undefined : ['22/tcp'],
  };
};

const createSandboxContainer = async (
  client: DockerClient,
  input: SandboxProvisionInput,
  workspace: Workspace | undefined,
): Promise<ContainerRef> => {
  const create = (diskQuota: boolean): Promise<ContainerRef> =>
    client.createContainer(containerInput(input, workspace, diskQuota), {
      timeoutMs: input.timeoutMs,
    });

  try {
    return await create(true);
  } catch (cause) {
    if (!unsupportedDiskQuota(cause)) {
      throw diskQuotaError(cause, input.resources.diskMiB);
    }

    return create(false).catch((retryCause) => {
      throw diskQuotaError(retryCause, input.resources.diskMiB);
    });
  }
};

/** The sandbox runtime over one served container. */
const runtimeFor = (
  client: DockerClient,
  input: SandboxProvisionInput,
  served: Served,
  release: () => Promise<void>,
): SandboxRuntime => {
  const { container, host } = served;
  let released: Promise<void> | undefined;

  return {
    id: container.id,
    start: (input) => {
      if (client.start === undefined)
        throw new Error('Docker client does not support live processes');
      return client.start(container, input);
    },
    exec: (execInput) =>
      client.exec(container, {
        ...execInput,
        workingDir: execInput.cwd,
      }),
    async putFile(path, bytes) {
      const index = path.lastIndexOf('/');

      await client.putArchive(container, {
        path: path.slice(0, index),
        archive: packFile(path.slice(index + 1), bytes),
      });
    },
    async getFile(path) {
      return extractFirstFile(await client.getArchive(container, { path }))
        .data;
    },
    async stats() {
      const reading = await client.stats(container, {
        cpuCount: input.resources.cpuCount,
        timeoutMs: input.timeoutMs,
      });

      return {
        ...reading,
        cpuCount: input.resources.cpuCount,
        at: new Date().toISOString(),
      };
    },
    ssh() {
      return Promise.resolve(host.access);
    },
    dispose() {
      // Concurrent and repeated calls share one release, so the lease gives up
      // its hold once. A failed release is retried by the next call.
      released ??= release().catch((cause: unknown) => {
        released = undefined;

        throw cause;
      });

      return released;
    },
  };
};

/** Releases the host side of a container, then removes the container. */
const teardown = async (
  client: DockerClient,
  container: ContainerRef,
  host: DockerHostResources,
): Promise<void> => {
  const failures: unknown[] = [];

  await host.dispose().catch((cause) => failures.push(cause));

  await client
    .removeContainer(container, { force: true, volumes: true })
    .catch((cause) => failures.push(cause));

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Docker sandbox cleanup failed');
  }
};

const registryOf = (client: DockerClient): Registry => {
  const existing = registries.get(client);

  if (existing !== undefined) {
    return existing;
  }

  const created: Registry = { attachments: new Map(), queues: new Map() };

  registries.set(client, created);

  return created;
};

/**
 * Runs `task` once every earlier task for the same identity has settled, so
 * one workspace is provisioned and released one step at a time.
 */
const serialized = <Value>(
  client: DockerClient,
  identity: string,
  task: () => Promise<Value>,
): Promise<Value> => {
  const { queues } = registryOf(client);
  const run = (queues.get(identity) ?? Promise.resolve()).then(task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );

  queues.set(identity, settled);

  void settled.then(() => {
    if (queues.get(identity) === settled) {
      queues.delete(identity);
    }
  });

  return run;
};

const ensureImage = async (
  client: DockerClient,
  input: SandboxProvisionInput,
): Promise<void> => {
  if (
    input.imagePullPolicy === 'if-not-present' &&
    (await client.inspectImage(input.image, { timeoutMs: input.timeoutMs })) !==
      undefined
  ) {
    return;
  }

  await client.pullImage(
    { image: input.image },
    { timeoutMs: input.timeoutMs },
  );
};
const pattern = /^[A-Za-z0-9][A-Za-z0-9_.-]+$/u;

const validateName = (name: string | undefined): void => {
  if (name !== undefined && !pattern.test(name)) {
    throw new Error(`Docker container name must match ${pattern}: ${name}`);
  }
};

const diskQuotaError = (cause: unknown, diskMiB: number): unknown => {
  return unsupportedDiskQuota(cause)
    ? new Error(
        `Docker cannot enforce the requested ${diskMiB} MiB writable-layer quota; use a quota-capable local Linux storage driver`,
        { cause },
      )
    : cause;
};

const unsupportedDiskQuota = (cause: unknown): boolean =>
  /storage-opt|quota|size/u.test(errorMessage(cause).toLowerCase());

const errorMessage = (cause: unknown): string =>
  cause instanceof DockerHttpError
    ? `${cause.message} ${cause.body}`
    : cause instanceof Error
      ? cause.message
      : '';
