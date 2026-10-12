import type {
  ContextUsage,
  ThreadUsage,
  UsageTotals,
} from '../../contracts/model.js';

/*
 * The Thread usage aggregate, ported from agents/doric/src/lib/workspace
 * (usage.ts and usage-store.ts). The store folds it in the same commit as
 * the event that changes it; a Thread whose `usage` is null (one migrated
 * from before the aggregate) derives it once from its events.
 */

interface CallUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cost?: number;
}

/** Completed charges plus one replaceable snapshot for the current call. */
export interface UsageState {
  readonly completed: UsageTotals;
  readonly current?: CallUsage;
  readonly context?: ContextUsage;
}

export const emptyTotals: UsageTotals = {
  calls: 0,
  unpricedCalls: 0,
  cost: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
};
export const emptyUsage: UsageState = { completed: emptyTotals };

/** The event types the aggregate reads. */
export const usageEventTypes: readonly string[] = [
  'response.started',
  'usage',
  'response.finished',
];

export const addTotals = (a: UsageTotals, b: UsageTotals): UsageTotals => ({
  calls: a.calls + b.calls,
  unpricedCalls: a.unpricedCalls + b.unpricedCalls,
  cost: a.cost + b.cost,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  reasoningTokens: a.reasoningTokens + b.reasoningTokens,
});

export const usageTotals = (state: UsageState): UsageTotals =>
  state.current === undefined
    ? state.completed
    : addTotals(state.completed, {
        calls: 1,
        unpricedCalls: state.current.cost === undefined ? 1 : 0,
        cost: state.current.cost ?? 0,
        inputTokens: state.current.inputTokens ?? 0,
        outputTokens: state.current.outputTokens ?? 0,
        cachedInputTokens: state.current.cachedInputTokens ?? 0,
        reasoningTokens: state.current.reasoningTokens ?? 0,
      });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const record = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

/** Repeated usage/finish snapshots replace one call rather than charging twice. */
export const projectUsage = (state: UsageState, value: unknown): UsageState => {
  const event = record(value);
  if (event.type === 'response.started') {
    const completed = usageTotals(state);
    if (
      (event.provider !== 'openrouter' && event.provider !== 'unified') ||
      typeof event.model !== 'string'
    )
      return { completed };
    const contextWindow = count(event.contextWindow);
    const providerId =
      typeof event.providerId === 'string' ? event.providerId : undefined;
    return {
      completed,
      current: {},
      context: {
        ...(state.context?.model === event.model &&
        state.context.providerId === providerId
          ? state.context
          : {}),
        model: event.model,
        ...(providerId === undefined ? {} : { providerId }),
        ...(contextWindow === undefined || contextWindow === 0
          ? {}
          : { contextWindow }),
      },
    };
  }
  if (
    state.current === undefined ||
    (event.type !== 'usage' && event.type !== 'response.finished')
  )
    return state;
  const source = record(
    event.type === 'usage' ? event.usage : record(event.finish).usage,
  );
  const cost = record(source.cost);
  const amount = cost.unit === 'credits' ? count(cost.amount) : undefined;
  const current: CallUsage = {
    ...state.current,
    ...Object.fromEntries(
      [
        'inputTokens',
        'outputTokens',
        'cachedInputTokens',
        'reasoningTokens',
      ].flatMap((key) =>
        count(source[key]) === undefined ? [] : [[key, count(source[key])]],
      ),
    ),
    ...(amount === undefined ? {} : { cost: amount }),
  };
  return {
    ...state,
    current,
    ...(state.context === undefined
      ? {}
      : {
          context: {
            ...state.context,
            ...(current.inputTokens === undefined
              ? {}
              : { inputTokens: current.inputTokens }),
          },
        }),
  };
};

/** The aggregate folded over a Thread's events, in sequence order. */
export const foldUsage = (
  events: readonly { readonly type: string; readonly event: unknown }[],
): UsageState =>
  events
    .filter(({ type }) => usageEventTypes.includes(type))
    .reduce((state, entry) => projectUsage(state, entry.event), emptyUsage);

/** A rewind changes context, but never refunds calls that have already run. */
export const rewoundUsage = (
  previous: UsageState,
  retained: UsageState,
): UsageState => ({
  completed: usageTotals(previous),
  ...(retained.context === undefined ? {} : { context: retained.context }),
});

/** One Thread of a subtree, with its usage state already read. */
export interface SubtreeUsage {
  readonly threadId: string;
  readonly name: string;
  readonly parentThreadId: string | null;
  readonly state: UsageState;
}

/** Totals over a Thread (first) and its descendants. */
export const threadUsage = (rows: readonly SubtreeUsage[]): ThreadUsage => {
  const context = rows[0]?.state.context;
  const threads = rows.map((row) => ({
    threadId: row.threadId,
    name: row.name,
    ...(row.parentThreadId === null
      ? {}
      : { parentThreadId: row.parentThreadId }),
    ...usageTotals(row.state),
  }));
  return {
    ...(context === undefined ? {} : { context }),
    total: threads.reduce(addTotals, emptyTotals),
    threads,
  };
};
