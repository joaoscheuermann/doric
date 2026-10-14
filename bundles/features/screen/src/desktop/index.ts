// The bundle's desktopMain part: it provides `screen.views/v1` over the views
// owner, which keeps the reader's views, their status, their windows and the
// loop that re-attaches while a window is open.
//
// The host's `screen.sessions/v2` is reached from the window, never from here:
// a desktopMain generation resolves the providers of its own environment plus
// the kernel's `doric.*` services, so a host bundle contract has no route to
// this process. The owner publishes the dials it wants in the state's `watch`
// stream and maps the answer the window hands back (`deliver`).

import {
  type Call,
  type DesktopContext,
  DoricCacheV1,
  DoricWindowsV1,
  defineMethod,
  defineService,
  type Services,
  type StreamListener,
  toStreamObserver,
} from 'bundle/contracts';

import {
  type ScreenViewsState,
  ScreenViewsV1,
  screenViewsMethods,
} from '../contracts/index.js';
import { createScreenViews, type ScreenViewsEnv } from './views.js';

/** What one call reaches in this generation: the cache and the platform. */
const envOf = (call: Call, services: Services): ScreenViewsEnv => ({
  directory: () => services.use(DoricCacheV1).directory(call),
  windows: services.use(DoricWindowsV1),
});

/** The `screen.views/v1` definition over one views owner. */
export const screenViewsService = (
  views: ReturnType<typeof createScreenViews>,
) =>
  defineService(ScreenViewsV1, {
    list: defineMethod({
      ...screenViewsMethods.list,
      execute: (_input, call: Call, services: Services) =>
        views.list(envOf(call, services)),
    }),
    add: defineMethod({
      ...screenViewsMethods.add,
      execute: (
        input: { readonly projectId: string; readonly label?: string },
        call: Call,
        services: Services,
      ) => views.add(input, envOf(call, services)),
    }),
    remove: defineMethod({
      ...screenViewsMethods.remove,
      execute: (viewId: string, call: Call, services: Services) =>
        views.remove(viewId, envOf(call, services)),
    }),
    open: defineMethod({
      ...screenViewsMethods.open,
      execute: (viewId: string, call: Call, services: Services) =>
        views.open(viewId, envOf(call, services)),
    }),
    retry: defineMethod({
      ...screenViewsMethods.retry,
      execute: (viewId: string, call: Call, services: Services) =>
        views.retry(viewId, envOf(call, services)),
    }),
    deliver: defineMethod({
      ...screenViewsMethods.deliver,
      execute: (
        report: Parameters<typeof views.deliver>[0],
        call: Call,
        services: Services,
      ) => views.deliver(report, envOf(call, services)),
    }),
    watch: defineMethod({
      ...screenViewsMethods.watch,
      execute: (
        [revision, listener]: [number, StreamListener<ScreenViewsState>],
        call: Call,
        services: Services,
      ) => {
        const observer = toStreamObserver(listener);

        return views.watch(
          revision,
          (state) => observer.next(state),
          envOf(call, services),
        );
      },
    }),
  });

/**
 * Provides `screen.views/v1`. The owner is built here but reads its cache only
 * on the first call: this activation is also recorded at build time, where the
 * platform's `doric.*` services answer nothing at all.
 */
export const activate = ({ services }: DesktopContext): (() => void) => {
  const views = createScreenViews();
  const providing = services.provide(screenViewsService(views));

  return () => {
    providing.dispose();
    views.dispose();
  };
};
