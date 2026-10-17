import { useQuery } from '@tanstack/react-query';

import { api } from '../api/settings-api.js';
import type { ProviderKind } from '../domain/config.js';
import { messageFrom } from '../domain/errors.js';
import { queryKeys } from '../queries/keys.js';

/**
 * The provider catalog the host declares, and how its read is going. The catalo
g
 * is one read of a host capability: it names the kinds a provider may be, so th
e
 * renderer draws whatever arrives rather than a list of types it already knows.
 */
export type ProviderKinds = {
  /** The declared kinds, in the order the host lists them. */
  readonly list: readonly ProviderKind[];
  readonly loading: boolean;
  /** The last failure, which a section shows above its own controls. */
  readonly error?: string;
};

/**
 * Reads the host's provider catalog once, when the surface mounts. The catalog
 * outlives every window and never changes while the host runs, so there is
 * nothing to reload: a failed read is the one thing a surface reports, because
 * without it no provider can be drawn.
 */
/**
 * The list until the catalog arrives, one value for every render: the autosave
 * and its flush depend on the list, and a fresh empty one each render would
 * restart the autosave's settle timer on renders that changed nothing.
 */
const noKinds: readonly ProviderKind[] = [];

export const useProviderKinds = (): ProviderKinds => {
  const kinds = useQuery({
    queryKey: queryKeys.providerKinds,
    queryFn: () => api().providers.kinds(),
    staleTime: Infinity,
  });

  return {
    list: kinds.data ?? noKinds,
    loading: kinds.isPending || kinds.isFetching,
    error: kinds.isError ? messageFrom(kinds.error) : undefined,
  };
};
