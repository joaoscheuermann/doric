import type { Call, Services } from 'bundle/contracts';
import { ModelsV1 } from 'bundle/contracts';
import {
  ConfigurationV1,
  type ConfigurationValue,
} from 'host-config/contracts';
import type { LlmProvider } from 'llms';
import type { MessageStorage } from 'messages';
import type {
  ExecutorCompactionResult,
  PromptSession,
} from 'runtime/contracts';

import {
  applyCompaction,
  newSummaryId,
  planCompaction,
} from './compaction/compact.js';
import { CompactionError } from './compaction/errors.js';
import { projection } from './compaction/project.js';
import { createSummarizer } from './compaction/summarize.js';
import { readMessages, readMeta, saved } from './history.js';

/*
 * The executor's compaction participation: the seam's on-demand `compact`
 * for an idle Thread, plus the automatic trigger the prompt run drives
 * between provider turns. Every write goes through the caller's session —
 * the bracket is recorded here, in the same order every other
 * history-and-event write of this executor uses.
 */

/** The configuration section, with the defaults a missing field implies. */
export interface CompactionConfig {
  readonly enabled: boolean;
  readonly pressurePercent: number;
  readonly tailMinMessages: number;
  readonly summaryMaxChars: number;
  readonly charBudget: number;
}

export const compactionDefaults: CompactionConfig = {
  enabled: true,
  pressurePercent: 80,
  tailMinMessages: 6,
  summaryMaxChars: 6000,
  charBudget: 200_000,
};

/** The compaction section of the configuration in force, defaults filled. */
export const compactionConfig = (
  configuration: ConfigurationValue,
): CompactionConfig => {
  const value = (
    configuration.execution as {
      readonly contextCompaction?: Partial<CompactionConfig>;
    }
  ).contextCompaction;
  return value === undefined
    ? compactionDefaults
    : { ...compactionDefaults, ...value };
};

/**
 * The summarizer over one language model. It streams like every other
 * generation this executor makes — the contract's backend rule — so the
 * abort signal reaches the in-flight call and tears it down.
 */
export const executionSummarizer = (options: {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly summaryMaxChars: number;
}) =>
  createSummarizer({
    summaryMaxChars: options.summaryMaxChars,
    complete: async (input, signal) => {
      let text = '';
      for await (const event of options.provider.stream({
        model: options.model,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.transcript },
        ],
        ...(signal === undefined ? {} : { signal }),
      })) {
        if (event.type === 'response.finished') text = event.finish.text;
      }
      return text;
    },
  });

/** The provider call the summarizer makes: the run's own model. */
const summarizerFor = async (
  call: Call,
  services: Services,
  summaryMaxChars: number,
): Promise<ReturnType<typeof executionSummarizer>> => {
  const { configuration } = await services.use(ConfigurationV1).current(call);
  const execution = configuration.models.execution;
  const { languageModel } = await services
    .use(ModelsV1)
    .resolve(
      { providerId: execution.providerId, model: execution.model },
      call,
    );
  return executionSummarizer({
    provider: languageModel as unknown as LlmProvider,
    model: execution.model,
    summaryMaxChars,
  });
};

/**
 * The on-demand compaction of one idle Thread (the seam's `compact`): plans
 * the cut, records the bracket around the summarization, applies the
 * rewrite in one history-and-event commit, and answers in-band — refusals
 * and failures are results, not throws, so the caller maps them as-is.
 */
export const compactThread = async (
  {
    session,
    policy,
  }: {
    readonly session: PromptSession;
    readonly policy: {
      readonly tailMinMessages: number;
      readonly summaryMaxChars: number;
    };
  },
  call: Call,
  services: Services,
): Promise<ExecutorCompactionResult> => {
  const { configuration } = await services.use(ConfigurationV1).current(call);
  if (!compactionConfig(configuration).enabled) {
    return { status: 'refused', reason: 'disabled' };
  }
  const stored = await readMessages(session.history);
  const { checkpoints } = await readMeta(session.history);
  const plan = planCompaction(stored, policy);
  if (plan.status === 'refused') {
    return { status: 'refused', reason: plan.reason };
  }
  const summaryId = newSummaryId();
  await session.record({
    event: { type: 'compaction.started', trigger: 'manual' },
  });
  try {
    const summary = await summarizerFor(
      call,
      services,
      policy.summaryMaxChars,
    ).then((summarizer) =>
      summarizer.summarize(stored.slice(0, plan.end), call.signal),
    );
    const applied = applyCompaction({
      messages: stored,
      meta: { checkpoints, messageCount: stored.length },
      end: plan.end,
      trigger: 'manual',
      summaryId,
      summary,
    });
    await session.record({
      history: saved(
        applied.rewritten.messages,
        applied.rewritten.meta.checkpoints,
      ),
      event: {
        type: 'compaction.finished',
        summaryId: applied.summaryId,
        condensedMessages: applied.condensation.condensedMessages,
        retainedMessages: applied.condensation.retainedMessages,
        tokensFreed: applied.condensation.tokensFreed,
        summaryChars: applied.condensation.summaryChars,
      },
    });
    return {
      status: 'compacted',
      summaryId: applied.summaryId,
      condensedMessages: applied.condensation.condensedMessages,
      retainedMessages: applied.condensation.retainedMessages,
      tokensFreed: applied.condensation.tokensFreed,
    };
  } catch (error) {
    const code =
      error instanceof CompactionError ? error.code : 'summarizer_failed';
    await session.record({ event: { type: 'compaction.failed', code } });
    return { status: 'failed', code };
  }
};

