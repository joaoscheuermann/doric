import { ipcMain, Notification } from 'electron';

import { senderIsAllowed } from './workspace/validation';

/**
 * The longest line a notification may carry. The OS truncates a longer one on
 * its own terms; this bound is what keeps one Thread's answer from deciding how
 * much of the sentence naming the outcome is drawn.
 */
const NOTIFICATION_LINE_LIMIT = 200;

/** One trimmed, bounded line the OS may draw, or `''` when nothing was named. */
const line = (value: unknown): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  return Array.from(text).slice(0, NOTIFICATION_LINE_LIMIT).join('');
};

/**
 * Registers the renderer's one native-notification operation. Like every other
 * handler the main process owns, it answers only a renderer at one of the
 * expected URLs, and it bounds both lines before they reach the OS.
 *
 * A platform that cannot show notifications is answered by silence: the prompt
 * completion a notification names is already durable in the Thread's own log, so
 * dropping the courtesy never hides what happened — and that is why this is an
 * operation with nothing to answer, rather than a read that could fail.
 */
export const registerNotificationHandler = (
  allowedUrls: readonly string[],
): void => {
  ipcMain.handle('doric:notifications:show', (event, value: unknown) => {
    if (!senderIsAllowed(event.senderFrame?.url, allowedUrls)) {
      throw new Error('The request source is not allowed.');
    }
    const request =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)
        : {};
    const title = line(request.title);
    if (title.length === 0 || !Notification.isSupported()) return;
    const notification = new Notification({ title, body: line(request.body) });
    // A notice that never appears is worth one line. On macOS the UNNotification
    // API refuses a binary that is not code-signed and reports it here instead of
    // throwing, so an unsigned development build shows nothing at all without
    // this listener. The completion stays in the Thread's log either way.
    notification.on('failed', (_event, error: unknown) => {
      console.error(`Doric: notification failed: ${String(error)}`);
    });
    notification.show();
  });
};
