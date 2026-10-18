// Public contract of the `notifications` bundle (stage 10, §3.13): what the
// window observed about one live Thread event, handed to desktopMain, where
// the decision to show a native notice is made.

import { type CallArg, ref } from 'bundle/contracts';
import { z } from 'zod';

/** One live Thread event as the host sends it; only `type` and `event` are read. */
export const threadEventSchema = z.looseObject({
  type: z.string(),
  event: z.unknown(),
});

export type ThreadEvent = z.output<typeof threadEventSchema>;

export const promptObservationSchema = z
  .object({
    threadId: z.string(),
    /** The name of the Thread record the chat holds. */
    threadName: z.string(),
    /** The live event, as received. */
    event: threadEventSchema,
    /** `navigation/v1.current()?.params.threadId` at receive time. */
    shownThreadId: z.string().optional(),
    /** `document.hasFocus()` at receive time. */
    windowFocused: z.boolean(),
  })
  .strict();

export type PromptObservation = z.output<typeof promptObservationSchema>;

/**
 * `notifications.observations/v1` (desktopMain): the window reports every
 * live event of a held Thread; desktopMain decides whether it deserves a
 * native notice and shows it through `doric.notifications/v1`. A notice is a
 * courtesy: `report` never fails because one could not be shown.
 */
export interface NotificationObservations {
  report(observation: PromptObservation, call?: CallArg): Promise<void>;
}

export const NotificationObservationsV1 = ref<NotificationObservations>(
  'notifications.observations/v1',
);

export const notificationObservationsMethods = {
  report: {
    input: promptObservationSchema,
    output: z.void(),
    expose: 'desktop',
  },
} as const;