/** What one automatic compaction attempt answered. */
export type AutomaticCompaction =
  | { readonly status: 'skipped' }
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'failed'; readonly code: string }
  | {
      readonly status: 'compacted';
      readonly checkpoints: Readonly<Record<string, number>>;
    };

/**
 * The automatic trigger between provider turns: measures the projection of
 * the next call, condenses when it crosses the pressure line, and applies
 * the rewrite to the run's live storage and to its checkpoint map. A skip
 * or refusal records nothing; a failure records `compaction.failed` and
 * lets the run continue on its uncondensed history.
 */
export const maybeCompactRun = async (options: {
  readonly session: PromptSession;
  readonly messages: MessageStorage;
  /** The run's checkpoint map, replaced when the rewrite re-bases it. */
  readonly checkpoints: Readonly<Record<string, number>>;
  readonly config: CompactionConfig;
  readonly provider: LlmProvider;
  readonly model: string;
  /** The prompt still pending after the finished turn, in characters. */
  readonly promptChars: number;
  readonly lastInputTokens?: number;
  readonly lastOutputTokens?: number;
  readonly contextWindow?: number;
  /** Skip the projection when an overflow already proved the pressure. */
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}): Promise<AutomaticCompaction> => {
  const { config } = options;
  if (!config.enabled) return { status: 'skipped' };
  const current = options.messages.list();
  const measure = projection({
    messages: current,
    promptChars: options.promptChars,
    ...(options.lastInputTokens === undefined
      ? {}
      : { lastInputTokens: options.lastInputTokens }),
    ...(options.lastOutputTokens === undefined
      ? {}
      : { lastOutputTokens: options.lastOutputTokens }),
    ...(options.contextWindow === undefined
      ? {}
      : { contextWindow: options.contextWindow }),
    charBudget: config.charBudget,
    pressurePercent: config.pressurePercent,
  });
  if (!options.force && !measure.underPressure) return { status: 'skipped' };
  const stored = current;
  const plan = planCompaction(stored, config);
  if (plan.status === 'refused')
    return { status: 'refused', reason: plan.reason };
  const summarizer = executionSummarizer({
    provider: options.provider,
    model: options.model,
    summaryMaxChars: config.summaryMaxChars,
  });
  const summaryId = newSummaryId();
  await options.session.record({
    event: { type: 'compaction.started', trigger: 'automatic' },
  });
  try {
    const summary = await summarizer.summarize(
      stored.slice(0, plan.end),
      options.signal,
    );
    const applied = applyCompaction({
      messages: stored,
      meta: { checkpoints: options.checkpoints, messageCount: stored.length },
      end: plan.end,
      trigger: 'automatic',
      summaryId,
      summary,
    });
    await options.session.record({
      history: saved(
        applied.rewritten.messages,
        applied.rewritten.meta.checkpoints,
      ),
      event: {
        type: 'compaction.finished',
        summaryId: applied.summaryId,
        condensedMessages: applied.condensation.condensedMessages,
        retainedMessages: applied.condensation.retainedMessages,
        tokensFreed: applied.condensation.tokensFreed,
        summaryChars: applied.condensation.summaryChars,
      },
    });
    options.messages.replaceRange(0, plan.end, [applied.summaryMessage]);
    return {
      status: 'compacted',
      checkpoints: applied.rewritten.meta.checkpoints,
    };
  } catch (error) {
    const code =
      error instanceof CompactionError ? error.code : 'summarizer_failed';
    await options.session.record({
      event: { type: 'compaction.failed', code },
    });
    return { status: 'failed', code };
  }
};
