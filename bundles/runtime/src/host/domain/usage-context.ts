import type { ConfigurationValue } from '../../contracts/configuration.js';
import type { ThreadUsage } from '../../contracts/model.js';

/*
 * Moved from agents/doric (workspace/usage-context.ts, design 57 §4.3): the
 * provider is the one `models/v1.resolve` answers for the configured
 * provider, an llms provider whose `models()` reads its catalog.
 */

/** The part of an llms provider the capacity fill reads. */
export interface ModelCatalogSource {
  models(): Promise<
    readonly { readonly id: string; readonly contextWindow?: number }[]
  >;
}

/** Fill missing capacity from the measured model, without rewriting its history. */
export const withContextCapacity = async (
  usage: ThreadUsage,
  configuration: ConfigurationValue,
  provider: (providerId: string, model: string) => Promise<ModelCatalogSource>,
): Promise<ThreadUsage> => {
  const context = usage.context;
  if (context === undefined || context.contextWindow !== undefined)
    return usage;
  const candidates = configuration.providers.filter(
    (provider) =>
      provider.kind === 'openrouter' &&
      (context.providerId === undefined
        ? provider.models?.some((model) => model.name === context.model)
        : provider.id === context.providerId),
  );
  if (candidates.length !== 1) return usage;
  try {
    const source = await provider(candidates[0].id, context.model);
    const model = (await source.models()).find(
      (model) => model.id === context.model,
    );
    const capacity = model?.contextWindow;
    return capacity !== undefined && Number.isFinite(capacity) && capacity > 0
      ? {
          ...usage,
          context: {
            ...context,
            contextWindow: capacity,
            contextWindowSource: 'catalog',
          },
        }
      : usage;
  } catch {
    return usage;
  }
};
