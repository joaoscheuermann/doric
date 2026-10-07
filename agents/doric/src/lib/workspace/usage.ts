import { isRecord } from 'tool';

/** Unified usage snapshots. Costs are account charges, never upstream costs. */
export interface UsageTotals {
  readonly calls: number;
  readonly unpricedCalls: number;
  readonly cost: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningTokens: number;
}

export interface ContextUsage {
  readonly model: string;
  readonly providerId?: string;
  readonly contextWindowSource?: 'catalog';
  readonly contextWindow?: number;
  readonly inputTokens?: number;
}

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

export interface ThreadUsage {
  readonly context?: ContextUsage;
  readonly total: UsageTotals;
  readonly threads: readonly (UsageTotals & {
    readonly threadId: string;
    readonly name: string;
    readonly parentThreadId?: string;
  })[];
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
    if (event.provider !== 'unified' || typeof event.model !== 'string')
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
