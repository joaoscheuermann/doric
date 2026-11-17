import { useQuery } from '@tanstack/react-query';
import type { ErrorInfo } from 'desktop/reads';

import { api } from '../api/settings-api.js';
import type { ToolCatalogEntry } from '../domain/config.js';
import { queryKeys } from '../queries/keys.js';
import { useReadFailure } from './use-read-failure.js';

/**
 * The tool catalog the host declares, and how its read is going. The catalog is
 * one read of a host capability: it names the tools the loaded bundles expose and
 * the configuration fields each one declares, so the settings surface draws the
 * tools it actually has rather than a list it already knows.
 */
export type ToolCatalog = {
  /** The declared tools, in the order the host lists them. */
  readonly list: readonly ToolCatalogEntry[];
  /** True while a read runs, the first one or a `reload`. */
  readonly loading: boolean;
  /**
   * The last read's failure (`errorInfo` of the query's error, `at` from its
   * `errorUpdatedAt`); absent once a read succeeds. The Tools section shows it
   * as a notice with `tools_read_failed` as fallback code (§5.2).
   */
  readonly error?: ErrorInfo;
  /**
   * Reads the catalog again (the query's refetch). Returns at once and never
   * throws; the outcome arrives through `list`, `loading` and `error`.
   */
  readonly reload: () => void;
};

/**
 * Reads the host's tool catalog once, when the surface mounts. The catalog
 * outlives every window and changes only with the loaded bundles, so a failed
 * read is the one thing a surface reports, because without it no tool can be
 * drawn.
 */
export const useToolCatalog = (): ToolCatalog => {
  const catalog = useQuery({
    queryKey: queryKeys.toolCatalog,
    queryFn: () => api().tools.catalog(),
    staleTime: Infinity,
  });

  const error = useReadFailure(catalog);

  return {
    list: catalog.data ?? [],
    loading: catalog.isPending || catalog.isFetching,
    error,
    reload: () => {
      void catalog.refetch();
    },
  };
};
