// The drawable items of `settings.provider.field`: the region's items whose
// props pass `providerFieldItemProps`. A malformed item is not drawn, and the
// page draws its field itself (O7).

import type { Regions } from 'bundle/contracts';
import { useRegionItems } from 'desktop/ui/element-host';
import { useMemo } from 'react';

import { SETTINGS_PROVIDER_FIELD } from '../../contracts/index.js';
import {
  type ProviderFieldEntry,
  providerFieldEntries,
} from '../domain/provider-fields.js';

/** The drawable items of `settings.provider.field`, in region order. */
export const useProviderFieldEntries = (
  regions: Regions,
): readonly ProviderFieldEntry[] => {
  const items = useRegionItems(regions, SETTINGS_PROVIDER_FIELD);
  return useMemo(() => providerFieldEntries(items), [items]);
};
