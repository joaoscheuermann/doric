// The screen bundle's client part: the sidebar's Screens group, over
// `screen.views/v1`. One item in the `layout.sidebar` region is what makes the
// group appear; the rows it draws come from the desktop part's mirrored views.
//
// This part is also the app's only route to the host: it subscribes to the
// dials the desktop part asks for, calls `screen.sessions/v2.attach` for the
// Project in scope and hands the answer back, which is how a view gets opened
// and how a window left on a screen that moved is re-pointed.

import {
  type Cleanup,
  type ClientContext,
  type Disposable,
  RegionsV1,
  UiV1,
} from 'bundle/contracts';

import { ScreenSessionsV2, ScreenViewsV1 } from '../contracts/index.js';
import { createScreenApi } from './api.js';
import { createScreenDialer } from './dial.js';
import { defineScreenElements, SCREEN_SIDEBAR_TAG } from './elements.js';
import { createScreenViewsStore } from './store.js';

/** The one region item of the Screens group, under the Threads tree. */
export const screenSidebarItem = {
  id: 'screen-sidebar',
  tag: SCREEN_SIDEBAR_TAG,
  order: 10,
} as const;

export function activate({ services }: ClientContext): Cleanup {
  const store = createScreenViewsStore();
  const ui = services.use(UiV1);
  const element = ui.define(
    SCREEN_SIDEBAR_TAG,
    defineScreenElements({ store }).sidebar,
  );
  const item = services.use(RegionsV1).add('layout.sidebar', screenSidebarItem);

  // The desktop part may not be active yet (or at all, in a composition
  // without it), so the binding is taken whenever it appears.
  const binding: Disposable = services.whenAvailable(
    ScreenViewsV1,
    (screens) => {
      const dialer = createScreenDialer({
        attach: createScreenApi((projectId) =>
          services.use(ScreenSessionsV2, { projectId }),
        ).attach,
        deliver: (report) => screens.deliver(report),
      });
      // The cursor starts at 0: this window holds none of the state yet, so the
      // first push is always the current one.
      const watching = screens.watch(0, (state) => {
        store.set(state.views);

        for (const request of state.dials) {
          void dialer.dial(request).catch(() => undefined);
        }
      });

      return () => {
        watching.dispose();
        store.reset();
      };
    },
  );

  return () => {
    binding.dispose();
    item.dispose();
    element.dispose();
    store.reset();
  };
}
