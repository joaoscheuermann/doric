import type { CatalogModel, ProviderValuesRef } from '@/domain/config';
import { messageFrom } from '@/domain/workspace';
import { queryKeys } from '@/queries/keys';
import { useQuery } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';

/**
 * One provider draft's model catalog, as the host read it: the models the
 * endpoint listed, whether a read is in flight, and the last failure.
 */
export type ProviderCatalog = {
  /** The models the endpoint listed, in the order it listed them. */
  readonly models: readonly CatalogModel[];
  readonly loading: boolean;
  /** The last failure, which a picker shows in place of the list. */
  readonly error?: string;
  /** Reads again, for the values the draft holds now. */
  readonly reload: () => void;
};

/**
 * Reads the models one provider's catalog lists, once the picker that shows the
 * mounts and again whenever it asks. A catalog belongs to a connection that is
 * still being typed, so nothing here reads while the fields change: the read
 * happens when the operator opens the picker, and a reload is theirs to ask for
 *.
 *
 * The values are read through a reference, so a draft that changes — the name
 * being typed, a model being chosen — never re-reads the endpoint on its own.
 */
export const useProviderCatalog = (
  values: ProviderValuesRef,
): ProviderCatalog => {
  const latest = useRef(values);
  latest.current = values;
  // Each picker reads its own catalog, and each read is its own entry: a reload
  // starts over with no models on screen rather than the ones the last read
  // listed.
  const instance = useId();
  const [read, setRead] = useState(0);
  const catalog = useQuery({
    queryKey: queryKeys.providerModels(instance, read),
    queryFn: () => window.doric.providers.models(latest.current),
    gcTime: 0,
  });

  return {
    models: catalog.data ?? [],
    loading: catalog.isPending || catalog.isFetching,
    error: catalog.isError ? messageFrom(catalog.error) : undefined,
    reload: () => setRead((value) => value + 1),
  };
};
