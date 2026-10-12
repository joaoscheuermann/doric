import type { ProviderCache } from './providers.js';
import type { KindRegistry } from './registry.js';

/*
 * models/v1.contextWindow (stage 10 R-6.3), moved from the runtime's
 * usage-context.ts: the capacity fill of a Thread's context usage reads the
 * live, cached provider's catalog, so a poll never builds a provider or
 * reads a catalog the provider has not cached.
 */

/** The part of a built provider the capacity read uses (llms `models()`). */
interface ModelCatalogSource {
  models(): Promise<
    readonly { readonly id: string; readonly contextWindow?: number }[]
  >;
}

/**
 * A finite capacity above 0 for exactly one candidate provider, else
 * `undefined`. Never throws.
 */
export const contextWindow = async (
  registry: KindRegistry,
  cache: ProviderCache,
  request: { readonly providerId?: string; readonly model: string },
): Promise<number | undefined> => {
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
    const model = (await source.models()).find(
      ({ id }) => id === request.model,
    );
    const capacity = model?.contextWindow;

    return capacity !== undefined && Number.isFinite(capacity) && capacity > 0
      ? capacity
      : undefined;
  } catch {
    return undefined;
  }
};
