// The window's screen call over the client → host bridge: `attach` ensures
// the Project's session and answers where the panel embeds it. Each call
// resolves the contract bound to that Project's scope, which is what the
// host's `runtime.lease/v1` reads. The old renderer's host calls reported one
// fallback sentence for a lost bridge and another for a failed request; both
// live here.

import { isContractError } from 'bundle/contracts';

import type { ScreenAttach, ScreenSessions } from '../contracts/index.js';

export const screenApiMessages = {
  /** A lost bridge, as for every other host call (stage 8 §14.3). */
  unavailable: 'Doric backend is unavailable.',
  invalidIdentifier: 'The item identifier is invalid.',
  /** Any failed screen request. */
  screenFailed: 'Doric could not complete the screen request.',
} as const;

export interface ScreenApi {
  attach(projectId: string): Promise<ScreenAttach>;
}

/** The contract bound to the scope of the Project the panel shows. */
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
      return await sessions(id).attach(id);
    } catch (error) {
      if (
        isContractError(error) &&
        (error.code === 'unavailable' ||
          error.code === 'disconnected' ||
          error.code === 'generation_lost')
      ) {
        throw new Error(screenApiMessages.unavailable);
      }

      throw new Error(screenApiMessages.screenFailed);
    }
  },
});
