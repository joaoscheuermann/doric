// The window's side of the dial: the desktop part asks for a fresh attach and
// the window is the one that can make it, because only a window has a bridge to
// the host. The answer travels back through `deliver`; the sequence it carries
// is what tells a stale answer from the current one.

import type {
  ScreenAttach,
  ScreenAttachReport,
  ScreenAttachRequest,
} from '../contracts/index.js';

export interface ScreenDialerOptions {
  /** The host call, resolved for the Project's scope. */
  readonly attach: (projectId: string) => Promise<ScreenAttach | null>;
  /** Hands the answer to the desktop part. */
  readonly deliver: (report: ScreenAttachReport) => Promise<void>;
}

export interface ScreenDialer {
  /**
   * Dials one request and reports its answer. A call that fails is reported as
   * "no answer" rather than thrown: the desktop part turns it into a status,
   * and a dial is never allowed to break the loop that asked for it.
   */
  dial(request: ScreenAttachRequest): Promise<void>;
}

export const createScreenDialer = (
  options: ScreenDialerOptions,
): ScreenDialer => ({
  dial: async (request) => {
    const answer = await options.attach(request.projectId).catch(() => null);

    await options
      .deliver({ viewId: request.viewId, seq: request.seq, answer })
      .catch(() => undefined);
  },
});
