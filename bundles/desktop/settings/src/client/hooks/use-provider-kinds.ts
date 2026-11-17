import { useQuery } from '@tanstack/react-query';
import type { ErrorInfo } from 'desktop/reads';

import { api } from '../api/settings-api.js';
import type { ProviderKind } from '../domain/config.js';
import { queryKeys } from '../queries/keys.js';
import { useReadFailure } from './use-read-failure.js';

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
  /** True while a read runs, the first one or a `reload`. */
  readonly loading: boolean;
  /**
   * The last read's failure (`errorInfo` of the query's error, `at` from its
   * `errorUpdatedAt`); absent once a read succeeds. A section shows it as a
   * notice with `kinds_read_failed` as fallback code (§5.2, D16).
   */
  readonly error?: ErrorInfo;
  /**
   * Reads the catalog again (the query's refetch). Returns at once and never
   * throws; the outcome arrives through `list`, `loading` and `error`.
   */
  readonly reload: () => void;
};

/**
 * The list until the catalog arrives, one value for every render: the autosave
 * and its flush depend on the list, and a fresh empty one each render would
 * restart the autosave's settle timer on renders that changed nothing.
 */
const noKinds: readonly ProviderKind[] = [];

/**
 * Reads the host's provider catalog when the surface mounts. The catalog
 * outlives every window and never changes while the host runs, so it is read
 * again only when a surface asks with `reload` after a failed read, which the
 * surface reports because without the catalog no provider can be drawn.
 */
export const useProviderKinds = (): ProviderKinds => {
  const kinds = useQuery({
    queryKey: queryKeys.providerKinds,
    queryFn: () => api().providers.kinds(),
    staleTime: Infinity,
  });

  const error = useReadFailure(kinds);

  return {
    list: kinds.data ?? noKinds,
    loading: kinds.isPending || kinds.isFetching,
    error,
    reload: () => {
      void kinds.refetch();
    },
  };
};
