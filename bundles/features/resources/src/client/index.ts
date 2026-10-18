// The resources bundle's client part (§3.12): the `<resources-monitor>`
// element, bound to the activation services (D9-17).
//
// Its `layout.global-footer` item (`resourcesRegion`) is registered by the
// activation since WP-10N removed the layout's provisional monitor.

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

/** Where the monitor sits today: the window's global footer [D10-13]. */
export const resourcesRegion: {
  readonly region: string;
  readonly item: RegionItem;
} = {
  region: 'layout.global-footer',
  item: { id: 'resources', tag: RESOURCES_MONITOR_TAG, order: 100 },
};

/** Adds the monitor to the layout's global footer (WP-10N). */
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
