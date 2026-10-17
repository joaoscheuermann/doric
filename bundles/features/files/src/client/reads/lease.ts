// The host's lease outcome as the window's read surfaces see it.

import type { ProjectLeaseState } from '../../contracts/reads.js';

/** What a host read under a Project's sandbox lease returns. */
export type LeaseOutcome<Value> =
  | { readonly status: 'ready'; readonly value: Value }
  | { readonly status: ProjectLeaseState };

/**
 * The lease outcome as the surfaces read it: the shape the main-process REST
 * mapping produced, where a pending lease carries the host's retry hint.
 */
export type LeaseAnswer<Value> =
  | { readonly status: 'ready'; readonly value: Value }
  | { readonly status: 'pending'; readonly retryAfterSeconds: number }
  | { readonly status: 'missing' | 'expired' | 'unavailable' };

/**
 * The REST route answered a pending lease with `202` and a fixed
 * `Retry-After: 1`, which is the hint the surfaces read; a host outcome
 * carries no hint, so the same one second is restated here.
 */
const PENDING_RETRY_AFTER_SECONDS = 1;

/** Maps a host lease outcome to the answer the read surfaces explain. */
export const answerOf = <Value>(
  outcome: LeaseOutcome<Value>,
): LeaseAnswer<Value> => {
  switch (outcome.status) {
    case 'ready':
      return { status: 'ready', value: outcome.value };
    case 'pending':
      return {
        status: 'pending',
        retryAfterSeconds: PENDING_RETRY_AFTER_SECONDS,
      };
    case 'missing':
    case 'expired':
    case 'unavailable':
      return { status: outcome.status };
  }
};
