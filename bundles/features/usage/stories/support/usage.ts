// Usage as `usage/v1` answers it: a checkout refactor Thread on Claude
// Sonnet 4.5 over OpenRouter, which delegated test and docs work to child
// Threads (one of them delegating again), and the window services the
// footer reads.

import type { Services } from 'bundle/contracts';

import type {
  CompactResult,
  ContextUsage,
  ThreadUsage,
  Usage,
  UsageTotals,
} from '../../src/contracts/index.js';
import { fakeServices } from './services.js';

export const threadId = 'thr_checkout_refactor';

type ThreadEntry = ThreadUsage['threads'][number];

const entry = (
  id: string,
  name: string,
  totals: Partial<UsageTotals>,
  parentThreadId?: string,
): ThreadEntry => ({
  threadId: id,
  name,
  ...(parentThreadId === undefined ? {} : { parentThreadId }),
  calls: 0,
  unpricedCalls: 0,
  cost: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  ...totals,
});

export const currentThread = entry(threadId, 'Refactor checkout flow', {
  calls: 18,
  cost: 1.2384,
  inputTokens: 412_800,
  outputTokens: 38_450,
  cachedInputTokens: 296_000,
  reasoningTokens: 9_200,
});

export const subthreads: readonly ThreadEntry[] = [
  entry(
    'thr_payment_tests',
    'Audit payment tests',
    {
      calls: 7,
      cost: 0.4127,
      inputTokens: 136_200,
      outputTokens: 11_900,
      cachedInputTokens: 88_400,
      reasoningTokens: 2_100,
    },
    threadId,
  ),
  entry(
    'thr_webhook_docs',
    'Update Stripe webhook docs',
    {
      calls: 3,
      cost: 0.0946,
      inputTokens: 31_700,
      outputTokens: 4_820,
      cachedInputTokens: 12_000,
    },
    threadId,
  ),
  entry(
    'thr_lint_checkout',
    'Fix lint in src/checkout',
    { calls: 2, cost: 0.0081, inputTokens: 9_400, outputTokens: 610 },
    'thr_payment_tests',
  ),
];

export const sonnetContext: ContextUsage = {
  model: 'anthropic/claude-sonnet-4.5',
  providerId: 'openrouter',
  contextWindowSource: 'catalog',
  contextWindow: 200_000,
  inputTokens: 64_300,
};

const sum = (threads: readonly ThreadEntry[]): UsageTotals =>
  threads.reduce<UsageTotals>(
    (total, next) => ({
      calls: total.calls + next.calls,
      unpricedCalls: total.unpricedCalls + next.unpricedCalls,
      cost: total.cost + next.cost,
      inputTokens: total.inputTokens + next.inputTokens,
      outputTokens: total.outputTokens + next.outputTokens,
      cachedInputTokens: total.cachedInputTokens + next.cachedInputTokens,
      reasoningTokens: total.reasoningTokens + next.reasoningTokens,
    }),
    {
      calls: 0,
      unpricedCalls: 0,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    },
  );

/** A Thread's usage whose total is its entries' sum, as the host adds it. */
export const threadUsage = (
  input: {
    readonly threads?: readonly ThreadEntry[];
    readonly context?: ContextUsage | null;
  } = {},
): ThreadUsage => {
  const threads = input.threads ?? [currentThread, ...subthreads];
  return {
    ...(input.context === null
      ? {}
      : { context: input.context ?? sonnetContext }),
    total: sum(threads),
    threads,
  };
};

/** The same Thread before its first measured call. */
export const emptyUsage = (): ThreadUsage =>
  threadUsage({
    threads: [],
    context: { ...sonnetContext, inputTokens: undefined },
  });

/** Child Threads whose provider reported no price for some calls. */
export const partiallyPricedUsage = (): ThreadUsage =>
  threadUsage({
    threads: [
      currentThread,
      { ...subthreads[0], calls: 9, unpricedCalls: 2 },
      subthreads[1],
    ],
  });

const compacted: CompactResult = {
  status: 'compacted',
  condensedMessages: 24,
  retainedMessages: 6,
  tokensFreed: 31_200,
};

/**
 * `usage/v1` over fixtures. Compaction answers after a short, finite delay
 * so the button shows its "Compacting…" state.
 */
export const fixtureUsage = (
  input: {
    readonly usage?: () => ThreadUsage;
    readonly thread?: () => Promise<ThreadUsage | undefined>;
    readonly compactionTarget?: () => Promise<{
      readonly pressurePercent: number;
    }>;
    readonly compact?: CompactResult;
  } = {},
): Usage => ({
  thread: () =>
    input.thread?.() ?? Promise.resolve((input.usage ?? threadUsage)()),
  compact: () =>
    new Promise((resolve) =>
      window.setTimeout(() => resolve(input.compact ?? compacted), 800),
    ),
  compactionTarget: () =>
    input.compactionTarget?.() ?? Promise.resolve({ pressurePercent: 80 }),
  setCompactionTarget: (target) => Promise.resolve(target),
});

/** The layout's selection, fixed on one Thread (or none). */
export const fixtureWorkspace = (selected: string | undefined = threadId) => ({
  selectedThread: () => (selected === undefined ? undefined : { id: selected }),
  subscribe: () => ({ dispose: () => undefined }),
});

export const summaryServices = (
  input: {
    readonly usage?: Usage | null;
    readonly selected?: string | null;
  } = {},
): Services =>
  fakeServices({
    ...(input.usage === null
      ? {}
      : { 'usage/v1': input.usage ?? fixtureUsage() }),
    'layout.workspace/v1': fixtureWorkspace(
      input.selected === null ? undefined : (input.selected ?? threadId),
    ),
  });
