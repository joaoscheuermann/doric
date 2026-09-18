import type { Model } from '../../types/provider.js';
import { arrayField, asRecord } from '../../utils/json.js';

export type OpenRouterModelSupport = {
  readonly known: boolean;
  readonly parameters: ReadonlySet<string>;
};

const emptySupport: OpenRouterModelSupport = {
  known: false,
  parameters: new Set(),
};

const missingModelSupport: OpenRouterModelSupport = {
  known: true,
  parameters: new Set(),
};

export const createOpenRouterCatalog = (
  load: (signal?: AbortSignal) => Promise<readonly Model[]>,
  ttlMs = 15 * 60 * 1000,
) => {
  let cached: ReadonlyMap<string, OpenRouterModelSupport> | undefined;
  let expiresAt = 0;
  let pending: Promise<ReadonlyMap<string, OpenRouterModelSupport>> | undefined;

  const refresh = (signal?: AbortSignal) => {
    pending ??= load(signal)
      .then(toSupportMap)
      .then((support) => {
        cached = support;

        expiresAt = Date.now() + ttlMs;

        return support;
      })
      .finally(() => {
        pending = undefined;
      });

    return pending;
  };

  return async (
    model: string,
    signal?: AbortSignal,
  ): Promise<OpenRouterModelSupport> => {
    if (cached !== undefined && Date.now() < expiresAt) {
      return cached.get(model) ?? missingModelSupport;
    }

    try {
      return (await refresh(signal)).get(model) ?? missingModelSupport;
    } catch (error) {
      if (signal?.aborted === true) {
        throw error;
      }

      return cached === undefined
        ? emptySupport
        : (cached.get(model) ?? missingModelSupport);
    }
  };
};

const toSupportMap = (
  models: readonly Model[],
): ReadonlyMap<string, OpenRouterModelSupport> =>
  new Map(
    models.map((model) => {
      const raw = asRecord(model.raw) ?? {};

      const parameters = new Set(
        arrayField(raw, 'supported_parameters').filter(
          (value): value is string => typeof value === 'string',
        ),
      );

      return [model.id, { known: true, parameters }] as const;
    }),
  );
