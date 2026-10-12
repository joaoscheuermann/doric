// The usage bundle's client part (stage 10, §3.11): `<usage-summary>`, the
// footer's context and cost of the selected Thread, read from `usage/v1`.
//
// The footer region item (`usageRegion`, id `usage`, order 30 in
// `layout.footer`) is registered by the activation since WP-10N removed the
// layout's provisional `layout-thread-usage` item from the same slot.

import { QueryClient } from '@tanstack/react-query';
import {
  type Cleanup,
  type ClientContext,
  type Disposable,
  type RegionItem,
  type Regions,
  RegionsV1,
  UiV1,
} from 'bundle/contracts';

import { defineUsageElements } from './elements.js';

export const USAGE_SUMMARY_TAG = 'usage-summary';

/** The footer item: the stage-9 slot of `layout-thread-usage`. */
export const usageRegion: {
  readonly region: string;
  readonly item: RegionItem;
} = {
  region: 'layout.footer',
  item: { id: 'usage', tag: USAGE_SUMMARY_TAG, order: 30 },
};

/** Adds the usage summary to the layout's footer (WP-10N). */
export const registerUsageRegion = (
  regions: Pick<Regions, 'add'>,
): Disposable => regions.add(usageRegion.region, usageRegion.item);

export function activate({ services }: ClientContext): Cleanup {
  // The layout's query defaults, which the provisional footer ran under; the
  // usage query sets its own polling, focus refetch and retries.
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        staleTime: 0,
      },
    },
  });
  const elements = defineUsageElements(client);
  const defined = services
    .use(UiV1)
    .define(USAGE_SUMMARY_TAG, elements.summary);
  const region = registerUsageRegion(services.use(RegionsV1));

  return () => {
    region.dispose();
    defined.dispose();
    client.clear();
  };
}
