// The window's screen call over Connect: `attach` ensures the Project's
// session and answers where the window embeds it.
//
// Nothing here throws at the caller but an invalid identifier: a lost bridge, a
// failed request and an answer that is not a status all read as "no answer",
// which the desktop part shows as a retryable failure.
//
// Slice S65d: the host is `SessionsService`'s generated client over Connect,
// its answer read back with today's `screenAttachSchema`.

import type { Client } from '@connectrpc/connect';
import { decode } from 'runtime/contracts';

import {
  AttachResponseSchema,
  type SessionsService,
} from '../contracts/gen/doric/screen/sessions/v2/sessions_pb.js';
import { type ScreenAttach, screenAttachSchema } from '../contracts/index.js';

export const screenApiMessages = {
  /** The identifier a Project id must be before it reaches the host. */
  invalidIdentifier: 'The item identifier is invalid.',
} as const;

export interface ScreenApi {
  /** The host's answer for a Project, or `null` when it could not be reached. */
  attach(projectId: string): Promise<ScreenAttach | null>;
}

/** The generated client bound to the scope of the Project a view watches. */
export type ScreenHost = (
  projectId: string,
) => Pick<Client<typeof SessionsService>, 'attach'>;

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
      const answer = await sessions(id).attach({ projectId: id });
      const parsed = screenAttachSchema.safeParse(
        decode(AttachResponseSchema, answer),
      );

      return parsed.success ? parsed.data : null;
    } catch {
      // A lost bridge, an unreachable host or a failed request: one state, and
      // one the reader can retry.
      return null;
    }
  },
});
