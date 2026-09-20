import type { SandboxProvider } from 'sandbox';

import { nodeTransport } from './api.js';
import { preflightFirecrackerHost } from './preflight.js';
import { reconcileStaleFirecrackerResources } from './reconcile.js';
import { provisionFirecracker } from './runtime.js';
import type {
  CreateFirecrackerClientOptions,
  FirecrackerConfig,
  FirecrackerPaths,
} from './types.js';

export const FIRECRACKER_VERSION = '1.16.1';

export const GUEST_KERNEL_VERSION = '6.18';

export const DEFAULT_FIRECRACKER_PATHS: FirecrackerPaths = {
  firecracker: '/usr/local/bin/firecracker',
  jailer: '/usr/local/bin/jailer',
  kernel: '/opt/doric/firecracker/vmlinux',
  initramfs: '/opt/doric/firecracker/initramfs.cpio',
  dropbear: '/opt/doric/firecracker/dropbearmulti',
  state: '/var/lib/doric/firecracker',
  cache: '/var/cache/doric/firecracker',
};

/** Creates a direct Firecracker/KVM sandbox provider with container defaults. */
export const createFirecrackerClient = (
  options: CreateFirecrackerClientOptions = {},
): SandboxProvider => {
  const config: FirecrackerConfig = {
    paths: { ...DEFAULT_FIRECRACKER_PATHS, ...options.paths },
    networkPool: options.networkPool ?? '10.231.0.0/16',
    cacheLimitBytes: options.cacheLimitBytes ?? 20 * 1024 ** 3,
    readinessTimeoutMs: options.readinessTimeoutMs ?? 30_000,
    jailerUid: options.jailerUid ?? 0,
    jailerGid: options.jailerGid ?? 0,
    transport: options.transport ?? nodeTransport,
  };
  const preflight = options.preflight ?? preflightFirecrackerHost;
  const provision = options.provision ?? provisionFirecracker;
  let reconciliation: Promise<void> | undefined;

  return {
    async provision(input) {
      await preflight(config);

      reconciliation ??= reconcileStaleFirecrackerResources(config);

      await reconciliation;

      return provision(input, config);
    },
  };
};
