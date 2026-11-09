// The real bundles as the host would distribute them: their built dist files
// (desktop and client parts, contracts, schemas), plus the host-only bundles
// their manifests require.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { DistributionBundle, DistributionCatalog } from 'bundle/runtime';

import { type FixtureBundle, fixtureDistribution } from './distribution';

export const CORE_DIST = resolve('bundles/foundation/core/dist');
export const LAYOUT_DIST = resolve('bundles/desktop/layout/dist');
export const RESOURCES_DIST = resolve('bundles/features/resources/dist');
/** The real runtime bundle: only its manifest, descriptor and schemas are read. */
export const RUNTIME_DIST = resolve('bundles/runtime/runtime/dist');

/** The host-only foundation that satisfies the core's backends. */
export const memoryFoundation: FixtureBundle = {
  id: 'memory',
  phase: 'foundation',
  provides: [
    { id: 'storage.backend/v1', environment: 'host', local: true },
    { id: 'secrets.backend/v1', environment: 'host', local: true },
  ],
};

export interface BuiltBundle {
  readonly bundle: DistributionBundle;
  readonly artifacts: Map<string, Buffer>;
  readonly phase: 'foundation' | 'core' | 'others';
}

interface DescriptorEntry {
  readonly id: string;
  readonly version: string;
  readonly environment: string;
  readonly cardinality: 'one' | 'many';
  readonly schema: string;
}

const contractsOf = (bundle: DistributionBundle): readonly DescriptorEntry[] =>
  (
    bundle.descriptor as unknown as {
      readonly contracts: readonly DescriptorEntry[];
    }
  ).contracts;

/** A bundle's built `dist` directory, every file served by its hash. */
export const builtBundle = async (
  dist: string,
  phase: BuiltBundle['phase'] = 'others',
): Promise<BuiltBundle> => {
  // The host's Node entry has top-level await: loaded with import().
  const { distributionFiles, distributionParts } = await import('bundle');
  const files = await distributionFiles(dist);
  const artifacts = new Map<string, Buffer>();

  for (const file of files) {
    artifacts.set(file.sha256, await readFile(join(dist, file.path)));
  }

  const manifest = JSON.parse(
    await readFile(join(dist, 'manifest.json'), 'utf8'),
  );
  const descriptor = JSON.parse(
    await readFile(join(dist, 'contracts.json'), 'utf8'),
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
    phase,
  };
};

/** The real core bundle. */
export const coreBundle = async (): Promise<BuiltBundle> =>
  builtBundle(CORE_DIST, 'core');

/**
 * A host-only provider of `contracts`, cut from a built bundle: its real
 * versions, schemas, `desktopScope` and contracts part (other bundles import
 * `<id>/contracts`), no host part and no requirements of its own (the host
 * answers the calls; the desktop only routes them).
 */
export const hostOnlyBundle = async (
  dist: string,
  contracts: readonly string[],
): Promise<BuiltBundle> => {
  const real = await builtBundle(dist);
  const wanted = new Set(contracts);
  const entries = contractsOf(real.bundle).filter(
    (entry) => entry.environment === 'host' && wanted.has(entry.id),
  );
  const manifest = {
    ...real.bundle.manifest,
    provides: entries.map((entry) => `${entry.id}@${entry.version}`),
    requires: [],
    desktopScope: Object.fromEntries(
      Object.entries(real.bundle.manifest?.desktopScope ?? {}).filter(([id]) =>
        wanted.has(id),
      ),
    ),
  };
  const descriptor = {
    ...(real.bundle.descriptor as unknown as Record<string, unknown>),
    contracts: entries,
  };
  const content = new Map<string, Buffer>([
    ['manifest.json', Buffer.from(JSON.stringify(manifest))],
    ['contracts.json', Buffer.from(JSON.stringify(descriptor))],
  ]);

  for (const entry of entries) {
    content.set(entry.schema, await readFile(join(dist, entry.schema)));
  }

  for (const file of real.bundle.files) {
    if (file.path.startsWith('contracts/')) {
      content.set(file.path, await readFile(join(dist, file.path)));
    }
  }

  const artifacts = new Map<string, Buffer>();
  const files = [...content]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([path, bytes]) => {
      const sha256 = createHash('sha256').update(bytes).digest('hex');

      artifacts.set(sha256, bytes);

      return { path, sha256, size: bytes.byteLength };
    });

  return {
    bundle: {
      ...real.bundle,
      manifest: manifest as DistributionBundle['manifest'],
      descriptor: descriptor as unknown as DistributionBundle['descriptor'],
      files,
      parts:
        real.bundle.parts.contracts === undefined
          ? {}
          : { contracts: real.bundle.parts.contracts },
    },
    artifacts,
    phase: 'others',
  };
};

