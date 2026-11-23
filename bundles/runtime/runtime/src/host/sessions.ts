// Thread sessions, bound to the instance that opened them (phase 3, slice
// S47a: the registry, empty until S47b's `OpenThread` opens sessions).

import { randomUUID } from 'node:crypto';

import type { HandlerContext } from '@connectrpc/connect';
import { ContractError } from 'bundle/contracts';
import { type BundleInstance, stampedCallerOf } from 'bundle/host';

import type { ThreadContext } from '../contracts/workspace.js';

/** One open session: the `withThread` task context it holds and how it ends. */
export interface OpenedSession {
  /** 128-bit random id (`randomUUID()`), unique for the life of the process. */
  readonly id: string;
  /** Resolves when the session ended, with the reason given to `end`/`dropInstance`/`endAll` (undefined for a caller's end). */
  readonly ended: Promise<ContractError | undefined>;
  /** Ends the session (idempotent): later `get`s answer `unknown_session`. */
  end(): void;
}

export interface ThreadSessions {
  /** Registers `thread` for `owner` and answers the open session. Never throws. */
  open(owner: BundleInstance, thread: ThreadContext): OpenedSession;
  /**
   * The open session `id` of `owner`. Throws `ContractError('unknown_session',
   * 'No Thread session <id>.')` (NOT_FOUND) for an unknown or ended id and for
   * a session another instance (bundle id, generation or incarnation) opened;
   * the answer never reveals which.
   */
  get(id: string, owner: BundleInstance): ThreadContext;
  /** Ends every session `instance` opened (`instances.onGone`); `ended` resolves with no reason. Never throws. */
  dropInstance(instance: BundleInstance): void;
  /** Ends every open session with `reason` (stop, deactivate, drain). Never throws. */
  endAll(reason: ContractError): void;
}

/** One instance: `<bundleId>/<generation>/<incarnation>`. */
export const instanceKey = (instance: BundleInstance): string =>
  `${instance.bundleId}/${String(instance.generation)}/${String(instance.incarnation)}`;

/** A registered session: its owner's key, its Thread and how to end it. */
interface HeldSession {
  readonly owner: string;
  readonly thread: ThreadContext;
  readonly end: (reason?: ContractError) => void;
}

/** An empty registry. No I/O. */
export const createThreadSessions = (): ThreadSessions => {
  const sessions = new Map<string, HeldSession>();
  const endWhere = (
    matches: (held: HeldSession) => boolean,
    reason?: ContractError,
  ) => {
    for (const held of [...sessions.values()])
      if (matches(held)) held.end(reason);
  };
  return {
    open: (owner, thread) => {
      const id = randomUUID();
      let resolve!: (reason: ContractError | undefined) => void;
      const ended = new Promise<ContractError | undefined>((done) => {
        resolve = done;
      });
      const end = (reason?: ContractError) => {
        if (sessions.get(id)?.end !== end) return;
        sessions.delete(id);
        resolve(reason);
      };
      sessions.set(id, { owner: instanceKey(owner), thread, end });
      return { id, ended, end: () => end() };
    },
    get: (id, owner) => {
      const held = sessions.get(id);
      if (held === undefined || held.owner !== instanceKey(owner))
        throw new ContractError('unknown_session', `No Thread session ${id}.`);
      return held.thread;
    },
    dropInstance: (instance) => {
      const owner = instanceKey(instance);
      endWhere((held) => held.owner === owner);
    },
    endAll: (reason) => endWhere(() => true, reason),
  };
};

/** The instance a call `context` serves came from: `stampedCallerOf(context)` without `version`. */
export const callerInstanceOf = (context: HandlerContext): BundleInstance => {
  const { bundleId, generation, incarnation } = stampedCallerOf(context);
  return { bundleId, generation, incarnation };
};
