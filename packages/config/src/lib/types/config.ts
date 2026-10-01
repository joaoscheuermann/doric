export type ReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export type GithubConfig = {
  readonly repo: {
    readonly url: string;
    readonly branch?: string;
  };
  readonly token: string;
};

export type ProviderConfig = {
  readonly id: string;
  readonly type: string;
  readonly token?: string;
  readonly baseUrl?: string;
};

export type ModelConfig = {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly effort?: ReasoningEffort;
  readonly reasoning?: ReasoningEffort;
  readonly internal_key?: string;
};

export type TaskConfig = {
  readonly id: string;
  readonly model: string;
};

export type AgentConfig = {
  readonly github: GithubConfig;
  readonly providers: readonly ProviderConfig[];
  readonly models: readonly ModelConfig[];
  readonly tasks: readonly TaskConfig[];
};
