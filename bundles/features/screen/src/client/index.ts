// The screen bundle's client part: the header's "New screen" button and the
// floating panel of the selected Thread's Project, both over
// `screen.sessions/v1`. All state lives in the activation's store (D9-17), so
// a route change keeps the panel and its iframe.

import {
  type Cleanup,
  type ClientContext,
  type Disposable,
  type RegionItem,
  type Regions,
  RegionsV1,
  UiV1,
} from 'bundle/contracts';

import { ScreenSessionsV1 } from '../contracts/index.js';
import { createScreenApi } from './api.js';
import {
  defineScreenElements,
  SCREEN_NEW_BUTTON_TAG,
  SCREEN_PANEL_TAG,
} from './elements.js';
import { createScreenStore } from './store.js';

/** The region items of the header's new-screen button and the panel. */
export const screenRegions: readonly {
  readonly region: string;
  readonly item: RegionItem;
}[] = [
  {
    region: 'layout.header',
    item: { id: 'screen-new', tag: SCREEN_NEW_BUTTON_TAG, order: 20 },
  },
  {
    region: 'layout.overlay',
    item: { id: 'screen-panel', tag: SCREEN_PANEL_TAG, order: 10 },
  },
];

/** Adds the header button and the floating panel to the layout's regions. */
export const registerScreenSurfaces = (
  regions: Pick<Regions, 'add'>,
): Disposable => {
  const added = screenRegions.map(({ region, item }) =>
    regions.add(region, item),
  );

  return {
    dispose: () => {
      for (const item of added.reverse()) item.dispose();
    },
  };
};

export function activate({ services }: ClientContext): Cleanup {
  // The call is Project-scoped: `attach` runs on that Project's runtime
  // lease, which resolves from `call.scope.projectId` — the scope key the
  // provider's manifest declares for this contract.
  const sessions = (projectId: string) =>
    services.use(ScreenSessionsV1, { projectId });
  const api = createScreenApi(sessions);
  const store = createScreenStore({
    attach: (projectId) => api.attach(projectId),
  });

  const ui = services.use(UiV1);
  const elements = defineScreenElements({ api, store });
  const defined = [
    ui.define(SCREEN_NEW_BUTTON_TAG, elements.newButton),
    ui.define(SCREEN_PANEL_TAG, elements.panel),
  ];
  const surfaces = registerScreenSurfaces(services.use(RegionsV1));

  return () => {
    surfaces.dispose();
    for (const element of defined.reverse()) element.dispose();
    store.dispose();
  };
}
