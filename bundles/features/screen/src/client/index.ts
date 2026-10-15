// The screen bundle's client part: the sidebar's Screens pane, over
// `screen.views/v1`. Registering the pane in the layout's stack (`layout.stack/v1`)
// is what makes the group appear; the rows it draws come from the desktop part's
// mirrored views, and the group's own add control is an element of its own.
//
// This part is also the app's only route to the host: it subscribes to the
// dials the desktop part asks for, calls `screen.sessions/v2.attach` for the
// Project in scope and hands the answer back, which is how a view gets opened
// and how a window left on a screen that moved is re-pointed.

import {
  type Cleanup,
  type ClientContext,
  type Disposable,
  UiV1,
} from 'bundle/contracts';

import { ScreenSessionsV2, ScreenViewsV1 } from '../contracts/index.js';
import { createScreenApi } from './api.js';
import { createScreenDialer } from './dial.js';
import {
  defineScreenElements,
  SCREEN_GROUP_ACTION_TAG,
  SCREEN_SIDEBAR_TAG,
} from './elements.js';
import { LayoutStackV1, type StackPane } from './peers.js';
import { createScreenViewsStore } from './store.js';

/**
 * The sidebar's Screens group: the views of the current Project, below the
 * Threads tree. It starts collapsed, so the sidebar opens with the tree alone,
 * and expands to its minimum size — the layout owns the panel, the header and
 * the collapse control, and never collapses a pane past its header.
 */
export const screenPane: StackPane = {
  id: 'screen-sidebar',
  order: 10,
  title: 'Screens',
  tag: SCREEN_SIDEBAR_TAG,
  headerTag: SCREEN_GROUP_ACTION_TAG,
  collapsible: true,
  initiallyOpen: false,
  minSize: '20%',
  maxSize: '80%',
};

export function activate({ services }: ClientContext): Cleanup {
  const store = createScreenViewsStore();
  const ui = services.use(UiV1);
  const elements = defineScreenElements({ store });
  const element = ui.define(SCREEN_SIDEBAR_TAG, elements.sidebar);
  const actionElement = ui.define(
    SCREEN_GROUP_ACTION_TAG,
    elements.groupAction,
  );

  // The layout may not be active yet (or at all, in a composition without it),
  // so the pane is registered whenever the stack appears.
  const pane: Disposable = services.whenAvailable(LayoutStackV1, (stack) => {
    const registration = stack.register(screenPane);

    return () => registration.dispose();
  });

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
    pane.dispose();
    element.dispose();
    actionElement.dispose();
    store.reset();
  };
}
