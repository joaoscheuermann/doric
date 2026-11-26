import type { ConfiguredProvider } from './providers.js';

interface CatalogModelRequest {
  readonly providerId?: string;
  readonly model: string;
}

/**
 * The one configured provider whose kind is in `capacityKinds` and that is
 * `providerId`, or, without one, lists the model; `undefined` unless exactly one.
 */
export const capacityCandidate = <P extends ConfiguredProvider>(
  capacityKinds: ReadonlySet<string>,
  configured: readonly P[],
  request: CatalogModelRequest,
): P | undefined => {
  const candidates = configured.filter(
    (provider) =>
      capacityKinds.has(provider.kind) &&
      (request.providerId === undefined
        ? provider.models?.includes(request.model) === true
        : provider.id === request.providerId),
  );

  return candidates.length === 1 ? candidates[0] : undefined;
};

/** The capacity when finite and above 0, else `undefined`. */
export const positiveCapacity = (
  capacity: number | undefined,
): number | undefined =>
  capacity !== undefined && Number.isFinite(capacity) && capacity > 0
    ? capacity
    : undefined;
