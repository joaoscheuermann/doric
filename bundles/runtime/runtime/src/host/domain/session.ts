import type {
  HistoryPatch,
  HistoryReader,
  PromptSession,
} from '../../contracts/executor.js';
import type { ThreadEvent } from '../../contracts/model.js';
import type { ThreadStore } from '../store/types.js';
import type { Redactor } from './redactor.js';
import { ThreadPersistenceError } from './runtime.js';
import { eventJson } from './serialization.js';

/*
 * The PromptSession the runtime hands the executor for one run (design 57
 * §4.5). Every history and event write of the run goes through it, so the
 * runtime keeps today's order — history first, then the event, then its
 * publication — the redaction of both, and the retry a storage pause replays
 * (agents/doric direct/executor.ts:117-131, moved here).
 */

export interface RunSession extends PromptSession {
  /** The persistence failure the run ended on, with its retry. */
  readonly failure: ThreadPersistenceError | undefined;
}

export const createSession = (context: {
  readonly threadId: string;
  readonly promptId: string;
  readonly reader: HistoryReader;
  readonly store: ThreadStore;
  readonly redactor: Redactor;
  readonly publish: (event: ThreadEvent) => void;
}): RunSession => {
  const { threadId, promptId, store, publish } = context;
  let failure: ThreadPersistenceError | undefined;
  let latest: HistoryPatch | undefined;
  let pending: { readonly event: unknown } | undefined;
  const append = async () => {
    if (pending === undefined) return;
    const stored = await store.appendEvent(threadId, promptId, pending.event);
    pending = undefined;
    publish(stored);
  };
  /** Saves the latest history again, then the event still owed, once. */
  const retry = async () => {
    if (latest !== undefined) await store.saveHistory(threadId, latest);
    await append();
  };
  const fail = (cause: unknown): never => {
    failure = new ThreadPersistenceError(cause, retry);
    throw failure;
  };
  const history: HistoryReader = {
    get format() {
      return context.reader.format;
    },
    read: async (part) => {
      try {
        return await context.reader.read(part);
      } catch (cause) {
        throw new ThreadPersistenceError(cause);
      }
    },
  };

  return {
    history,
    get failure() {
      return failure;
    },
    record: async (entry) => {
      try {
        const redactions = await context.redactor.current();
        if (entry.event !== undefined)
          pending = { event: eventJson(entry.event, redactions) };
        if (entry.history !== undefined) {
          latest = {
            format: entry.history.format,
            parts: Object.fromEntries(
              Object.entries(entry.history.parts).map(([part, value]) => [
                part,
                eventJson(value, redactions),
              ]),
            ),
          };
          await store.saveHistory(threadId, latest);
        }
        if (entry.event !== undefined) await append();
      } catch (cause) {
        fail(cause);
      }
    },
  };
};
