import { ipcMain, Notification } from 'electron';

import {
  type NotificationApi,
  showNotification,
} from './platform/native/notifications';
import { senderIsAllowed } from './workspace/validation';

/** Electron's notifications behind the platform's one notification function. */
export const electronNotifications: NotificationApi = {
  isSupported: () => Notification.isSupported(),
  create: (options) => new Notification(options),
};

/**
 * Registers the renderer's one native-notification operation, the legacy
 * channel until the `notifications` bundle decides when to notify. Like every
 * other handler the main process owns, it answers only a shell page of
 * `doric://app`; the payload is coerced as before (a non-object is `{}`) and
 * shown by the same function as `doric.notifications/v1`.
 *
 * A platform that cannot show notifications is answered by silence: the prompt
 * completion a notification names is already durable in the Thread's own log, so
 * dropping the courtesy never hides what happened — and that is why this is an
 * operation with nothing to answer, rather than a read that could fail.
 */
export const registerLegacyNotificationHandler = (
  log?: (message: string) => void,
): void => {
  ipcMain.handle('doric:notifications:show', (event, value: unknown) => {
    if (!senderIsAllowed(event.senderFrame?.url)) {
      throw new Error('The request source is not allowed.');
    }
    const request =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)
        : {};
    showNotification(request, {
      api: electronNotifications,
      ...(log === undefined ? {} : { log }),
    });
  });
};
