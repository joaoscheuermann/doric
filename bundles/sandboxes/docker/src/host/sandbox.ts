import {
  defineMethod,
  defineService,
  type HostContext,
  type Log,
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
import type { SandboxPoolBinding } from './service.js';

export type Environment = Readonly<Record<string, string | undefined>>;

export interface DockerSandboxOptions {
  /**
   * Where `DORIC_SANDBOX_IMAGE`, `DORIC_SANDBOX_SSH`,
   * `DORIC_SANDBOX_DOCKER_SOCKET`, `DORIC_SANDBOX_CPUS` and
   * `DORIC_SANDBOX_MEMORY_MIB` are read. Defaults to `process.env`, which the
   * generation process inherits from the kernel.
   */
  readonly environment?: Environment;
  /**
   * Builds the Docker client from the deployment's client options;
   * `createDockerClient` by default.
   */
  readonly client?: (options: CreateDockerClientOptions) => DockerClient;
}

/**
 * A whole positive number read from the environment, or `fallback` when the
 * variable is unset or empty, as Compose passes an unset one. Any other value
 * fails activation instead of silently provisioning with the fallback.
 */
const positiveInteger = (
  environment: Environment,
  name: string,
  fallback: number,
): number => {
  const value = environment[name];

  if (value === undefined || value === '') {
    return fallback;
  }

  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a whole positive number, got "${value}"`);
  }

  return Number(value);
};

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
    // CPU and memory are daemon ceilings rather than reservations, so an idle
    // sandbox holds neither; the deployment sizes them to its machine.
    resources: {
      cpuCount: positiveInteger(environment, 'DORIC_SANDBOX_CPUS', 4),
      memoryMiB: positiveInteger(environment, 'DORIC_SANDBOX_MEMORY_MIB', 2048),
      diskMiB: 4096,
    },
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
 * Builds the binding `createSandboxService` runs on: the client, the VM
 * registry and the pool from `options` and the environment (as activation
 * does today), with `log` as the pool's logger sink. Contacts nothing until
 * the first acquisition. Throws as today for a malformed `DORIC_SANDBOX_*`
 * value.
 */
export const dockerSandboxBinding = (
  options: DockerSandboxOptions,
  log: Log,
): SandboxPoolBinding => {
  const settings = dockerSandboxSettings(options.environment ?? process.env);
  const client = (options.client ?? createDockerClient)({
    exposeDockerSocket: settings.dockerSocket,
  });
  const vms = createVmRegistry('docker', client);
  const pool = createSandpool({
    ...settings.limits,
    logger: logV1Logger(log),
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

  return {
    pool,
    vms,
    description: { provider: 'docker', durableWorkspace: true },
    discard: (identity) => discardWorkspace(client, identity),
  };
};

/**
 * The host part of the `docker` bundle: builds the Docker client, the VM
 * registry and the sandbox pool, provides `sandbox/v1` over them, and
 * disposes the pool on deactivation. Nothing is contacted until the first
 * acquisition.
 */
export const activateDockerSandbox =
  (options: DockerSandboxOptions = {}) =>
  ({ services }: HostContext) => {
    const { pool, vms, description, discard } = dockerSandboxBinding(
      options,
      services.use(LogV1),
    );

    services.provide(
      defineService(SandboxV1, {
        describe: defineMethod({
          ...sandboxMethods.describe,
          execute: async () => description,
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
          execute: discard,
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

    return () => pool.dispose();
  };
