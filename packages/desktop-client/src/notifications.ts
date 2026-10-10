// The client form of `doric.notifications/v1` (stage 9, D9-6, transitional):
// the window forwards each request to main with `doric.shell/v1.notify`,
// where the one native notification function bounds and shows it.

import {
  DoricNotificationsV1,
  defineMethod,
  type NotificationRequest,
} from 'bundle/contracts';
import {
  definePlatformService,
  type Principal,
  platformContracts,
} from 'bundle/runtime';

import { shellCall } from './bridge.js';
import type { DoricDesktopApi } from './protocol.js';

/** Registers the client `doric.notifications/v1` under the window platform. */
export const provideNotifications = (
  platform: Principal,
  desktop: DoricDesktopApi,
): void => {
  const { show } = platformContracts['doric.notifications/v1'].methods;

  platform.services.provide(
    definePlatformService(DoricNotificationsV1, {
      show: defineMethod({
        input: show.input,
        output: show.output,
        execute: async (request: NotificationRequest) => {
          await shellCall(desktop, 'notify', {
            title: request.title,
            body: request.body,
          });
        },
      }),
    }),
  );
};
