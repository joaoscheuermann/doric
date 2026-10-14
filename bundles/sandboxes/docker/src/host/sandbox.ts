import {
  defineMethod,
  defineService,
  type HostContext,
  LogV1,
} from 'bundle/contracts';
import {
  type CreateDockerClientOptions,
  createDockerClient,
  type DockerClient,
  discardWorkspace,
} from 'docker-sandbox';
import { SandboxV1, sandboxMethods } from 'runtime/contracts';
import { createSandbox, createVmRegistry } from 'sandbox';
import { createSandpool } from 'sandpool';

import { logV1Logger } from './logger.js';
import { logSandboxPool } from './start.js';

export type Environment = Readonly<Record<string, string | undefined>>;

export interface DockerSandboxOptions {
  /**
   * Where `DORIC_SANDBOX_IMAGE`, `DORIC_SANDBOX_SSH` and
   * `DORIC_SANDBOX_DOCKER_SOCKET` are read. Defaults to `process.env`, which the
   * generation process inherits from the kernel.
   */
  readonly environment?: Environment;
  /**
   * Builds the Docker client from the deployment's client options;
   * `createDockerClient` by default.
   */
  readonly client?: (options: CreateDockerClientOptions) => DockerClient;
}

/** The deployment settings of the Docker sandboxes, read at activation. */
export const dockerSandboxSettings = (environment: Environment) =>
  ({
    // The image is a deployment choice, so it comes from the environment and
    // defaults to the plain Node image an operator gets without building one.
    // A named local tag that was never built fails the provider's pull
    // instead of silently falling back to that default.
    image: environment.DORIC_SANDBOX_IMAGE ?? 'node:22-bookworm',
    ssh: environment.DORIC_SANDBOX_SSH === 'true',
    // Sharing the daemon socket is a deployment choice as well: it is what lets
    // a sandbox build the images its Project describes, and it hands that
    // sandbox the daemon's authority on the host, so only an exact `true` asks
    // for it.
    dockerSocket: environment.DORIC_SANDBOX_DOCKER_SOCKET === 'true',
    resources: { cpuCount: 1, memoryMiB: 2048, diskMiB: 4096 },
    limits: {
      // Every acquisition Doric makes names the Project it serves, and the
      // pool provisions a new session for an identified acquisition instead
      // of leasing a warmed one, so warming would only hold capacity Doric
      // cannot use.
      minIdle: 0,
      maxSandboxes: 10,
      maxCreateAttempts: 3,
    },
  }) as const;

/**
 * The host part of the `docker` bundle: builds the Docker client, the VM
 * registry and the sandbox pool, provides `sandbox/v1` over them, and
 * disposes the pool on deactivation. Nothing is contacted until the first
 * acquisition.
 */
export const activateDockerSandbox =
  (options: DockerSandboxOptions = {}) =>
  ({ services }: HostContext) => {
    const settings = dockerSandboxSettings(options.environment ?? process.env);
    const client = (options.client ?? createDockerClient)({
      exposeDockerSocket: settings.dockerSocket,
    });
    const vms = createVmRegistry('docker', client);
    const pool = createSandpool({
      ...settings.limits,
      logger: logV1Logger(services.use(LogV1)),
      create: (identity) =>
        createSandbox({
          provider: vms.provider,
          image: settings.image,
          imagePullPolicy: 'if-not-present',
          resources: settings.resources,
          // The Project id names the durable workspace the sandbox reattaches.
          workspace: identity,
          network: {
            mode: 'egress',
            ssh: settings.ssh,
            dnsServers: ['1.1.1.1'],
          },
        }),
    });

    services.provide(
      defineService(SandboxV1, {
        describe: defineMethod({
          ...sandboxMethods.describe,
          execute: async () => ({ provider: 'docker', durableWorkspace: true }),
        }),
        acquire: defineMethod({
          ...sandboxMethods.acquire,
          execute: ({ identity, signal }) =>
            pool.acquire({
              identity,
              ...(signal === undefined ? {} : { signal }),
            }),
        }),
        discard: defineMethod({
          ...sandboxMethods.discard,
          execute: (identity) => discardWorkspace(client, identity),
        }),
        machines: defineMethod({
          ...sandboxMethods.machines,
          execute: async () => vms.list(),
        }),
        machine: defineMethod({
          ...sandboxMethods.machine,
          execute: async (id) => vms.find(id),
        }),
      }),
    );

    const start = logSandboxPool(services, options.environment ?? process.env);

    return () => {
      start.dispose();
      return pool.dispose();
    };
  };
