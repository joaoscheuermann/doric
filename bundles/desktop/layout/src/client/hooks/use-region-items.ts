import { type RegionEntry, RegionsV1 } from 'bundle/contracts';
import { useCallback, useSyncExternalStore } from 'react';

import { layoutServices } from '../services/layout-services.js';

const none: readonly RegionEntry[] = Object.freeze([]);

/**
 * A region's items as `regions/v1` sorts them, for the surfaces that draw
 * their own frame around each item (the panel's tab strip). The array is the
 * same until the region changes.
 */
export const useRegionItems = (region: string): readonly RegionEntry[] => {
  const subscribe = useCallback(
    (listener: () => void) => {
      const subscription = layoutServices()
        .use(RegionsV1)
        .subscribe(region, listener);
      return () => subscription.dispose();
    },
    [region],
  );
  return useSyncExternalStore(
    subscribe,
    () => layoutServices().use(RegionsV1).items(region),
    () => none,
  );
};
