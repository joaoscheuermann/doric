import type {
  HistoryPatch,
  HistoryReader,
  PromptJob,
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
  /** Reads one attachment of the Thread's Project; absent, it reads none. */
  readonly attachment?: PromptSession['attachment'];
  /** The prompt's steering; a session without it offers the executor none. */
  readonly steering?: {
    /** Hands the waiting steers to the executor, oldest first. */
    readonly take: () => readonly PromptJob[];
    /** The oldest steer the executor took, now recorded as taken in. */
    readonly applied: () => PromptJob | undefined;
  };
}): RunSession => {
  const { threadId, promptId, store, publish, steering } = context;
  let failure: ThreadPersistenceError | undefined;
  let latest: HistoryPatch | undefined;
  let pending:
    | { readonly promptId: string; readonly event: unknown }
    | undefined;
  const append = async () => {
    if (pending === undefined) return;
    const stored = await store.appendEvent(
      threadId,
      pending.promptId,
      pending.event,
    );
    pending = undefined;
    publish(stored);
  };
  /**
   * The event one executor event is logged as. A steer the executor took in is
   * closed under its own id with `prompt.steered`, which names the prompt it
   * steered, so replay and boot never run it again as a prompt of its own.
   */
  const logged = (
    event: unknown,
  ): { readonly promptId: string; readonly event: unknown } => {
    if ((event as { type?: unknown } | null)?.type !== 'agent.steered')
      return { promptId, event };
    const steer = steering?.applied();
    return steer === undefined
      ? { promptId, event }
      : {
          promptId: steer.id,
          event: {
            type: 'prompt.steered',
            promptId,
            text: steer.prompt,
            source: steer.source,
          },
        };
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
        if (entry.event !== undefined) {
          const value = logged(entry.event);
          pending = {
            promptId: value.promptId,
            event: eventJson(value.event, redactions),
          };
        }
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
    ...(context.attachment === undefined
      ? {}
      : { attachment: context.attachment }),
    ...(steering === undefined
      ? {}
      : {
          steers: async () =>
            steering.take().map(({ prompt, source }) => ({ prompt, source })),
        }),
  };
};
