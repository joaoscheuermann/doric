import {
  type Call,
  type CallScope,
  defineMethod,
  defineService,
  type ServiceDefinition,
} from 'bundle/contracts';

import {
  type Executor,
  type ExecutorRunInput,
  ExecutorV1,
  executorMethods,
  type HistoryReader,
} from '../../src/contracts/executor.js';

/*
 * A scripted `executor/v1` for the runtime's domain tests (design 57 §13.1:
 * "runner with a scripted fake executor"). Its history follows the shape
 * D-S6-02 gives `direct.history/v1`: a `messages` list and a `meta` part with
 * the per-prompt turn boundaries, so checkpoint and rewind behave as Direct's
 * do without a model.
 */

export const testHistoryFormat = 'test.history/v1';

interface Meta {
  readonly checkpoints: Readonly<Record<string, number>>;
}

const metaOf = async (history: HistoryReader): Promise<Meta> =>
  ((await history.read('meta')) as Meta | undefined) ?? { checkpoints: {} };

export const messagesOf = async (
  history: HistoryReader,
): Promise<readonly unknown[]> =>
  ((await history.read('messages')) as readonly unknown[] | undefined) ?? [];

/** What one scripted run receives. */
export interface ScriptedRun extends ExecutorRunInput {
  readonly scope: Required<Omit<CallScope, 'windowKey'>>;
  readonly signal: AbortSignal | undefined;
  /** Appends messages to the Thread's history through the session. */
  append(...messages: readonly unknown[]): Promise<void>;
}

export type Script = (run: ScriptedRun) => Promise<string>;

export interface ScriptedExecutorOptions {
  /** The formats `formats()` answers; the test format by default. */
  readonly formats?: readonly string[];
}

/** One `executor/v1` per prompt scope, running `script` for every prompt. */
export const scriptedExecutor =
  (script: Script, options: ScriptedExecutorOptions = {}) =>
  (scope: Required<Omit<CallScope, 'windowKey'>>): Executor => ({
    run: async (input, call) => {
      let messages: readonly unknown[] | undefined;
      const text = await script({
        ...input,
        scope,
        signal:
          call !== undefined && 'signal' in call ? call.signal : undefined,
        append: async (...added) => {
          messages = [
            ...(messages ?? (await messagesOf(input.session.history))),
            ...added,
          ];
          await input.session.record({
            history: { format: testHistoryFormat, parts: { messages } },
          });
        },
      });
      return { text };
    },
    checkpoint: async ({ history, promptId }) => {
      const meta = await metaOf(history);
      // A turn records its boundary once: a resumed turn keeps the one it had.
      if (meta.checkpoints[promptId] !== undefined)
        return { format: testHistoryFormat, parts: { meta } };
      return {
        format: testHistoryFormat,
        parts: {
          meta: {
            checkpoints: {
              ...meta.checkpoints,
              [promptId]: (await messagesOf(history)).length,
            },
          },
        },
      };
    },
    // The scripted executor does not condense: an on-demand compaction of a
    // Thread it owns reads as a refusal with nothing to condense.
    compact: async () => ({ status: 'refused', reason: 'nothing_to_compact' }),
    rewind: async ({ history, promptId, removedPromptIds }) => {
      const meta = await metaOf(history);
      const boundary = meta.checkpoints[promptId];
      if (boundary === undefined) return undefined;
      const removed = new Set(removedPromptIds);
      return {
        format: testHistoryFormat,
        parts: {
          messages: (await messagesOf(history)).slice(0, boundary),
          meta: {
            checkpoints: Object.fromEntries(
              Object.entries(meta.checkpoints).filter(
                ([id]) => !removed.has(id),
              ),
            ),
          },
        },
      };
    },
    formats: () => options.formats ?? [testHistoryFormat],
  });

type PromptScope = Required<Omit<CallScope, 'windowKey'>>;

const scopeOf = (call: Call): PromptScope => {
  const { projectId, threadId, promptId } = call.scope ?? {};
  if (
    projectId === undefined ||
    threadId === undefined ||
    promptId === undefined
  )
    throw new Error('executor/v1 needs a prompt scope.');
  return { projectId, threadId, promptId };
};

/** A fake `executor/v1` provider: the scripted executor of the call's scope. */
export const executorProvider = (
  script: Script,
  options: ScriptedExecutorOptions = {},
): ServiceDefinition => {
  const executor = scriptedExecutor(script, options);
  return defineService(ExecutorV1.id, {
    run: defineMethod({
      ...executorMethods.run,
      execute: (input, call) =>
        executor(scopeOf(call))
          .run(input, { signal: call.signal })
          .then(({ text }) => ({ text })),
    }),
    checkpoint: defineMethod({
      ...executorMethods.checkpoint,
      execute: (input, call) => executor(scopeOf(call)).checkpoint(input),
    }),
    rewind: defineMethod({
      ...executorMethods.rewind,
      execute: (input, call) => executor(scopeOf(call)).rewind(input),
    }),
    formats: defineMethod({
      ...executorMethods.formats,
      execute: () => [...(options.formats ?? [testHistoryFormat])],
    }),
  });
};
