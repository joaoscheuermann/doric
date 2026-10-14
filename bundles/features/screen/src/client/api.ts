// The window's screen call over the client → host bridge: `attach` ensures the
// Project's session and answers where the window embeds it. Each call resolves
// the contract bound to that Project's scope, which is what the host's
// `runtime.lease/v1` reads.
//
// Nothing here throws at the caller but an invalid identifier: a lost bridge, a
// failed request and an answer that is not a status all read as "no answer",
// which the desktop part shows as a retryable failure.

import type { ScreenAttach, ScreenSessions } from '../contracts/index.js';
import { screenAttachSchema } from '../contracts/index.js';

export const screenApiMessages = {
  /** The identifier a Project id must be before it reaches the host. */
  invalidIdentifier: 'The item identifier is invalid.',
} as const;

export interface ScreenApi {
  /** The host's answer for a Project, or `null` when it could not be reached. */
  attach(projectId: string): Promise<ScreenAttach | null>;
}

/** The contract bound to the scope of the Project a view watches. */
export type ScreenHost = (projectId: string) => Pick<ScreenSessions, 'attach'>;

const identifier = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    value.includes('\0')
  ) {
    throw new Error(screenApiMessages.invalidIdentifier);
  }

  return value;
};

export const createScreenApi = (sessions: ScreenHost): ScreenApi => ({
  attach: async (projectId) => {
    const id = identifier(projectId);

    try {
      const answer = await sessions(id).attach(id);
      const parsed = screenAttachSchema.safeParse(answer);

      return parsed.success ? parsed.data : null;
    } catch {
      // A lost bridge, an unreachable host or a failed request: one state, and
      // one the reader can retry.
      return null;
    }
  },
});
