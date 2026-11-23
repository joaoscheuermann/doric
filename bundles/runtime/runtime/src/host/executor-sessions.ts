// Executor sessions (phase 3, slice S48b): what one `executor/v1` call may
// call back through `executor.session/v1`, bound to the executor's provider
// bundle, then to the first instance that calls back.

import { randomUUID } from 'node:crypto';

import { ContractError } from 'bundle/contracts';
import type { BundleInstance } from 'bundle/host';

import type { PromptSession } from '../contracts/executor.js';
import { instanceKey } from './sessions.js';

/**
 * What one executor call may call back: a run or a compaction hands its whole
 * `PromptSession`; a checkpoint or a rewind only `{history}` (no `record`, so
 * `Record` is refused).
 */
export type SessionCallbacks = Pick<PromptSession, 'history'> &
  Partial<Omit<PromptSession, 'history'>>;

/** One open session; it lives exactly as long as the executor call it was opened for. */
export interface OpenedExecutorSession {
  /** `randomUUID()`, as Thread sessions (S47): unique for the life of the process, sent only to the executor. */
  readonly id: string;
  /**
   * Cancels the session's work (idempotent; a no-op once ended): every `waitCancel` on it, pending or later,
   * resolves `'cancelled'`. The session stays open — callbacks keep working — until `end()`.
   */
  cancel(): void;
  /** Ends it (idempotent): later `get`s answer `unknown_session`; a pending `waitCancel` resolves `'ended'`. */
  end(): void;
}

export interface ExecutorSessions {
  /** Registers `callbacks` for the bundle `provider` (the catalog's provider of `executor/v1`). Never throws. */
  open(provider: string, callbacks: SessionCallbacks): OpenedExecutorSession;
  /**
   * The callbacks of session `id` for `caller`. The first successful `get`
   * binds the session to `caller`'s instance (bundle id, generation,
   * incarnation). Throws `ContractError('unknown_session', 'No executor
   * session <id>.')` (NOT_FOUND) — and binds nothing — when `id` is unknown or
   * ended, when `caller.bundleId` is not the session's provider, and, once
   * bound, when `caller` is another instance. The answer never says which.
   */
  get(id: string, caller: BundleInstance): SessionCallbacks;
  /**
   * How session `id` stops, for `caller`, checked and bound exactly as `get` (same `unknown_session` failure,
   * thrown synchronously before any wait; binds the session at a first use). Resolves `'cancelled'` once
   * `cancel()` was called (at once if it already was), else `'ended'` once the session ended. `signal` aborting
   * rejects with `signal.reason` and changes nothing. Any number of concurrent waits; none keeps the session open.
   */
  waitCancel(
    id: string,
    caller: BundleInstance,
    signal: AbortSignal,
  ): Promise<'cancelled' | 'ended'>;
}

/** A registered session: its provider, the instance it is bound to once called back, and its callbacks. */
interface HeldSession {
  readonly provider: string;
  bound: string | undefined;
  readonly callbacks: SessionCallbacks;
  cancelled: boolean;
  /** The pending `waitCancel`s, settled by `cancel()` or `end()`. */
  readonly waiters: Set<(outcome: 'cancelled' | 'ended') => void>;
}

/** An empty registry. No I/O. */
export const createExecutorSessions = (): ExecutorSessions => {
  const sessions = new Map<string, HeldSession>();
  /** Checks `caller` against session `id` and binds it at a first use (see `get`). */
  const bind = (id: string, caller: BundleInstance): HeldSession => {
    const held = sessions.get(id);
    const key = instanceKey(caller);
    if (
      held === undefined ||
      held.provider !== caller.bundleId ||
      (held.bound !== undefined && held.bound !== key)
    )
      throw new ContractError('unknown_session', `No executor session ${id}.`);
    held.bound = key;
    return held;
  };
  return {
    open: (provider, callbacks) => {
      const id = randomUUID();
      const held: HeldSession = {
        provider,
        bound: undefined,
        callbacks,
        cancelled: false,
        waiters: new Set(),
      };
      sessions.set(id, held);
      const settle = (outcome: 'cancelled' | 'ended') => {
        for (const waiter of [...held.waiters]) waiter(outcome);
        held.waiters.clear();
      };
      return {
        id,
        cancel: () => {
          if (held.cancelled || sessions.get(id) !== held) return;
          held.cancelled = true;
          settle('cancelled');
        },
        end: () => {
          if (sessions.get(id) !== held) return;
          sessions.delete(id);
          settle('ended');
        },
      };
    },
    get: (id, caller) => bind(id, caller).callbacks,
    waitCancel: (id, caller, signal) => {
      const held = bind(id, caller);
      if (held.cancelled) return Promise.resolve('cancelled');
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const onAbort = () => {
          held.waiters.delete(waiter);
          reject(signal.reason);
        };
        const waiter = (outcome: 'cancelled' | 'ended') => {
          signal.removeEventListener('abort', onAbort);
          resolve(outcome);
        };
        held.waiters.add(waiter);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
};
