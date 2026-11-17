import { useQuery } from '@tanstack/react-query';
import { type ErrorInfo, errorInfo } from 'desktop/reads';
import { useId, useMemo, useRef, useState } from 'react';

import { api } from '../api/settings-api.js';
import type { CatalogModel, ProviderValuesRef } from '../domain/config.js';
import { queryKeys } from '../queries/keys.js';

/**
 * One provider draft's model catalog, as the host read it: the models the
 * endpoint listed, whether a read is in flight, and the last failure.
 */
export type ProviderCatalog = {
  /** The models the endpoint listed, in the order it listed them. */
  readonly models: readonly CatalogModel[];
  readonly loading: boolean;
  /**
   * The current read's failure (`errorInfo` of the query's error, `at` from
   * its `errorUpdatedAt`), which a picker shows in place of the list with
   * `catalog_read_failed` as fallback code; absent while a read runs or after
   * one succeeds. A `reload` starts with no error (§5.2).
   */
  readonly error?: ErrorInfo;
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
/** The models until a read lists some, one value the table's memos can keep. */
const noModels: readonly CatalogModel[] = [];

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
    queryFn: () => api().providers.models(latest.current),
    gcTime: 0,
  });

  const failure = catalog.isError ? catalog.error : undefined;
  const failedAt = catalog.errorUpdatedAt;
  const error = useMemo(
    () =>
      failure === undefined
        ? undefined
        : errorInfo(failure, { at: new Date(failedAt).toISOString() }),
    [failure, failedAt],
  );

  return {
    models: catalog.data ?? noModels,
    loading: catalog.isPending || catalog.isFetching,
    error,
    reload: () => setRead((value) => value + 1),
  };
};
