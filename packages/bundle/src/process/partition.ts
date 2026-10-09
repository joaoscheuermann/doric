import type { CatalogEntry, ResolvedEnvironment } from '../runtime/catalog.js';

/**
 * Residency (D4-1): foundation, core and every embedded bundle run in the
 * kernel; installed `others` run in the generation process.
 */
export const isKernelResident = (entry: CatalogEntry): boolean =>
  entry.phase === 'foundation' ||
  entry.phase === 'core' ||
  entry.source.kind === 'embedded';

export interface HostPartition {
  /** The resolved catalog with the published order: kernel, then generation (D4-2). */
  readonly published: ResolvedEnvironment;
  readonly kernelOrder: readonly string[];
  readonly generationOrder: readonly string[];
  /** Scheduled generation-resident entries, the ones a generation process activates. */
  readonly generationEntries: readonly CatalogEntry[];
}

/** Splits one resolved host catalog into its kernel and generation partitions. */
export const partitionCatalog = (
  resolved: ResolvedEnvironment,
): HostPartition => {
  const byId = new Map<string, CatalogEntry>();

  for (const entry of resolved.entries) {
    if (entry.state === 'scheduled' && !byId.has(entry.id)) {
      byId.set(entry.id, entry);
    }
  }

  const kernelOrder: string[] = [];
  const generationOrder: string[] = [];

  for (const id of resolved.order) {
    const entry = byId.get(id);

    if (entry === undefined) {
      continue;
    }

    (isKernelResident(entry) ? kernelOrder : generationOrder).push(id);
  }

  return {
    published: Object.freeze({
      ...resolved,
      order: Object.freeze([...kernelOrder, ...generationOrder]),
    }),
    kernelOrder,
    generationOrder,
    generationEntries: generationOrder.map(
      (id) => byId.get(id) as CatalogEntry,
    ),
  };
};

/** The resolved catalog limited to one activation order (its entries stay). */
export const withOrder = (
  resolved: ResolvedEnvironment,
  order: readonly string[],
): ResolvedEnvironment => Object.freeze({ ...resolved, order: [...order] });

/**
 * What a kernel restart would be needed for: the kernel partition (IDs,
 * versions, phases, states, sources) and the providers it publishes.
 */
export const kernelSignature = (resolved: ResolvedEnvironment): string => {
  const kernel = resolved.entries.filter(isKernelResident);
  const ids = new Set(kernel.map(({ id }) => id));

  return JSON.stringify({
    entries: kernel.map((entry) => ({
      id: entry.id,
      version: entry.version,
      phase: entry.phase ?? null,
      state: entry.state,
      source:
        entry.source.kind === 'installed'
          ? `installed:${entry.source.dir}`
          : 'embedded',
    })),
    contracts: resolved.contracts
      .map((contract) => ({
        id: contract.id,
        cardinality: contract.cardinality,
        providers: contract.providers
          .filter(({ bundleId }) => ids.has(bundleId))
          .map(
            ({ bundleId, version, bundleVersion }) =>
              `${bundleId}@${bundleVersion}:${version}`,
          ),
      }))
      .filter(({ providers }) => providers.length > 0),
    recovery: resolved.recovery?.reason ?? null,
  });
};
