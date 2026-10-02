import type { ProviderKind } from '@/domain/config';
import { messageFrom } from '@/domain/workspace';
import { queryKeys } from '@/queries/keys';
import { useQuery } from '@tanstack/react-query';

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
export const useProviderKinds = (): ProviderKinds => {
  const kinds = useQuery({
    queryKey: queryKeys.providerKinds,
    queryFn: () => window.doric.providers.kinds(),
    staleTime: Infinity,
  });

  return {
    list: kinds.data ?? [],
    loading: kinds.isPending || kinds.isFetching,
    error: kinds.isError ? messageFrom(kinds.error) : undefined,
  };
};
