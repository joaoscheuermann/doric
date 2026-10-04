export type ReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export interface GithubConfig {
  readonly repo: {
    readonly url: string;
    readonly branch?: string;
  };
  readonly token: string;
}

export interface ProviderConfig {
  readonly id: string;
  readonly type: string;
  readonly token?: string;
  readonly baseUrl?: string;
}

export interface ModelConfig {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly effort?: ReasoningEffort;
  readonly reasoning?: ReasoningEffort;
  readonly internal_key?: string;
}

export interface TaskConfig {
  readonly id: string;
  readonly model: string;
}

export interface AgentConfig {
  readonly github: GithubConfig;
  readonly providers: readonly ProviderConfig[];
  readonly models: readonly ModelConfig[];
  readonly tasks: readonly TaskConfig[];
}
