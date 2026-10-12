// The real core bundle as the host would distribute it: its built dist
// files (desktop part, contracts, schemas), plus the host-only foundation
// its manifest requires.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { DistributionBundle, DistributionCatalog } from 'bundle/runtime';

import { type FixtureBundle, fixtureDistribution } from './distribution';

export const CORE_DIST = resolve('bundles/foundation/core/dist');

/** The host-only foundation that satisfies the core's backends. */
export const memoryFoundation: FixtureBundle = {
  id: 'memory',
  phase: 'foundation',
  provides: [
    { id: 'storage.backend/v1', environment: 'host', local: true },
    { id: 'secrets.backend/v1', environment: 'host', local: true },
  ],
};

export const coreBundle = async (): Promise<{
  readonly bundle: DistributionBundle;
  readonly artifacts: Map<string, Buffer>;
}> => {
  // The host's Node entry has top-level await: loaded with import().
  const { distributionFiles, distributionParts } = await import('bundle');
  const files = await distributionFiles(CORE_DIST);
  const artifacts = new Map<string, Buffer>();

  for (const file of files) {
    artifacts.set(file.sha256, await readFile(join(CORE_DIST, file.path)));
  }

  const manifest = JSON.parse(
    await readFile(join(CORE_DIST, 'manifest.json'), 'utf8'),
  );
  const descriptor = JSON.parse(
    await readFile(join(CORE_DIST, 'contracts.json'), 'utf8'),
  );

  return {
    bundle: {
      id: manifest.id,
      version: manifest.version,
      state: 'active',
      reasons: [],
      manifest,
      descriptor,
      files,
      parts: distributionParts(files),
    },
    artifacts,
  };
};

/** The host contracts a bundle's descriptor provides, as the host lists them. */
const hostContractsOf = (
  bundle: DistributionBundle,
): DistributionCatalog['host']['contracts'] =>
  (
    bundle.descriptor as unknown as {
      readonly contracts: readonly {
        readonly id: string;
        readonly version: string;
        readonly environment: string;
        readonly cardinality: 'one' | 'many';
      }[];
    }
  ).contracts
    .filter((contract) => contract.environment === 'host')
    .map((contract) => ({
      id: contract.id,
      environment: 'host' as const,
      cardinality: contract.cardinality,
      providers: [
        {
          bundleId: bundle.id,
          version: contract.version,
          bundleVersion: bundle.version,
        },
      ],
    }));

/**
 * A distribution of the real core, the foundation and fixture bundles; the
 * artifacts serve every file by hash.
 */
export const coreDistribution = async (
  input: {
    readonly bundles?: readonly FixtureBundle[];
    readonly core?: string;
    readonly generation?: number;
    readonly hostBoot?: string;
  } = {},
): Promise<{
  readonly catalog: DistributionCatalog;
  readonly artifacts: ReadonlyMap<string, Buffer>;
}> => {
  const core = await coreBundle();
  const fixture = fixtureDistribution({
    core: input.core ?? 'core',
    bundles: [memoryFoundation, ...(input.bundles ?? [])],
    ...(input.generation === undefined ? {} : { generation: input.generation }),
    ...(input.hostBoot === undefined ? {} : { hostBoot: input.hostBoot }),
  });
  const withCore = (input.core ?? 'core') === 'core';
  const bundles = withCore
    ? [core.bundle, ...fixture.catalog.bundles]
    : [...fixture.catalog.bundles];
  const enabled = bundles.map((bundle) => bundle.id);
  const composition = { core: input.core ?? 'core', enabled, providers: {} };
  const artifacts = new Map<string, Buffer>(
    withCore ? core.artifacts : new Map(),
  );

  for (const [hash, content] of fixture.artifacts) {
    artifacts.set(hash, Buffer.from(content));
  }

  return {
    catalog: {
      ...fixture.catalog,
      composition,
      host: {
        ...fixture.catalog.host,
        composition,
        bundles: [
          ...(withCore
            ? [
                {
                  id: core.bundle.id,
                  version: core.bundle.version,
                  state: 'active' as const,
                  phase: 'core' as const,
                  ...(core.bundle.manifest === undefined
                    ? {}
                    : { manifest: core.bundle.manifest }),
                  reasons: [],
                },
              ]
            : []),
          ...fixture.catalog.host.bundles,
        ],
        order: enabled,
        // What a real host publishes: the core's own host contracts too
        // (`hooks/v1`, `log/v1`, `settings/v1` are also desktopMain ones).
        contracts: [
          ...(withCore ? hostContractsOf(core.bundle) : []),
          ...fixture.catalog.host.contracts,
        ],
      },
      bundles,
    },
    artifacts,
  };
};
