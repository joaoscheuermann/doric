/** OpenRouter unified charges for a Thread and all its descendants. */
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
