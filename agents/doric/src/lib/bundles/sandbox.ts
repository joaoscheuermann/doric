/**
 * The sandbox settings the kernel logs at its `sandbox_pool` stage. The
 * `sandbox-adapter` bundle builds the pool in the generation process, which
 * inherits this environment and reads the same variables the same way, so
 * these lines describe the pool it builds.
 */
export const sandboxSettings = (
  environment: Readonly<Record<string, string | undefined>>,
) => {
  const providerName: 'docker' | 'firecracker' =
    environment.DORIC_SANDBOX_PROVIDER === 'firecracker'
      ? 'firecracker'
      : 'docker';

  return {
    providerName,
    image: environment.DORIC_SANDBOX_IMAGE ?? 'node:22-bookworm',
    ssh: environment.DORIC_SANDBOX_SSH === 'true',
    resources: {
      cpuCount: 1,
      memoryMiB: providerName === 'docker' ? 2048 : 512,
      diskMiB: 4096,
    },
    limits: { minIdle: 0, maxSandboxes: 10, maxCreateAttempts: 3 },
  } as const;
};
