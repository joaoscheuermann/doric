import {
  defineMethod,
  defineService,
  type HostContext,
  LogV1,
} from 'bundle/contracts';
import {
  createDockerClient,
  type DockerClient,
  discardWorkspace,
} from 'docker-sandbox';
import { createFirecrackerClient } from 'firecracker-sandbox';
import { SandboxV1, sandboxMethods } from 'runtime/contracts';
import { createSandbox, type SandboxProvider } from 'sandbox';
import { createSandpool, type Sandpool } from 'sandpool';

import { logV1Logger } from './logger.js';
import { createMachineRegistry, type MachineProvider } from './registry.js';

export type Environment = Readonly<Record<string, string | undefined>>;

export interface SandboxAdapterOptions {
  /**
   * Where `DORIC_SANDBOX_PROVIDER`, `DORIC_SANDBOX_IMAGE` and
   * `DORIC_SANDBOX_SSH` are read. Defaults to `process.env`, which the
   * generation process inherits from the kernel.
   */
  readonly environment?: Environment;
  /** Builds the Docker client; `createDockerClient()` by default. */
  readonly docker?: () => DockerClient;
  /** Builds the Firecracker provider; `createFirecrackerClient()` by default. */
  readonly firecracker?: () => SandboxProvider;
}

/** The sandbox settings the kernel reads from the same environment for its logs. */
export const sandboxSettings = (environment: Environment) => {
  const providerName: MachineProvider =
    environment.DORIC_SANDBOX_PROVIDER === 'firecracker'
      ? 'firecracker'
      : 'docker';

  return {
    providerName,
    // The image is a deployment choice, so it comes from the environment and
    // defaults to the plain Node image an operator gets without building one.
    // A named local tag that was never built fails the provider's pull
    // instead of silently falling back to that default.
    image: environment.DORIC_SANDBOX_IMAGE ?? 'node:22-bookworm',
    ssh: environment.DORIC_SANDBOX_SSH === 'true',
    resources: {
      cpuCount: 1,
      memoryMiB: providerName === 'docker' ? 2048 : 512,
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
  } as const;
};

/**
 * The host part of the provisional `sandbox-adapter`: builds the client, the
 * machine registry and the sandbox pool exactly as the kernel's
 * `sandbox_pool` stage did, provides `sandbox/v1` over them, and disposes the
 * pool on deactivation. Nothing is contacted until the first acquisition.
 */
export const activateSandboxAdapter =
  (options: SandboxAdapterOptions = {}) =>
  ({ services }: HostContext) => {
    const settings = sandboxSettings(options.environment ?? process.env);
    const docker =
      settings.providerName === 'firecracker'
        ? undefined
        : (options.docker ?? createDockerClient)();
    const machines = createMachineRegistry(
      settings.providerName,
      docker ?? (options.firecracker ?? createFirecrackerClient)(),
    );
    const pool: Sandpool = createSandpool({
      ...settings.limits,
      logger: logV1Logger(services.use(LogV1)),
      create: (identity) =>
        createSandbox({
          provider: machines.provider,
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
          execute: async () => ({
            provider: settings.providerName,
            durableWorkspace: docker !== undefined,
          }),
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
          execute: async (identity) => {
            if (docker !== undefined) await discardWorkspace(docker, identity);
          },
        }),
        machines: defineMethod({
          ...sandboxMethods.machines,
          execute: async () => machines.list(),
        }),
        machine: defineMethod({
          ...sandboxMethods.machine,
          execute: async (id) => machines.find(id),
        }),
      }),
    );

    return () => pool.dispose();
  };
