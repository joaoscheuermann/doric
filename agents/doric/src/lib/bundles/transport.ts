import type { EmbeddedBundle, KernelPlatform } from 'bundle';
import { createTransport, type TransportOptions } from 'transport/kernel';

export interface HostTransport {
  readonly bundle: EmbeddedBundle;
  /** Binds the booted platform, whose services the feature routes call. */
  bind(platform: Pick<KernelPlatform, 'services'>): void;
}

/**
 * The kernel-embedded `transport`, whose stage-10 feature routes call the
 * `files`, `git`, `usage`, `resources` and `terminal` bundles through the
 * platform's services, as the desktop bridge does: those bundles stay
 * optional, so disabling or quarantining one never takes the structural
 * transport with it. No request reaches a route before the host listens,
 * which is after `bind`.
 */
export const createHostTransport = (
  options: Omit<TransportOptions, 'features'>,
): HostTransport => {
  let platform: Pick<KernelPlatform, 'services'> | undefined;

  return {
    bundle: createTransport({
      ...options,
      features: () => {
        if (platform === undefined) throw new Error('Doric is not ready.');
        return platform.services;
      },
    }),
    bind: (booted) => {
      platform = booted;
    },
  };
};
