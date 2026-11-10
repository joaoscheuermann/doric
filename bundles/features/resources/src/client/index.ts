// The resources bundle's client part (§3.12): the `<resources-monitor>`
// element, bound to the activation services (D9-17). It draws the connection
// badge (UR24) and the resources popover it opens.
//
// The activation registers its `layout.account.status` item (`resourcesRegion`,
// S8), the 14×14 slot over the account avatar.

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

import { defineResourcesElements } from './elements.js';

export const RESOURCES_MONITOR_TAG = 'resources-monitor';

/**
 * Where the connection badge sits: the layout's account status slot
 * (`layout.account.status`, S8), first among its items (`order: 10`). The id
 * stays `resources` and the tag stays `RESOURCES_MONITOR_TAG`. Nothing is
 * registered into `layout.global-footer`, which phase 2 removes (S10).
 */
export const resourcesRegion: {
  readonly region: string;
  readonly item: RegionItem;
} = {
  region: 'layout.account.status',
  item: { id: 'resources', tag: RESOURCES_MONITOR_TAG, order: 10 },
};

/**
 * Adds `resourcesRegion.item` to `resourcesRegion.region` through `regions.add`
 * and returns its handle. Disposing the handle removes the item. It throws only
 * what `regions.add` throws.
 */
export const registerResourcesRegion = (
  regions: Pick<Regions, 'add'>,
): Disposable => regions.add(resourcesRegion.region, resourcesRegion.item);

/**
 * The layout's query client settings: nothing retries or refetches unless a
 * query asks for it, as the monitor's own polling queries do.
 */
const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        staleTime: 0,
      },
      mutations: { retry: false },
    },
  });

export function activate({ services }: ClientContext): Cleanup {
  const client = createQueryClient();
  const elements = defineResourcesElements(client);
  const defined = services
    .use(UiV1)
    .define(RESOURCES_MONITOR_TAG, elements.monitor);
  const region = registerResourcesRegion(services.use(RegionsV1));

  return () => {
    region.dispose();
    defined.dispose();
    client.clear();
  };
}
