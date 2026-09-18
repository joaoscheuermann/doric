import type { SandboxProvisionInput, SandboxRuntime } from 'sandbox';

import { DockerHttpError } from './classes/errors.js';
import {
  configureDockerHost,
  type DockerHostConfig,
  type DockerHostResources,
  preflightDockerHost,
} from './host.js';
import type { ContainerRef, DockerClient } from './types/docker.js';
import { extractFirstFile, packFile } from './utils/tar.js';

/** Provisions a Docker-backed implementation of the common sandbox runtime. */
export const provisionDocker = async (
  client: DockerClient,
  input: SandboxProvisionInput,
  config: DockerHostConfig,
): Promise<SandboxRuntime> => {
  validateName(input.name);

  await preflightDockerHost(input.network, config);

  await ensureImage(client, input);

  const ssh = input.network.ssh;

  const create = (diskQuota: boolean): Promise<ContainerRef> =>
    client.createContainer(
      {
        image: input.image,
        name: input.name,
        cmd: ['sh', '-lc', 'while :; do sleep 3600; done'],
        workingDir: input.root,
        labels: {
          'doric.sandbox': 'true',
          'doric.sandbox.root': input.root,
        },
        hostConfig: {
          AutoRemove: false,
          Binds: [],
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
      },
      { timeoutMs: input.timeoutMs },
    );
  let container: ContainerRef;

  try {
    container = await create(true);
  } catch (cause) {
    if (!unsupportedDiskQuota(cause)) {
      throw diskQuotaError(cause, input.resources.diskMiB);
    }

    container = await create(false).catch((retryCause) => {
      throw diskQuotaError(retryCause, input.resources.diskMiB);
    });
  }

  try {
    await client.startContainer(container, { timeoutMs: input.timeoutMs });
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

  let host!: DockerHostResources;

  try {
    host =
      input.network.mode === 'disabled'
        ? { access: undefined, dispose: async () => undefined }
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

  let disposed = false;

  return {
    id: container.id,
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
    async ssh() {
      return host.access;
    },
    async dispose() {
      if (disposed) {
        return;
      }

      const failures: unknown[] = [];

      await host.dispose().catch((cause) => failures.push(cause));

      await client
        .removeContainer(container, { force: true, volumes: true })
        .catch((cause) => failures.push(cause));

      if (failures.length > 0) {
        throw new AggregateError(failures, 'Docker sandbox cleanup failed');
      }

      disposed = true;
    },
  };
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
