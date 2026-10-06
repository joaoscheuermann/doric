import { useQuery } from '@tanstack/react-query';

import type { ToolCatalogEntry } from '@/domain/config';
import { messageFrom } from '@/domain/workspace';
import { queryKeys } from '@/queries/keys';

/**
 * The tool catalog the host declares, and how its read is going. The catalog is
 * one read of a host capability: it names the tools the loaded bundles expose and
 * the configuration fields each one declares, so the settings surface draws the
 * tools it actually has rather than a list it already knows.
 */
export type ToolCatalog = {
  /** The declared tools, in the order the host lists them. */
  readonly list: readonly ToolCatalogEntry[];
  readonly loading: boolean;
  /** The last failure, which a section shows above its own controls. */
  readonly error?: string;
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
    queryFn: () => window.doric.tools.catalog(),
    staleTime: Infinity,
  });

  return {
    list: catalog.data ?? [],
    loading: catalog.isPending || catalog.isFetching,
    error: catalog.isError ? messageFrom(catalog.error) : undefined,
  };
};
