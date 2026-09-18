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

  const refresh = () => {
    // Shared work belongs to the catalog, not to any individual caller.
    pending ??= load()
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
    signal?.throwIfAborted();

    if (cached !== undefined && Date.now() < expiresAt) {
      return cached.get(model) ?? missingModelSupport;
    }

    try {
      const support = await waitForRefresh(refresh(), signal);
      return support.get(model) ?? missingModelSupport;
    } catch {
      signal?.throwIfAborted();
      return cached === undefined
        ? emptySupport
        : (cached.get(model) ?? missingModelSupport);
    }
  };
};

const waitForRefresh = async (
  refresh: Promise<ReadonlyMap<string, OpenRouterModelSupport>>,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, OpenRouterModelSupport>> => {
  if (signal === undefined) return refresh;

  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });

  try {
    return await Promise.race([refresh, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
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
