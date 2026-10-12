// Which IPC senders main answers (section 14.3 step 1): the main frame of a
// window or of the splash, loaded from `doric://app` [S8-1].

import { isDoricAppUrl } from '../protocol/scheme';

export const SENDER_REFUSED_MESSAGE = 'The request source is not allowed.';

/** Any `doric://app` URL, whatever its path; never `file:` or `http:`. */
export const isShellSender = (frameUrl: string | undefined): boolean =>
  isDoricAppUrl(frameUrl);
