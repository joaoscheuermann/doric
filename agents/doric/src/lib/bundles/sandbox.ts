import { type Composition, readComposition } from 'bundle';

type Environment = Readonly<Record<string, string | undefined>>;

export type SandboxProviderName = 'docker' | 'firecracker';

/**
 * The composition the kernel boots and the sandbox bundle it enables
 * (D10-9). The shipped composition enables `docker`; without
 * `DORIC_COMPOSITION`, `DORIC_SANDBOX_PROVIDER=firecracker` boots it with
 * `firecracker` in its place, as that variable chose the pool before. An
 * operator composition is booted as written, and names the provider itself.
 * A composition that cannot be read here is left to the kernel, which refuses
 * it at the `bundle_load` stage as before.
 */
export const sandboxComposition = async (
  environment: Environment,
  compositionPath: string,
): Promise<{
  readonly composition: Composition | { readonly path: string };
  readonly providerName: SandboxProviderName;
}> => {
  const requested: SandboxProviderName =
    environment.DORIC_SANDBOX_PROVIDER === 'firecracker'
      ? 'firecracker'
      : 'docker';
  let composition: Composition;

  try {
    composition = await readComposition(compositionPath);
  } catch {
    return { composition: { path: compositionPath }, providerName: requested };
  }

  if (
    environment.DORIC_COMPOSITION === undefined &&
    requested === 'firecracker'
  )
    return {
      composition: {
        ...composition,
        enabled: composition.enabled.map((id) =>
          id === 'docker' ? 'firecracker' : id,
        ),
      },
      providerName: 'firecracker',
    };

  return {
    composition: { path: compositionPath },
    providerName:
      composition.enabled.includes('firecracker') &&
      !composition.enabled.includes('docker')
        ? 'firecracker'
        : 'docker',
  };
};

/**
 * The sandbox settings the kernel logs at its `sandbox_pool` stage. The
 * enabled `docker` or `firecracker` bundle builds the pool in the generation
 * process, which inherits this environment and reads the same variables the
 * same way, so these lines describe the pool it builds.
 */
export const sandboxSettings = (
  environment: Environment,
  providerName: SandboxProviderName,
) =>
  ({
    providerName,
    image: environment.DORIC_SANDBOX_IMAGE ?? 'node:22-bookworm',
    ssh: environment.DORIC_SANDBOX_SSH === 'true',
    resources: {
      cpuCount: 1,
      memoryMiB: providerName === 'docker' ? 2048 : 512,
      diskMiB: 4096,
    },
    limits: { minIdle: 0, maxSandboxes: 10, maxCreateAttempts: 3 },
  }) as const;