/** The host contracts a bundle's descriptor provides, as the host lists them. */
const hostContractsOf = (
  bundle: DistributionBundle,
): DistributionCatalog['host']['contracts'] =>
  contractsOf(bundle)
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
 * A distribution of built bundles (activated in the order given), the
 * foundation and fixture bundles; the artifacts serve every file by hash.
 */
const builtDistribution = (input: {
  readonly built: readonly BuiltBundle[];
  readonly bundles?: readonly FixtureBundle[];
  readonly core?: string;
  readonly generation?: number;
  readonly hostBoot?: string;
}): {
  readonly catalog: DistributionCatalog;
  readonly artifacts: ReadonlyMap<string, Buffer>;
} => {
  const fixture = fixtureDistribution({
    core: input.core ?? 'core',
    bundles: [memoryFoundation, ...(input.bundles ?? [])],
    ...(input.generation === undefined ? {} : { generation: input.generation }),
    ...(input.hostBoot === undefined ? {} : { hostBoot: input.hostBoot }),
  });
  const built = input.built.map((entry) => entry.bundle);
  const bundles = [...built, ...fixture.catalog.bundles];
  const enabled = bundles.map((bundle) => bundle.id);
  const composition = { core: input.core ?? 'core', enabled, providers: {} };
  const artifacts = new Map<string, Buffer>();

  for (const entry of input.built) {
    for (const [hash, bytes] of entry.artifacts) {
      artifacts.set(hash, bytes);
    }
  }

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
          ...input.built.map(({ bundle, phase }) => ({
            id: bundle.id,
            version: bundle.version,
            state: 'active' as const,
            phase,
            ...(bundle.manifest === undefined
              ? {}
              : { manifest: bundle.manifest }),
            reasons: [],
          })),
          ...fixture.catalog.host.bundles,
        ],
        order: enabled,
        // What a real host publishes: the built bundles' own host contracts
        // too (`hooks/v1`, `log/v1`, `settings/v1` are also desktopMain ones).
        contracts: [
          ...built.flatMap(hostContractsOf),
          ...fixture.catalog.host.contracts,
        ],
      },
      bundles,
    },
    artifacts,
  };
};

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
  const withCore = (input.core ?? 'core') === 'core';

  return builtDistribution({
    ...input,
    built: withCore ? [await coreBundle()] : [],
  });
};

/**
 * The workspace distribution: the real core, layout and resources, the
 * memory foundation, and a host-only runtime that provides the host contracts
 * those bundles `require` and none of them provides (`runtime/v1`,
 * `runtime.threads/v1`, `runtime.lease/v1`) with the real runtime's versions
 * and schemas. The host answers those calls (see the e2e `workspace-host`).
 * `bundles` adds fixture bundles after them.
 */
export const workspaceDistribution = async (
  input: { readonly bundles?: readonly FixtureBundle[] } = {},
): Promise<{
  readonly catalog: DistributionCatalog;
  readonly artifacts: ReadonlyMap<string, Buffer>;
}> => {
  const real = [
    await coreBundle(),
    await builtBundle(LAYOUT_DIST),
    await builtBundle(RESOURCES_DIST),
  ];
  const provided = new Set(
    real.flatMap(({ bundle }) => contractsOf(bundle).map((entry) => entry.id)),
  );
  const hostOnly = real
    .flatMap(({ bundle }) => bundle.manifest?.requires ?? [])
    .map((entry) => entry.slice(0, entry.indexOf('@')))
    .filter((id) => !provided.has(id) && !id.endsWith('.backend/v1'));
  const runtime = await hostOnlyBundle(RUNTIME_DIST, [...new Set(hostOnly)]);

  return builtDistribution({
    built: [...real, runtime],
    ...(input.bundles === undefined ? {} : { bundles: input.bundles }),
  });
};
