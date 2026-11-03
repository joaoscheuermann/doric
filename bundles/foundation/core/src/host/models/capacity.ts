import type { ProviderCache } from './providers.js';
import type { KindRegistry } from './registry.js';

/*
 * models/v1.contextWindow (stage 10 R-6.3), moved from the runtime's
 * usage-context.ts, and models/v1.inputModalities (1.2.0): both read the
 * live, cached provider's catalog, so a poll never builds a provider or
 * reads a catalog the provider has not cached.
 */

/** One model as a built provider's catalog lists it (llms `Model`). */
interface CatalogModel {
  readonly id: string;
  readonly contextWindow?: number;
  readonly inputModalities?: readonly string[];
}

/** The part of a built provider the catalog reads use (llms `models()`). */
interface ModelCatalogSource {
  models(): Promise<readonly CatalogModel[]>;
}

interface CatalogModelRequest {
  readonly providerId?: string;
  readonly model: string;
}

/**
 * The model's entry in the catalog of exactly one candidate provider: the
 * configured providers whose kind reports `catalogCapacity()` and that are
 * `providerId`, or, without one, list the model. `undefined` otherwise; never
 * throws.
 */
const catalogModel = async (
  registry: KindRegistry,
  cache: ProviderCache,
  request: CatalogModelRequest,
): Promise<CatalogModel | undefined> => {
  try {
    const entries = await registry.entries();
    const capacityKinds = new Set(
      entries
        .filter((entry) => entry.catalogCapacity)
        .map(({ kind }) => kind.id),
    );
    const candidates = cache
      .configured()
      .filter(
        (provider) =>
          capacityKinds.has(provider.kind) &&
          (request.providerId === undefined
            ? provider.models?.includes(request.model) === true
            : provider.id === request.providerId),
      );

    if (candidates.length !== 1) return undefined;

    const source = (await cache.resolve(
      candidates[0].id,
    )) as unknown as ModelCatalogSource;
    return (await source.models()).find(({ id }) => id === request.model);
  } catch {
    return undefined;
  }
};

/**
 * A finite capacity above 0 for exactly one candidate provider, else
 * `undefined`. Never throws.
 */
export const contextWindow = async (
  registry: KindRegistry,
  cache: ProviderCache,
  request: CatalogModelRequest,
): Promise<number | undefined> => {
  const capacity = (await catalogModel(registry, cache, request))
    ?.contextWindow;

  return capacity !== undefined && Number.isFinite(capacity) && capacity > 0
    ? capacity
    : undefined;
};

/**
 * What the model reads, as the catalog of exactly one candidate provider
 * lists it, else `undefined`. Never throws.
 */
export const inputModalities = async (
  registry: KindRegistry,
  cache: ProviderCache,
  request: CatalogModelRequest,
): Promise<readonly string[] | undefined> => {
  const listed = (await catalogModel(registry, cache, request))
    ?.inputModalities;

  return Array.isArray(listed)
    ? listed.filter((value): value is string => typeof value === 'string')
    : undefined;
};
