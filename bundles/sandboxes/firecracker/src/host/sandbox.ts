import {
  defineMethod,
  defineService,
  type HostContext,
  LogV1,
} from 'bundle/contracts';
import { createFirecrackerClient } from 'firecracker-sandbox';
import { SandboxV1, sandboxMethods } from 'runtime/contracts';
import { createSandbox, createVmRegistry, type SandboxProvider } from 'sandbox';
import { createSandpool } from 'sandpool';

import { logV1Logger } from './logger.js';
import { logSandboxPool } from './start.js';

export type Environment = Readonly<Record<string, string | undefined>>;

export interface FirecrackerSandboxOptions {
  /**
   * Where `DORIC_SANDBOX_IMAGE` and `DORIC_SANDBOX_SSH` are read. Defaults
   * to `process.env`, which the generation process inherits from the kernel.
   */
  readonly environment?: Environment;
  /** Builds the Firecracker provider; `createFirecrackerClient()` by default. */
  readonly client?: () => SandboxProvider;
}

/** The deployment settings of the Firecracker sandboxes, read at activation. */
export const firecrackerSandboxSettings = (environment: Environment) =>
  ({
    // The image is a deployment choice, so it comes from the environment and
    // defaults to the plain Node image an operator gets without building one.
    // A named local tag that was never built fails the provider's pull
    // instead of silently falling back to that default.
    image: environment.DORIC_SANDBOX_IMAGE ?? 'node:22-bookworm',
    ssh: environment.DORIC_SANDBOX_SSH === 'true',
    resources: { cpuCount: 1, memoryMiB: 512, diskMiB: 4096 },
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
 * The host part of the `firecracker` bundle: builds the Firecracker client, the VM
 * registry and the sandbox pool, provides `sandbox/v1` over them, and
 * disposes the pool on deactivation. Nothing is contacted until the first
 * acquisition.
 */
export const activateFirecrackerSandbox =
  (options: FirecrackerSandboxOptions = {}) =>
  ({ services }: HostContext) => {
    const settings = firecrackerSandboxSettings(
      options.environment ?? process.env,
    );
    const client = (options.client ?? createFirecrackerClient)();
    const vms = createVmRegistry('firecracker', client);
    const pool = createSandpool({
      ...settings.limits,
      logger: logV1Logger(services.use(LogV1)),
      create: (identity) =>
        createSandbox({
          provider: vms.provider,
          image: settings.image,
          imagePullPolicy: 'if-not-present',
          resources: settings.resources,
          // The Project id is passed as the workspace name, as on Docker;
          // Firecracker keeps no durable workspace for it.
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
            provider: 'firecracker',
            durableWorkspace: false,
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
          // Firecracker keeps no durable workspace, so there is nothing to
          // discard.
          execute: async () => undefined,
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
