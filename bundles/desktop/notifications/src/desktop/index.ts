import {
  type DesktopContext,
  DoricNotificationsV1,
  defineMethod,
  defineService,
} from 'bundle/contracts';

import {
  NotificationObservationsV1,
  notificationObservationsMethods,
  type PromptObservation,
} from '../contracts/index.js';
import { report } from './decide.js';

/**
 * Provides `notifications.observations/v1`: each observation the window
 * reports is decided here and, when it deserves a notice, shown through
 * main's `doric.notifications/v1`.
 */
export const activate = ({ services }: DesktopContext): void => {
  services.provide(
    defineService(NotificationObservationsV1, {
      report: defineMethod({
        expose: notificationObservationsMethods.report.expose,
        input: notificationObservationsMethods.report.input,
        output: notificationObservationsMethods.report.output,
        execute: (observation: PromptObservation, call) =>
          report(observation, (notification) =>
            services.use(DoricNotificationsV1).show(notification, call),
          ),
      }),
    }),
  );
};
