// The screen client's hooks: a contract's API while a provider serves it,
// and a snapshot subscription (the terminal bundle's own copies, kept per
// bundle as the layout keeps its read helpers).

import type {
  AnyServiceRef,
  ApiOf,
  Disposable,
  Services,
} from 'bundle/contracts';
import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * A contract's API while a provider serves it, else undefined: elements
 * render nothing of what they cannot reach instead of failing.
 */
export const useService = <R extends AnyServiceRef>(
  services: Services,
  contract: R,
): ApiOf<R> | undefined => {
  const [api, setApi] = useState<ApiOf<R> | undefined>(undefined);

  useEffect(() => {
    const binding = services.whenAvailable(contract, (next) => {
      setApi(() => next);

      return () => setApi(undefined);
    });

    return () => binding.dispose();
  }, [services, contract]);

  return api;
};

/** A snapshot read through `subscribe(listener): Disposable`, re-read after every notification. */
export const useSubscribed = <T>(
  source:
    | { readonly subscribe: (listener: () => void) => Disposable }
    | undefined,
  read: () => T,
  fallback: T,
): T =>
  useSyncExternalStore(
    (notify) => {
      if (source === undefined) return () => undefined;
      const subscription = source.subscribe(notify);
      return () => subscription.dispose();
    },
    () => (source === undefined ? fallback : read()),
  );
