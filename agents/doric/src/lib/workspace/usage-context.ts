import type { Generation } from '../config/generation.js';
import type { ThreadUsage } from './usage.js';

/** Fill missing capacity from the measured model, without rewriting its history. */
export const withContextCapacity = async (
  usage: ThreadUsage,
  generation: Generation,
): Promise<ThreadUsage> => {
  const context = usage.context;
  if (context === undefined || context.contextWindow !== undefined)
    return usage;
  const candidates = generation.snapshot.configuration.providers.filter(
    (provider) =>
      provider.kind === 'unified' &&
      (context.providerId === undefined
        ? provider.models?.some((model) => model.name === context.model)
        : provider.id === context.providerId),
  );
  if (candidates.length !== 1) return usage;
  const provider = generation.providers.get(candidates[0].id);
  if (provider === undefined) return usage;
  try {
    const model = (await provider.models()).find(
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
