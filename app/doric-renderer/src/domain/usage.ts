/** Account charges reported by OpenRouter, aggregated by the host. */
export type UsageTotals = {
  readonly calls: number;
  readonly unpricedCalls: number;
  readonly cost: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningTokens: number;
};
export type ThreadUsage = {
  readonly context?: {
    readonly model: string;
    readonly providerId?: string;
    readonly contextWindowSource?: 'catalog';
    readonly contextWindow?: number;
    readonly inputTokens?: number;
  };
  readonly total: UsageTotals;
  readonly threads: readonly (UsageTotals & {
    readonly threadId: string;
    readonly name: string;
    readonly parentThreadId?: string;
  })[];
};

const tokens = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
export const contextLabel = (context: ThreadUsage['context']): string => {
  const input = context?.inputTokens;
  const window = context?.contextWindow;
  if (input === undefined)
    return window === undefined ? '—' : `— / ${tokens.format(window)}`;
  if (window === undefined) return `${tokens.format(input)} / ?`;
  return `${tokens.format(input)} / ${tokens.format(window)} · ${Math.round((input / window) * 100)}%`;
};

/** Positive sub-cent charges must not look free. Missing prices are not zero. */
export const costLabel = (total: UsageTotals): string => {
  if (total.calls === 0 || total.unpricedCalls === total.calls) return '—';
  if (total.cost > 0 && total.cost < 0.01) return '~<$0.01';
  return `~$${total.cost.toFixed(2)}`;
};
