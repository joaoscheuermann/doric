// What the desktop resolves from a host distribution catalog. Pure and
// browser-safe: the desktop main process resolves desktopMain and client
// from it without reading the host's files.

import type {
  DistributionBundle,
  DistributionCatalog,
  QuarantineReason,
} from '../contracts/platform.js';
import type { CatalogCandidate } from './catalog.js';
import type { Composition } from './composition.js';
import { descriptorSchema } from './descriptor.js';
import { manifestV1Schema } from './manifest.js';

export type {
  DistributionArtifact,
  DistributionBundle,
  DistributionCatalog,
  DistributionFile,
  DistributionParts,
} from '../contracts/platform.js';
export {
  distributionArtifactSchema,
  distributionCatalogSchema,
  distributionFileSchema,
} from '../contracts/platform.js';

/** The source of a distributed candidate: `<id>@<version>` of the host generation. */
export const distributedSource = (bundle: {
  readonly id: string;
  readonly version: string;
}): CatalogCandidate['source'] => ({
  kind: 'installed',
  dir: `${bundle.id}@${bundle.version}`,
});

const candidateOf = (
  bundle: DistributionBundle,
  embedded = false,
): CatalogCandidate => {
  const source: CatalogCandidate['source'] = embedded
    ? { kind: 'embedded' }
    : distributedSource(bundle);
  const manifest = manifestV1Schema.safeParse(bundle.manifest);

  if (!manifest.success) {
    return {
      id: bundle.id,
      source,
      errors: [
        ...bundle.reasons,
        ...(bundle.reasons.some((reason) => reason.code === 'invalid_manifest')
          ? []
          : [
              {
                code: 'invalid_manifest' as const,
                message:
                  bundle.manifest === undefined
                    ? 'manifest is missing'
                    : manifest.error.message,
              },
            ]),
      ],
    };
  }

  // [S8-8] A bundle quarantined on the host is quarantined on the desktop
  // with the same reasons.
  const errors: QuarantineReason[] =
    bundle.state === 'quarantined' ? [...bundle.reasons] : [];

  if (bundle.descriptor === undefined) {
    return { id: manifest.data.id, source, manifest: manifest.data, errors };
  }

  const descriptor = descriptorSchema.safeParse(bundle.descriptor);

  if (!descriptor.success) {
    return {
      id: manifest.data.id,
      source,
      manifest: manifest.data,
      errors: [
        ...errors,
        { code: 'invalid_descriptor', message: descriptor.error.message },
      ],
    };
  }

  return {
    id: manifest.data.id,
    source,
    manifest: manifest.data,
    descriptor: descriptor.data,
    errors,
  };
};

/**
 * The candidates the desktop resolves for desktopMain and client, in the
 * host's order. Host-side quarantine reasons become candidate errors [S8-8].
 */
export const candidatesFromDistribution = (
  catalog: DistributionCatalog,
): CatalogCandidate[] => {
  // The kernel-embedded bundles (`host-config`, `transport`) are always
  // enabled outside the composition; the host lists them, active and without
  // a desktop part. They keep that standing on the desktop, so a part that
  // requires a contract only they provide (`host-config/v1`, `resources/v1`)
  // resolves as it does on the host instead of seeing a disabled provider.
  const enabled = new Set(catalog.composition.enabled);

  return catalog.bundles.map((bundle) =>
    candidateOf(
      bundle,
      !enabled.has(bundle.id) &&
        bundle.state === 'active' &&
        bundle.parts.desktopMain === undefined &&
        bundle.parts.client === undefined,
    ),
  );
};

/**
 * The composition the desktop resolves: the host's, without the bundles the
 * host disabled [S8-8].
 */
export const compositionFromDistribution = (
  catalog: DistributionCatalog,
): Composition => {
  const disabled = new Set(
    catalog.bundles
      .filter((bundle) => bundle.state === 'disabled')
      .map((bundle) => bundle.id),
  );

  return {
    core: catalog.composition.core,
    enabled: catalog.composition.enabled.filter((id) => !disabled.has(id)),
    providers: { ...catalog.composition.providers },
  };
};
