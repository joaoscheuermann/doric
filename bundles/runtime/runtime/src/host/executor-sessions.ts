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
  /** Ends it (idempotent): later `get`s answer `unknown_session`. */
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
}

/** A registered session: its provider, the instance it is bound to once called back, and its callbacks. */
interface HeldSession {
  readonly provider: string;
  bound: string | undefined;
  readonly callbacks: SessionCallbacks;
}

/** An empty registry. No I/O. */
export const createExecutorSessions = (): ExecutorSessions => {
  const sessions = new Map<string, HeldSession>();
  return {
    open: (provider, callbacks) => {
      const id = randomUUID();
      sessions.set(id, { provider, bound: undefined, callbacks });
      return { id, end: () => sessions.delete(id) };
    },
    get: (id, caller) => {
      const held = sessions.get(id);
      const key = instanceKey(caller);
      if (
        held === undefined ||
        held.provider !== caller.bundleId ||
        (held.bound !== undefined && held.bound !== key)
      )
        throw new ContractError(
          'unknown_session',
          `No executor session ${id}.`,
        );
      held.bound = key;
      return held.callbacks;
    },
  };
};
