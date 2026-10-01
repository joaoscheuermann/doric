import type { CatalogModel, ProviderValuesRef } from '@/domain/config';
import { messageFrom } from '@/domain/workspace';
import { useEffect, useRef, useState } from 'react';

/**
 * One provider draft's model catalog, as the host read it: the models the
 * endpoint lists, whether a read is in flight, and the last failure.
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
 * Reads the models one provider's catalog lists, once the picker that shows them
 * mounts and again whenever it asks. A catalog belongs to a connection that is
 * still being typed, so nothing here reads while the fields change: the read
 * happens when the operator opens the picker, and a reload is theirs to ask for.
 *
 * The values are read through a reference, so a draft that changes — the name
 * being typed, a model being chosen — never re-reads the endpoint on its own.
 */
export const useProviderCatalog = (
  values: ProviderValuesRef,
): ProviderCatalog => {
  const latest = useRef(values);
  latest.current = values;
  const [state, setState] = useState<{
    readonly models: readonly CatalogModel[];
    readonly loading: boolean;
    readonly error?: string;
  }>({ models: [], loading: true });
  const [read, setRead] = useState(0);

  useEffect(() => {
    let cancelled = false;

    setState({ models: [], loading: true });

    window.doric.providers
      .models(latest.current)
      .then((models) => {
        if (!cancelled) setState({ models, loading: false });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setState({ models: [], loading: false, error: messageFrom(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [read]);

  return {
    ...state,
    reload: () => setRead((value) => value + 1),
  };
};
