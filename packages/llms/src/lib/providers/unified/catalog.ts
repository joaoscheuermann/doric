import type { Model } from '../../types/provider.js';
import { arrayField, asRecord } from '../../utils/json.js';

export interface OpenRouterModelSupport {
  readonly known: boolean;
  readonly parameters: ReadonlySet<string>;
  readonly contextWindow?: number;
}

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
  retryMs = 30_000,
) => {
  let cached: readonly Model[] | undefined;
  let expiresAt = 0;
  let retryAt = 0;
  let lastError: unknown;
  let pending: Promise<readonly Model[]> | undefined;

  const refresh = () => {
    // Shared work belongs to the catalog, not to any individual caller.
    pending ??= load(AbortSignal.timeout(5000))
      .then((models) => {
        cached = models;
        expiresAt = Date.now() + ttlMs;
        retryAt = 0;
        return models;
      })
      .catch((error: unknown) => {
        retryAt = Date.now() + retryMs;
        lastError = error;
        if (cached !== undefined) return cached;
        throw error;
      })
      .finally(() => {
        pending = undefined;
      });

    return pending;
  };

  const models = async (signal?: AbortSignal): Promise<readonly Model[]> => {
    signal?.throwIfAborted();
    if (Date.now() < Math.max(expiresAt, retryAt)) {
      if (cached !== undefined) return cached;
      throw lastError;
    }
    return waitForRefresh(refresh(), signal);
  };

  const resolve = async (
    model: string,
    signal?: AbortSignal,
  ): Promise<OpenRouterModelSupport> => {
    signal?.throwIfAborted();

    try {
      const support = toSupportMap(await models(signal));
      return support.get(model) ?? missingModelSupport;
    } catch {
      signal?.throwIfAborted();
      return cached === undefined
        ? emptySupport
        : (toSupportMap(cached).get(model) ?? missingModelSupport);
    }
  };
  return Object.assign(resolve, { models });
};

const waitForRefresh = async <T>(
  refresh: Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  if (signal === undefined) return refresh;

  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    // AbortSignal permits any reason; preserve the caller's cancellation identity.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
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

      return [
        model.id,
        { known: true, parameters, contextWindow: model.contextWindow },
      ] as const;
    }),
  );
