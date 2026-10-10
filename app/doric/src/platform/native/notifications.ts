// The one native notification function (P15, decision 81), behind
// `doric.notifications/v1` and behind the legacy channel.

/**
 * The longest line a notification may carry. The OS truncates a longer one on
 * its own terms; this bound is what keeps one Thread's answer from deciding how
 * much of the sentence naming the outcome is drawn.
 */
export const NOTIFICATION_LINE_LIMIT = 200;

/** One trimmed, bounded line the OS may draw, or `''` when nothing was named. */
export const notificationLine = (value: unknown): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  return Array.from(text).slice(0, NOTIFICATION_LINE_LIMIT).join('');
};

export interface NativeNotification {
  on(event: 'failed', listener: (event: unknown, error: unknown) => void): void;
  show(): void;
}

export interface NotificationApi {
  isSupported(): boolean;
  create(options: { title: string; body: string }): NativeNotification;
}

export interface NotificationDeps {
  readonly api: NotificationApi;
  readonly error?: (line: string) => void;
  /** The platform log also records a failure. */
  readonly log?: (message: string) => void;
}

/**
 * Shows one notification. A platform that cannot show notifications, or an
 * empty title, is answered by silence: the prompt completion a notification
 * names is already durable in the Thread's own log.
 */
export const showNotification = (
  request: { readonly title?: unknown; readonly body?: unknown },
  deps: NotificationDeps,
): void => {
  const title = notificationLine(request.title);
  if (title.length === 0 || !deps.api.isSupported()) return;
  const notification = deps.api.create({
    title,
    body: notificationLine(request.body),
  });
  // A notice that never appears is worth one line. On macOS the UNNotification
  // API refuses a binary that is not code-signed and reports it here instead of
  // throwing, so an unsigned development build shows nothing at all without
  // this listener. The completion stays in the Thread's log either way.
  notification.on('failed', (_event, error: unknown) => {
    (deps.error ?? console.error)(
      `Doric: notification failed: ${String(error)}`,
    );
    deps.log?.(String(error));
  });
  notification.show();
};
