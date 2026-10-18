// What a `screen.sessions/v2` answer means for one view, and what the view's
// window should do about it. Pure: the desktop part's store owns the state and
// the clock, these functions only decide.

import type { ScreenAttach, ScreenViewStatus } from '../contracts/index.js';

/**
 * The status a view shows after one attach answer (`null` when the answer
 * never arrived — the window could not reach the host, which is a retryable
 * failure). `pending` waits, `ready` may open a window, `unavailable` carries
 * its reason.
 */
export const statusOf = (answer: ScreenAttach | null): ScreenViewStatus => {
  if (answer === null) {
    return { kind: 'failed' };
  }

  switch (answer.status) {
    case 'ready':
      return { kind: 'ready', path: answer.path, display: answer.display };
    case 'pending':
      return { kind: 'waiting' };
    case 'unavailable':
      return { kind: 'unavailable', reason: answer.reason };
  }
};

/**
 * Whether the row's retry control can help. A waiting view is already being
 * retried by the heal loop, and an image without xpra never gains one.
 */
export const canRetry = (status: ScreenViewStatus): boolean => {
  switch (status.kind) {
    case 'waiting':
      return false;
    case 'ready':
      return false;
    case 'failed':
      return true;
    case 'unavailable':
      return status.reason !== 'missing-xpra';
  }
};

/** How long a view waits before the next attach; `undefined` never retries. */
export const retryDelayMs = (
  status: ScreenViewStatus,
  windowOpen: boolean,
): number | undefined => {
  switch (status.kind) {
    case 'waiting':
    case 'failed':
      return WAITING_RETRY_MS;
    case 'unavailable':
      return status.reason === 'missing-xpra' ? undefined : WAITING_RETRY_MS;
    case 'ready':
      // A screen that is up is still re-asked: the window's page carries the
      // relay the host answered with, so a host generation that restarted
      // moved it. Only a view whose window is open is worth the traffic.
      return windowOpen ? LIVE_RETRY_MS : undefined;
  }
};

/** The pending retry the old panel used while a sandbox came up. */
export const WAITING_RETRY_MS = 2_000;

/** The live re-attach the old panel used for a screen that was up. */
export const LIVE_RETRY_MS = 15_000;

/** How often the desktop part looks at its views. */
export const TICK_MS = 1_000;

/** What a view's window should do now. */
export type WindowAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'open'; readonly path: string }
  | { readonly kind: 'focus' }
  | { readonly kind: 'navigate'; readonly path: string };

export interface WindowDecisionInput {
  readonly status: ScreenViewStatus;
  /** The path the window was opened (or last navigated) with. */
  readonly openedPath?: string;
  /** Whether the reader asked for this window. */
  readonly wanted: boolean;
  /** Whether the reader asked again, which focuses an open window. */
  readonly focus: boolean;
}

/**
 * The window decision for one view:
 *
 * - a view that is not ready has no window to open;
 * - a ready view whose window was opened with another path is navigated, which
 *   is the healing that keeps a window off a screen that moved;
 * - a ready view with no window yet is opened when the reader asked for it;
 * - a ready view whose window already shows this path is focused when the
 *   reader asked again, and left alone otherwise.
 */
export const windowActionFor = (input: WindowDecisionInput): WindowAction => {
  if (input.status.kind !== 'ready') {
    return { kind: 'none' };
  }

  const { path } = input.status;

  if (input.openedPath === undefined) {
    return input.wanted ? { kind: 'open', path } : { kind: 'none' };
  }

  if (input.openedPath !== path) {
    return { kind: 'navigate', path };
  }

  return input.focus ? { kind: 'focus' } : { kind: 'none' };
};

/** The label a view carries: the Project's name, or its id when unnamed. */
export const labelOf = (input: {
  readonly label?: string;
  readonly projectId: string;
}): string => input.label ?? input.projectId;
