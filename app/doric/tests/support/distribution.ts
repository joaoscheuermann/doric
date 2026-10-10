// Fixture host distributions: bundles with in-memory files, the catalog the
// host would publish for them and its artifact store (bytes by hash).

import { createHash } from 'node:crypto';

import type {
  DistributionBundle,
  DistributionCatalog,
} from 'bundle/runtime';

export interface FixtureContract {
  readonly id: string;
  readonly environment: 'host' | 'desktopMain' | 'client';
  readonly kind?: 'service' | 'hooks' | 'command' | 'event' | 'settings';
  readonly local?: boolean;
  /** The contract document (`$defs` with `<method>.input/.output`). */
  readonly document?: Readonly<Record<string, unknown>>;
}

export interface FixtureBundle {
  readonly id: string;
  readonly version?: string;
  readonly engines?: string;
  readonly provides?: readonly FixtureContract[];
  readonly requires?: readonly string[];
  /** dist-relative path → content. */
  readonly files?: Readonly<Record<string, string>>;
  /** Host-side state (default active). */
  readonly state?: DistributionBundle['state'];
  readonly reasons?: DistributionBundle['reasons'];
  readonly phase?: 'foundation' | 'core' | 'others';
}

const sha256 = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

const schemaPath = (id: string): string => `schemas/${id}.json`;

export interface FixtureDistribution {
  readonly catalog: DistributionCatalog;
  /** Bytes by SHA-256, as `doric.catalog/v1.artifact` serves them. */
  readonly artifacts: ReadonlyMap<string, string>;
}

export const fixtureDistribution = (input: {
  readonly bundles: readonly FixtureBundle[];
  readonly core: string;
  readonly enabled?: readonly string[];
  readonly generation?: number;
  readonly hostBoot?: string;
  readonly hostId?: string;
}): FixtureDistribution => {
  const artifacts = new Map<string, string>();
  const bundles: DistributionBundle[] = input.bundles.map((bundle) => {
    const version = bundle.version ?? '1.0.0';
    const provides = bundle.provides ?? [];
    const manifest = {
      manifestVersion: 1 as const,
      id: bundle.id,
      version,
      engines: { doric: bundle.engines ?? '^1.0.0' },
      provides: [...new Set(provides.map((contract) => contract.id))].map(
        (id) => `${id}@1.0.0`,
      ),
      requires: [...(bundle.requires ?? [])],
    };
    const descriptor = {
      descriptorVersion: 1,
      bundle: { id: bundle.id, version },
      contracts: provides.map((contract) => ({
        id: contract.id,
        version: '1.0.0',
        kind: contract.kind ?? 'service',
        environment: contract.environment,
        cardinality: 'one',
        local: contract.local ?? false,
        schema: schemaPath(contract.id),
      })),
    };
    const files: Record<string, string> = {
      'manifest.json': JSON.stringify(manifest),
      'contracts.json': JSON.stringify(descriptor),
      ...Object.fromEntries(
        provides
          .filter((contract) => contract.document !== undefined)
          .map((contract) => [
            schemaPath(contract.id),
            JSON.stringify(contract.document),
          ]),
      ),
      ...(bundle.files ?? {}),
    };

    for (const content of Object.values(files)) {
      artifacts.set(sha256(content), content);
    }

    const has = (path: string) => Object.hasOwn(files, path);

    return {
      id: bundle.id,
      version,
      state: bundle.state ?? 'active',
      reasons: [...(bundle.reasons ?? [])],
      manifest,
      descriptor: descriptor as unknown as DistributionBundle['descriptor'],
      files: Object.entries(files)
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([path, content]) => ({
          path,
          sha256: sha256(content),
          size: Buffer.byteLength(content),
        })),
      parts: {
        ...(has('desktop/index.js') ? { desktopMain: 'desktop/index.js' } : {}),
        ...(has('client/index.js') ? { client: 'client/index.js' } : {}),
        ...(has('client/styles.css') ? { clientStyles: 'client/styles.css' } : {}),
        ...(has('contracts/index.js') ? { contracts: 'contracts/index.js' } : {}),
      },
    } satisfies DistributionBundle;
  });
  const composition = {
    core: input.core,
    enabled: [...(input.enabled ?? input.bundles.map((bundle) => bundle.id))],
    providers: {},
  };
  const generation = input.generation ?? 1;
  const catalog: DistributionCatalog = {
    generation,
    hostBoot: input.hostBoot ?? 'boot-1',
    platformVersion: '1.0.0',
    composition,
    storage: {
      hostId: input.hostId ?? '6f1c1c43-55a5-4c3e-9d0a-1f7d3cb7a6d1',
      storageGeneration: 1,
    },
    host: {
      generation,
      composition,
      bundles: bundles.map((bundle, index) => ({
        id: bundle.id,
        version: bundle.version,
        state: bundle.state,
        ...(input.bundles[index]?.phase === undefined
          ? {}
          : { phase: input.bundles[index]?.phase }),
        ...(bundle.manifest === undefined ? {} : { manifest: bundle.manifest }),
        reasons: [...bundle.reasons],
      })),
      order: bundles.map((bundle) => bundle.id),
      contracts: input.bundles.flatMap((bundle) =>
        (bundle.provides ?? [])
          .filter((contract) => contract.environment === 'host')
          .map((contract) => ({
            id: contract.id,
            environment: 'host' as const,
            cardinality: 'one' as const,
            providers: [
              {
                bundleId: bundle.id,
                version: '1.0.0',
                bundleVersion: bundle.version ?? '1.0.0',
              },
            ],
          })),
      ),
    },
    bundles,
  };

  return { catalog, artifacts };
};
