import { type CallArg, ref } from 'bundle/contracts';
import { z } from 'zod';

/*
 * screen.sessions/v1: the HTML5 screen of a Project's sandbox — an xpra
 * server on an internal display, served to the desktop's floating panel
 * through a loopback relay the `screen` bundle owns.
 *
 * The call is Project-scoped: every Thread of a Project shares the Project's
 * one sandbox, and therefore its one screen. `attach` is an idempotent
 * ensure: it starts the session when the sandbox has none, reuses a live one,
 * and answers where the panel may reach it. It never acquires a lease, so a
 * Project whose sandbox is not up answers `pending` or `unavailable` the way
 * the other lease reads do.
 */

/** Why a Project's screen cannot be served right now. */
export type ScreenUnavailableReason = 'sandbox' | 'missing-xpra' | 'start-failed';

/**
 * The answer of `attach`:
 *
 * - `ready`: the relay `url` the panel embeds, and the X display the session
 *   runs on (`:100` and up), so a reader can point a GUI app at it.
 * - `pending`: the Project has no sandbox lease yet; retry.
 * - `unavailable`: the sandbox is gone or closing, its image has no `xpra`,
 *   or the session could not be started.
 */
export type ScreenAttach =
  | {
      readonly status: 'ready';
      readonly url: string;
      readonly display: string;
    }
  | { readonly status: 'pending' }
  | {
      readonly status: 'unavailable';
      readonly reason: ScreenUnavailableReason;
    };

export const screenUnavailableReasonSchema = z.enum([
  'sandbox',
  'missing-xpra',
  'start-failed',
]);

export const screenAttachSchema: z.ZodType<ScreenAttach, ScreenAttach> =
  z.discriminatedUnion('status', [
    z
      .object({
        status: z.literal('ready'),
        url: z.string(),
        display: z.string(),
      })
      .strict(),
    z.object({ status: z.literal('pending') }).strict(),
    z
      .object({
        status: z.literal('unavailable'),
        reason: screenUnavailableReasonSchema,
      })
      .strict(),
  ]);

export interface ScreenSessions {
  /**
   * Ensures the Project's screen session and answers the loopback URL its
   * panel embeds. Idempotent; safe to call whenever the panel opens or a
   * session is believed lost.
   */
  attach(projectId: string, call?: CallArg): Promise<ScreenAttach>;
}

export const screenSessionsMethods = {
  attach: { input: z.string(), output: screenAttachSchema },
} as const;

/** screen.sessions/v1, as the `screen` bundle provides it. */
export const ScreenSessionsV1 = ref<ScreenSessions>('screen.sessions/v1');
